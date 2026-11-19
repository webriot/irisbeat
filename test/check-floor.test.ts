// SPDX-License-Identifier: AGPL-3.0-only
import worker, { type Status } from '../src/index';
import { setupNetwork } from '@msw/cloudflare';
import { http, HttpResponse } from 'msw';
import { env, exports } from 'cloudflare:workers';
import { createScheduledController, evictDurableObject, reset } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

const start = Date.UTC(2026, 10, 16);
const network = setupNetwork();
beforeAll(() => network.enable());
afterAll(() => network.disable());
afterEach(async () => {
  await floor();
  vi.restoreAllMocks();
  network.resetHandlers();
  await reset();
});

function request(path: string, method = 'GET', body?: unknown) {
  return exports.default.fetch('https://irisbeat.example' + path, {
    method, headers: { authorization: 'Bearer test-installation-secret', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const collection = '/api/operator/monitors';
const target = { name: 'Website', url: 'https://target.example/health' };
const create = (settings = {}) => request(collection, 'POST', { ...target, ...settings });
const read = async (): Promise<Status> => (await request('/api/operator')).json();
const floor = (seconds?: string) => request('/__test-check-floor' + (seconds === undefined ? '' : '?seconds=' + encodeURIComponent(seconds)), 'PUT');
const tick = (minutes: number) => worker.scheduled(createScheduledController({ scheduledTime: start + minutes * 60_000 }), env);

it('rejects invalid installation settings at both Worker entry points', async () => {
  const url = 'https://irisbeat.example/api/status';
  const clock = createScheduledController({ scheduledTime: start });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const invalid of ['59', '86401', '60.5', '', '1e3', 60.5]) {
    const invalidEnv = { ...env, MIN_CHECK_INTERVAL_SECONDS: invalid };
    expect((await worker.fetch(new Request(url), invalidEnv)).status).toBe(500);
    await expect(worker.scheduled(clock, invalidEnv)).rejects.toThrow('MIN_CHECK_INTERVAL_SECONDS');
  }
  expect(log).toHaveBeenCalledWith(expect.stringContaining('invalid_configuration'));
  expect((await worker.fetch(new Request(url), { ...env, MIN_CHECK_INTERVAL_SECONDS: 60 })).status).toBe(200);
});

it('rejects explicit outbound Intervals below the floor and defaults new Monitors to the floor', async () => {
  await floor('180');
  expect((await create({ intervalSeconds: 179 })).status).toBe(400);
  expect((await request(collection, 'POST', { name: 'Database', kind: 'tcp', hostname: 'db.example', port: 5432, intervalSeconds: 60 })).status).toBe(400);
  expect((await create()).status).toBe(201);
  const { monitor } = await read();
  expect(monitor).toMatchObject({ intervalSeconds: 180, effectiveIntervalSeconds: 180 });
  expect((await request(collection + '/' + monitor!.id, 'PATCH', { name: 'Unsaved', intervalSeconds: 120 })).status).toBe(400);
  expect((await read()).monitor).toMatchObject({ name: target.name, intervalSeconds: 180 });
  expect((await request('/api/operator', 'PUT', { ...target, pageName: 'Unsaved', intervalSeconds: 120 })).status).toBe(400);
  expect((await request(collection, 'POST', { name: 'Producer', kind: 'heartbeat', intervalSeconds: 60 })).status).toBe(201);
});

it('enforces a changed Interval floor from the last dispatch and restores the saved interval after eviction', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  network.use(http.get(target.url, () => new HttpResponse(null, { status: 204 })));
  expect((await create({ intervalSeconds: 60 })).status).toBe(201);
  await tick(0);
  const observed = (await read()).monitor!.lastResult;
  expect(observed).toEqual({ at: start, outcome: 'success' });

  await floor('180');
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(1);
  await tick(2);
  const raised = await read();
  expect(raised.monitor).toMatchObject({ intervalSeconds: 60, effectiveIntervalSeconds: 180, lastResult: observed });
  expect(raised.incidents).toEqual([]);
  await tick(3);
  expect((await read()).monitor!.lastResult).toEqual({ at: start + 180_000, outcome: 'success' });

  await floor();
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(4);
  expect((await read()).monitor).toMatchObject({ intervalSeconds: 60, effectiveIntervalSeconds: 60, lastResult: { at: start + 240_000, outcome: 'success' } });
});

it('rejects Calendar gaps shortened by timezone transitions and accepts gaps equal to the floor', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  await floor('86400');
  const schedule = { scheduleMode: 'calendar', cron: '0 9 * * *' };
  const timezone = 'America/New_York';
  expect((await create({ ...schedule, timezone })).status).toBe(400);
  const preview = await request('/api/operator/schedule-preview', 'POST', { cron: schedule.cron, timezone });
  expect(preview.status).toBe(400);
  expect((await preview.json() as { error: string }).error).toContain('86400');
  expect((await create(schedule)).status).toBe(201);
  const { monitor } = await read();
  expect((await request(collection + '/' + monitor!.id, 'PATCH', { timezone })).status).toBe(400);
  expect((await read()).monitor).toMatchObject({ timezone: 'UTC', scheduleSuspended: false });
  expect((await request('/api/operator/schedule-preview', 'POST', { cron: '* * * * *', graceSeconds: 30 })).status).toBe(200);
});

it('suspends an existing Calendar without adding observations or changing an open Incident', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  network.use(http.get(target.url, () => new HttpResponse(null, { status: 503 })));
  expect((await create({ scheduleMode: 'calendar', cron: '* * * * *', failureThreshold: 1, recoveryThreshold: 1 })).status).toBe(201);
  await tick(1);
  const observed = await read();
  expect(observed.monitor).toMatchObject({ state: 'down', lastResult: { at: start + 60_000, outcome: 'failure' } });
  expect(observed.incidents).toHaveLength(1);

  await floor('180');
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(2);
  await tick(11);
  const suspended = await read();
  expect(suspended.monitor).toMatchObject({ ...observed.monitor, scheduleSuspended: true, scheduleSuspensionFloorSeconds: 180 });
  expect(suspended.incidents).toEqual(observed.incidents);

  const path = collection + '/' + observed.monitor!.id;
  await floor();
  expect((await read()).monitor).toMatchObject({ scheduleSuspended: true, scheduleSuspensionFloorSeconds: 180 });
  await floor('180');
  expect((await request(path, 'PATCH', { published: false })).status).toBe(200);
  expect((await request(path, 'PATCH', { cron: '* * * * *' })).status).toBe(400);
  clock.mockReturnValue(start + 11 * 60_000);
  expect((await request(path, 'PATCH', { cron: '*/3 * * * *' })).status).toBe(200);
  expect((await read()).monitor).toMatchObject({ scheduleSuspended: false, state: 'down', lastResult: observed.monitor!.lastResult });
  network.use(http.get(target.url, () => new HttpResponse(null, { status: 204 })));
  await tick(11);
  expect((await read()).incidents).toEqual(observed.incidents);
  await tick(12);
  expect((await read()).incidents).toEqual([{ ...observed.incidents[0], closedAt: start + 12 * 60_000 }]);
});

it('skips a compatible Calendar occurrence too close to a delayed dispatch', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  await floor('180');
  network.use(http.get(target.url, () => new HttpResponse(null, { status: 204 })));
  expect((await create({ scheduleMode: 'calendar', cron: '*/3 * * * *' })).status).toBe(201);
  await tick(5);
  await tick(6);
  await tick(8);
  expect((await read()).monitor!.lastResult).toEqual({ at: start + 5 * 60_000, outcome: 'success' });
  await tick(9);
  expect((await read()).monitor!.lastResult).toEqual({ at: start + 9 * 60_000, outcome: 'success' });
});

it('evaluates Heartbeat silence and Calendar windows on their own schedules under a raised floor', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await floor('86400');
  for (const schedule of [{ intervalSeconds: 60, silenceSeconds: 60 }, { scheduleMode: 'calendar', cron: '* * * * *', graceSeconds: 30 }]) {
    expect((await request(collection, 'POST', { name: 'Producer', kind: 'heartbeat', ...schedule })).status).toBe(201);
  }
  await tick(1);
  const [watchdog, calendar] = (await read()).monitors;
  expect(watchdog).toHaveProperty('lastResult.outcome', 'failure');
  expect(calendar.lastResult).toBeNull();
  clock.mockReturnValue(start + 60_000);
  expect((await request('/heartbeat/' + calendar.id, 'POST')).status).toBe(204);
  await tick(2);
  expect((await read()).monitors[1]).toMatchObject({ lastSeen: start + 60_000, lastResult: { at: start + 90_000, outcome: 'success' } });
});
