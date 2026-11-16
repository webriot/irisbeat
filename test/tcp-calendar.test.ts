// SPDX-License-Identifier: AGPL-3.0-only
import { connect } from 'cloudflare:sockets';
import worker from '../src/index';
import { exports, env } from 'cloudflare:workers';
import { createScheduledController, evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('cloudflare:sockets', () => ({ connect: vi.fn() }));
const start = Date.UTC(2026, 10, 16);
const request = (path: string, method = 'GET', body?: unknown) => exports.default.fetch('https://irisbeat.example' + path, {
  method, headers: { authorization: 'Bearer test-installation-secret', 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const read = async () => (await request('/api/operator')).json() as Promise<import('../src/index').Status>;
const create = (settings = {}) => request('/api/operator/monitors', 'POST', {
  name: 'Database', kind: 'tcp', hostname: 'db.example', port: 5432,
  scheduleMode: 'calendar', cron: '* * * * *', ...settings,
});
const tick = (at: number) => worker.scheduled(createScheduledController({ scheduledTime: at, cron: '* * * * *' }), env);
const socket = (opened: Promise<SocketInfo>, close: () => Promise<void> = vi.fn(async () => {})) => ({ opened, closed: Promise.resolve(), close }) as Socket;
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

it('persists TCP Calendar, collapses overdue occurrences, and retains identity/history through refusal and recovery', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  expect((await create({ cron: '*/5 * * * *', failureThreshold: 1, recoveryThreshold: 1 })).status).toBe(201);
  const id = (await read()).monitor!.id;
  const close = vi.fn(async () => {});
  vi.mocked(connect).mockImplementation(() => socket(Promise.reject(new Error('refused')), close));
  await tick(start);
  expect(connect).not.toHaveBeenCalled();
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(start + 17 * 60_000);
  await tick(start + 17 * 60_000);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(connect).toHaveBeenCalledWith({ hostname: 'db.example', port: 5432 });
  const down = await read();
  expect(down).toMatchObject({ monitor: { id, scheduleMode: 'calendar', timezone: 'UTC', state: 'down', lastResult: { at: start + 17 * 60_000, outcome: 'failure' } }, incidents: [{ openedAt: start + 17 * 60_000, closedAt: null }] });
  vi.mocked(connect).mockImplementation(() => socket(Promise.resolve({}), close));
  await tick(start + 19 * 60_000);
  expect(connect).toHaveBeenCalledTimes(1);
  await tick(start + 20 * 60_000);
  expect((await read()).incidents[0]).toMatchObject({ id: down.incidents[0].id, closedAt: start + 20 * 60_000 });
  expect((await read()).monitor!.history!.days.at(-1)).toMatchObject({ successes: 1, failures: 1 });
  expect(close).toHaveBeenCalledTimes(2);
  const publicBody = await (await request('/api/status')).text();
  for (const privateValue of ['db.example', '5432', 'cron', 'timezone']) expect(publicBody).not.toContain(privateValue);
  const before = await read();
  for (const patch of [{ cron: '0 0 30 2 *' }, { timezone: 'Invalid/Zone' }, { hostname: 'https://db.example' }, { port: 0 }, { scheduleMode: 'interval', cron: '* * * * *' }]) {
    expect((await request('/api/operator/monitors/' + id, 'PATCH', patch)).status).toBe(400);
    expect(await read()).toEqual(before);
  }
});

it('bounds native Calendar connections by their starting deadline and never waits for socket cleanup', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  expect((await create({ timeoutSeconds: 5, failureThreshold: 1, recoveryThreshold: 1 })).status).toBe(201);
  const path = '/api/operator/monitors/' + (await read()).monitor!.id;
  const deadlines: number[] = [];
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, milliseconds, ...args) => {
    if (milliseconds === 5000 || milliseconds === 1000) { deadlines.push(milliseconds); return realTimeout(callback, 0, ...args); }
    return realTimeout(callback, milliseconds, ...args);
  });
  const close = vi.fn(() => new Promise<void>(() => {}));
  vi.mocked(connect).mockImplementationOnce(() => socket((async () => {
    await request(path, 'PATCH', { timeoutSeconds: 1 });
    return new Promise(() => {});
  })(), close)).mockImplementationOnce(() => socket(new Promise(() => {}), close))
    .mockImplementation(() => socket(Promise.resolve({}), close));
  await tick(start + 60_000);
  await tick(start + 120_000);
  expect(deadlines).toEqual([5000, 1000]);
  expect((await read()).monitor).toMatchObject({ timeoutSeconds: 1, state: 'down', lastResult: { outcome: 'failure' } });
  await tick(start + 180_000);
  expect((await read()).monitor!.state).toBe('up');
  expect(close).toHaveBeenCalledTimes(3);
});

it('uses starting targets and thresholds, retains newer schedules, prevents overlap and discards deletion in flight', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  expect((await create({ failureThreshold: 1 })).status).toBe(201);
  const id = (await read()).monitor!.id;
  const path = '/api/operator/monitors/' + id;
  vi.mocked(connect).mockImplementationOnce(address => {
    expect(address).toEqual({ hostname: 'db.example', port: 5432 });
    return socket((async () => {
      clock.mockReturnValue(start + 61_000);
      expect((await request(path, 'PATCH', { hostname: 'next.example', port: 1234, cron: '*/5 * * * *', failureThreshold: 100 })).status).toBe(200);
      await tick(start + 120_000);
      throw new Error('refused');
    })());
  });
  await tick(start + 60_000);
  await tick(start + 120_000);
  expect(connect).toHaveBeenCalledTimes(1);
  const down = await read();
  expect(down).toMatchObject({ monitor: { id, hostname: 'next.example', port: 1234, cron: '*/5 * * * *', failureThreshold: 100, state: 'down' }, incidents: [{ openedAt: start + 60_000, closedAt: null }] });
  vi.mocked(connect).mockImplementationOnce(address => {
    expect(address).toEqual({ hostname: 'next.example', port: 1234 });
    return socket((async () => { await request(path, 'DELETE'); return {}; })());
  });
  await tick(start + 300_000);
  expect(await read()).toMatchObject({ monitors: [], incidents: [{ id: down.incidents[0].id, closedAt: null }] });
  await tick(start + 600_000);
  expect(connect).toHaveBeenCalledTimes(2);
});

it('resets schedule detection progress without losing late observations or existing identity', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  expect((await create()).status).toBe(201);
  const id = (await read()).monitor!.id;
  const path = '/api/operator/monitors/' + id;
  vi.mocked(connect).mockImplementationOnce(() => socket((async () => {
    clock.mockReturnValue(start + 61_000);
    await request(path, 'PATCH', { cron: '*/5 * * * *' });
    throw new Error('refused');
  })())).mockImplementation(() => socket(Promise.reject(new Error('refused'))));
  await tick(start + 60_000);
  await tick(start + 300_000);
  expect((await read()).incidents).toEqual([]);
  await request(path, 'PATCH', { name: 'Renamed', cron: '*/5 * * * *' });
  await tick(start + 600_000);
  expect(await read()).toMatchObject({ monitor: { id, name: 'Renamed' }, incidents: [{ openedAt: start + 600_000, closedAt: null }] });
  expect((await read()).monitor!.history!.days.at(-1)).toMatchObject({ failures: 3 });
  expect((await request(path, 'PATCH', { scheduleMode: 'interval', intervalSeconds: 300 })).status).toBe(200);
  expect((await read()).monitor).toMatchObject({ id, scheduleMode: 'interval', intervalSeconds: 300 });
});

it('excludes Maintenance, including a window declared and ended in flight, and requires normal recovery', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  expect((await create({ failureThreshold: 1 })).status).toBe(201);
  const path = '/api/operator/monitors/' + (await read()).monitor!.id;
  vi.mocked(connect).mockImplementation(() => socket(Promise.reject(new Error('refused'))));
  await tick(start + 60_000);
  const incident = (await read()).incidents[0];
  clock.mockReturnValue(start + 65_000);
  await request(path + '/maintenance', 'PUT', { endsAt: start + 180_000 });
  vi.mocked(connect).mockImplementation(() => socket(Promise.resolve({})));
  await tick(start + 120_000);
  expect((await read()).incidents[0]).toEqual(incident);
  expect((await read()).monitor!.history!.days.at(-1)).toMatchObject({ successes: 0, failures: 1, maintenance: 1 });
  clock.mockReturnValue(start + 180_000);
  await tick(start + 180_000);
  expect((await read()).incidents[0].closedAt).toBeNull();
  await tick(start + 240_000);
  expect((await read()).incidents[0]).toMatchObject({ id: incident.id, closedAt: start + 240_000 });
  vi.mocked(connect).mockImplementationOnce(() => socket((async () => {
    clock.mockReturnValue(start + 301_000);
    await request(path + '/maintenance', 'PUT', { endsAt: start + 310_000 });
    await request(path + '/maintenance', 'DELETE');
    throw new Error('refused');
  })()));
  await tick(start + 300_000);
  expect((await read()).monitor!.lastResult).toEqual({ at: start + 300_000, outcome: 'maintenance' });
});

it('skips nonexistent and second repeated wall times for native connections', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-03-07T12:00:00Z'));
  expect((await create({ cron: '30 2 * * *', timezone: 'America/New_York' })).status).toBe(201);
  vi.mocked(connect).mockImplementation(() => socket(Promise.resolve({})));
  await tick(Date.parse('2026-03-08T07:30:00Z'));
  expect(connect).not.toHaveBeenCalled();
  await tick(Date.parse('2026-03-09T06:30:00Z'));
  const path = '/api/operator/monitors/' + (await read()).monitor!.id;
  clock.mockReturnValue(Date.parse('2026-11-01T04:00:00Z'));
  await request(path, 'PATCH', { cron: '30 1 * * *' });
  await tick(Date.parse('2026-11-01T05:30:00Z'));
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(Date.parse('2026-11-01T06:30:00Z'));
  expect(connect).toHaveBeenCalledTimes(2);
  await tick(Date.parse('2026-11-02T06:30:00Z'));
  expect(connect).toHaveBeenCalledTimes(3);
});
