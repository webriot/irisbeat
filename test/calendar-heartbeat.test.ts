// SPDX-License-Identifier: AGPL-3.0-only
import { captureNotifications, selectWebhooks } from "./notification-queue";
import { calendar } from '../src/calendar';
import worker, { createHostedWorker } from '../src/index';
import { exports, env } from 'cloudflare:workers';
import { createScheduledController, evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, it, expect, vi } from 'vitest';
const start = Date.UTC(2026, 10, 16);
const request = (path: string, method = 'GET', body?: unknown, token = 'test-installation-secret') => exports.default.fetch('https://irisbeat.example' + path, {
  method, headers: { authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const read = async () => (await request('/api/operator')).json() as Promise<import('../src/index').Status>;
const create = (settings = {}) => request('/api/operator/monitors', 'POST', { name: 'Job', kind: 'heartbeat', scheduleMode: 'calendar', cron: '* * * * *', ...settings });
const tick = (at: number) => worker.scheduled(createScheduledController({ scheduledTime: at, cron: '* * * * *' }), env);
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

it('persists authenticated inclusive-window evidence and finalizes only after the deadline', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  expect((await create()).status).toBe(201);
  const id = (await read()).monitor!.id;
  const receipt = (at: number, token?: string) => { clock.mockReturnValue(at); return request('/heartbeat/' + id, 'POST', 'ignored', token); };
  await receipt(start + 59_999);
  await tick(start + 90_001);
  expect((await read()).incidents).toMatchObject([{ openedAt: start + 90_000, closedAt: null }]);
  expect((await receipt(start + 120_000, 'wrong')).status).toBe(401);
  await receipt(start + 120_000);
  await receipt(start + 149_999);
  await tick(start + 150_000);
  expect((await read()).monitor!.lastResult).toEqual({ at: start + 90_000, outcome: 'failure' });
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(start + 150_001);
  expect((await read()).monitor!.state).toBe('down');
  await receipt(start + 210_000);
  expect((await read()).monitor!.lastSeen).toBe(start + 210_000);
  expect((await read()).monitor!.state).toBe('down');
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(start + 210_001);
  expect((await read()).incidents).toMatchObject([{ openedAt: start + 90_000, closedAt: start + 210_000 }]);
  expect((await read()).monitor!.history!.days.at(-1)).toMatchObject({ successes: 2, failures: 1 });
  await tick(start + 210_001);
  expect((await read()).monitor!.history!.days.at(-1)).toMatchObject({ successes: 2, failures: 1 });
});

it('validates grace atomically against the smallest gap, including an irregular later gap', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  await create();
  const before = await read();
  const path = '/api/operator/monitors/' + before.monitor!.id;
  for (const graceSeconds of [0, 86401, null, '30', 1.5, 60]) {
    expect((await request(path, 'PATCH', { name: 'Invalid', graceSeconds })).status).toBe(400);
    expect(await read()).toEqual(before);
  }
  expect((await request(path, 'PATCH', { cron: '0,1 9 * * *', graceSeconds: 60 })).status).toBe(400);
  expect((await request(path, 'PATCH', { cron: '0 9 * * *', graceSeconds: 86400 })).status).toBe(400);
  expect((await request(path, 'PATCH', { cron: '0 9 * * *', graceSeconds: 86399 })).status).toBe(200);
  expect((await request(path, 'PATCH', { graceSeconds: 1 })).status).toBe(200);
  expect((await request(path, 'PATCH', { scheduleMode: 'interval', graceSeconds: 30 })).status).toBe(400);
});

it('processes missed windows in order across restarts and keeps later receipts and alerts', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await create();
  const id = (await read()).monitor!.id;
  const notifications = await captureNotifications();
  await request('/api/operator/webhook', 'PUT', { url: 'https://alerts.example/hook' });
  await selectWebhooks(request);
  for (const minute of [299, 300]) {
    clock.mockReturnValue(start + minute * 60_000);
    await request('/heartbeat/' + id, 'POST');
    await request('/heartbeat/' + id, 'POST');
  }
  const now = start + 300 * 60_000 + 30_001;
  clock.mockReturnValue(now);
  await tick(now);
  const first = await read();
  expect(first.monitor!.history!.days.at(-1)).toMatchObject({ successes: 0, failures: 128 });
  expect(first.incidents).toMatchObject([{ openedAt: start + 90_000, closedAt: null }]);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(now);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(now);
  const final = await read();
  expect(final.monitor!.history!.days.at(-1)).toMatchObject({ successes: 2, failures: 298 });
  expect(final.incidents).toMatchObject([{ openedAt: start + 90_000, closedAt: now - 1 }]);
  await tick(now);
  expect(await read()).toEqual(final);
  expect((await notifications.summaries())).toEqual(['Job: Incident opened', 'Job: Incident recovered']);
});

it('uses old missed deadlines for detection without inserting observations outside 90 UTC days', async () => {
  const day = 86_400_000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await create({ cron: '0 0 * * *' });
  const now = start + 200 * day + 30_001;
  clock.mockReturnValue(now);
  await tick(now);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(now);
  const state = await read();
  expect(state.incidents).toMatchObject([{ openedAt: start + day + 30_000, closedAt: null }]);
  expect(state.monitor!.history!.days).toHaveLength(90);
  expect(state.monitor!.history!.days.reduce((n, day) => n + day.failures, 0)).toBe(90);
  // Rewinding the query horizon reveals whether old observations were improperly inserted.
  clock.mockReturnValue(start + 10 * day);
  expect((await read()).monitor!.history!.days.reduce((n, day) => n + day.failures, 0)).toBe(0);
});

it('retains actual Maintenance overlap after an early receipt, replacement, early end and object recreation', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await create();
  const id = (await read()).monitor!.id;
  const path = '/api/operator/monitors/' + id;
  clock.mockReturnValue(start + 60_000);
  await request('/heartbeat/' + id, 'POST');
  clock.mockReturnValue(start + 70_000);
  await request(path + '/maintenance', 'PUT', { endsAt: start + 300_000 });
  clock.mockReturnValue(start + 75_000);
  await request(path + '/maintenance', 'PUT', { endsAt: start + 80_000 });
  clock.mockReturnValue(start + 76_000);
  await request(path + '/maintenance', 'DELETE');
  await evictDurableObject(env.MONITORING.getByName('personal'));
  clock.mockReturnValue(start + 150_001);
  await tick(start + 150_001);
  expect((await read()).monitor!.history!.days.at(-1)).toMatchObject({ maintenance: 1, successes: 0, failures: 1 });
  expect((await read()).incidents).toMatchObject([{ openedAt: start + 150_000, closedAt: null }]);
});

it('isolates replaced schedules and grace windows, retains history and identity, and discards deleted pending evidence', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await create();
  const id = (await read()).monitor!.id;
  const path = '/api/operator/monitors/' + id;
  await tick(start + 90_001);
  clock.mockReturnValue(start + 120_000);
  await request('/heartbeat/' + id, 'POST');
  clock.mockReturnValue(start + 125_000);
  expect((await request(path, 'PATCH', { cron: '*/5 * * * *', published: false })).status).toBe(200);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(start + 210_001);
  expect((await read()).monitor).toMatchObject({ id, state: 'down', lastResult: { at: start + 90_000, outcome: 'failure' } });
  expect((await (await request('/api/status')).json() as import('../src/index').Status).monitors).toEqual([]);
  clock.mockReturnValue(start + 300_000);
  await request('/heartbeat/' + id, 'POST');
  await tick(start + 330_001);
  expect((await read()).monitor!.state).toBe('down');
  clock.mockReturnValue(start + 600_000);
  await request('/heartbeat/' + id, 'POST');
  clock.mockReturnValue(start + 605_000);
  await request(path, 'DELETE');
  expect((await request('/heartbeat/' + id, 'POST')).status).toBe(404);
  await tick(start + 630_001);
  expect((await read()).incidents).toMatchObject([{ monitorId: id, openedAt: start + 90_000, closedAt: null }]);
});

it('late receipts update freshness without satisfying an occurrence or recovering an Incident', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await create({ recoveryThreshold: 1 });
  const id = (await read()).monitor!.id;
  clock.mockReturnValue(start + 90_001);
  await request('/heartbeat/' + id, 'POST');
  await tick(start + 150_001);
  expect((await read()).monitor).toMatchObject({ lastSeen: start + 90_001, state: 'down' });
  expect((await read()).monitor!.history!.days.at(-1)).toMatchObject({ successes: 0, failures: 2 });
  clock.mockReturnValue(start + 180_000);
  await request('/heartbeat/' + id, 'POST');
  await tick(start + 210_001);
  expect((await read()).incidents).toMatchObject([{ openedAt: start + 90_000, closedAt: start + 210_000 }]);
});

it('rejects grace equal to the spring-shortened daily gap and accepts one second less', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T00:00:00Z'));
  expect((await create({ cron: '0 9 * * *', timezone: 'America/New_York', graceSeconds: 82800 })).status).toBe(400);
  expect((await create({ cron: '0 9 * * *', timezone: 'America/New_York', graceSeconds: 82799 })).status).toBe(201);
}, 20_000);

it('skips nonexistent DST windows and accepts only the first repeated wall occurrence', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-03-07T12:00:00Z'));
  await create({ cron: '30 2 * * *', timezone: 'America/New_York' });
  const id = (await read()).monitor!.id;
  await tick(Date.parse('2026-03-08T08:00:00Z'));
  expect((await read()).monitor!.lastResult).toBeNull();
  const receipt = (at: string) => { clock.mockReturnValue(Date.parse(at)); return request('/heartbeat/' + id, 'POST'); };
  await receipt('2026-03-09T06:30:30Z');
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(Date.parse('2026-03-09T06:30:30.001Z'));
  expect((await read()).monitor!.lastResult).toEqual({ at: Date.parse('2026-03-09T06:30:30Z'), outcome: 'success' });
  clock.mockReturnValue(Date.parse('2026-11-01T04:00:00Z'));
  await request('/api/operator/monitors/' + id, 'PATCH', { cron: '30 1 * * *' });
  await receipt('2026-11-01T05:30:00Z');
  await receipt('2026-11-01T06:30:00Z');
  await tick(Date.parse('2026-11-01T06:31:00Z'));
  expect((await read()).monitor!.history!.days.at(-1)).toMatchObject({ successes: 1, failures: 0 });
});


it('skips paused occurrences, resumes at a future window, and preserves unexpired Maintenance', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  let paused = false;
  let policyRevision = 0;
  const hosted = createHostedWorker({
    contractVersion: '1',
    resolve: () => ({ id: 'calendar-hosted', permission: 'editor', monitorLimit: 2, paused, policyRevision }),
    contexts: () => [{ id: 'calendar-hosted', paused, policyRevision }],
  });
  const send = (path: string, method = 'GET', body?: unknown, token = 'editor') => hosted.fetch(new Request('https://hosted.example' + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  const status = async () => (await send('/api/operator')).json() as Promise<import('../src/index').Status>;
  const dispatch = (offset: number) => hosted.scheduled(createScheduledController({ scheduledTime: start + offset, cron: '* * * * *' }), env);
  await send('/api/operator/monitors', 'POST', { name: 'Hosted job', kind: 'heartbeat', scheduleMode: 'calendar', cron: '* * * * *' });
  const id = (await status()).monitor!.id;
  const path = '/api/operator/monitors/' + id;
  const { secret } = await (await send(path + '/heartbeat-secret', 'POST')).json() as { secret: string };
  await dispatch(90_001);
  clock.mockReturnValue(start + 120_000);
  await send('/heartbeat', 'POST', undefined, secret);
  paused = true; policyRevision++;
  clock.mockReturnValue(start + 130_000);
  await send('/api/status');
  const before = await status();
  clock.mockReturnValue(start + 180_000);
  expect((await send('/heartbeat', 'POST', undefined, secret)).status).toBe(204);
  await dispatch(210_001);
  expect((await status()).monitor).toMatchObject({ lastSeen: start + 180_000, lastResult: before.monitor!.lastResult, history: before.monitor!.history });
  clock.mockReturnValue(start + 200_000);
  await send(path + '/maintenance', 'PUT', { endsAt: start + 400_000 });
  await evictDurableObject(env.MONITORING.getByName('calendar-hosted'));
  paused = false; policyRevision++;
  clock.mockReturnValue(start + 250_000);
  await send('/api/status');
  await dispatch(330_001);
  expect((await status()).monitor!.history!.days.at(-1)).toMatchObject({ successes: 0, failures: 1, maintenance: 1 });
  expect((await status()).incidents).toMatchObject([{ openedAt: start + 90_000, closedAt: null }]);
  clock.mockReturnValue(start + 420_000);
  await send('/heartbeat', 'POST', undefined, secret);
  await dispatch(450_001);
  expect((await status()).monitor!.state).toBe('down');
  clock.mockReturnValue(start + 480_000);
  await send('/heartbeat', 'POST', undefined, secret);
  await dispatch(510_001);
  expect((await status()).incidents).toMatchObject([{ openedAt: start + 90_000, closedAt: start + 510_000 }]);
});

it('bounds a century of minute downtime across restarts while retaining the original opening deadline', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await create();
  const later = Date.UTC(2126, 10, 16);
  clock.mockReturnValue(later);
  await tick(later);
  const first = await read();
  expect(first.monitor!.lastResult).toEqual({ at: start + 128 * 60_000 + 30_000, outcome: 'failure' });
  expect(first.incidents).toMatchObject([{ openedAt: start + 90_000, closedAt: null }]);
  expect(first.monitor!.history!.percentage).toBeNull();
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(later);
  const second = await read();
  expect(second.monitor!.lastResult).toEqual({ at: start + 256 * 60_000 + 30_000, outcome: 'failure' });
  expect(second.incidents).toEqual(first.incidents);
  expect(second.monitor!.history!.percentage).toBeNull();
});

it('treats Maintenance start at the inclusive deadline as overlap, and end at occurrence start as outside', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await create();
  const path = '/api/operator/monitors/' + (await read()).monitor!.id + '/maintenance';
  clock.mockReturnValue(start + 91_000);
  await request(path, 'PUT', { endsAt: start + 120_000 });
  clock.mockReturnValue(start + 210_000);
  await request(path, 'PUT', { endsAt: start + 220_000 });
  clock.mockReturnValue(start + 220_000);
  await read(); // Expiry must not erase pending window evidence.
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(start + 220_001);
  expect((await read()).monitor!.history!.days.at(-1)).toMatchObject({ successes: 0, failures: 2, maintenance: 1 });
  expect((await read()).incidents).toMatchObject([{ openedAt: start + 90_000, closedAt: null }]);
});

it('starts a new generation for grace edits without mixing pending receipt evidence or detector counts', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await create();
  const id = (await read()).monitor!.id;
  const path = '/api/operator/monitors/' + id;
  await tick(start + 90_001);
  clock.mockReturnValue(start + 120_000);
  await request('/heartbeat/' + id, 'POST');
  clock.mockReturnValue(start + 125_000);
  expect((await request(path, 'PATCH', { graceSeconds: 20 })).status).toBe(200);
  await tick(start + 150_001);
  expect((await read()).monitor!.lastResult!.at).toBe(start + 90_000);
  clock.mockReturnValue(start + 180_000);
  await request('/heartbeat/' + id, 'POST');
  await tick(start + 200_001);
  expect((await read()).monitor!.state).toBe('down');
  clock.mockReturnValue(start + 240_000);
  await request('/heartbeat/' + id, 'POST');
  await tick(start + 260_001);
  expect((await read()).incidents).toMatchObject([{ openedAt: start + 90_000, closedAt: start + 260_000 }]);
  expect((await read()).monitor!.history!.days.at(-1)).toMatchObject({ successes: 2, failures: 1 });
});

it('resets recovery chronologically for Maintenance between windows during delayed catch-up', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await create();
  const id = (await read()).monitor!.id;
  clock.mockReturnValue(start + 120_000);
  await request('/heartbeat/' + id, 'POST');
  clock.mockReturnValue(start + 160_000);
  await request('/api/operator/monitors/' + id + '/maintenance', 'PUT', { endsAt: start + 170_000 });
  clock.mockReturnValue(start + 180_000);
  await request('/heartbeat/' + id, 'POST');
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(start + 210_001);
  expect((await read()).incidents).toMatchObject([{ openedAt: start + 90_000, closedAt: null }]);
  clock.mockReturnValue(start + 240_000);
  await request('/heartbeat/' + id, 'POST');
  await tick(start + 270_001);
  expect((await read()).incidents).toMatchObject([{ openedAt: start + 90_000, closedAt: start + 270_000 }]);
});

it('retains detector progress for older windows when a later Maintenance expires before catch-up', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await create();
  const id = (await read()).monitor!.id;
  await tick(start + 90_001);
  clock.mockReturnValue(start + 120_000);
  await request('/heartbeat/' + id, 'POST');
  await tick(start + 150_001);
  clock.mockReturnValue(start + 180_000);
  await request('/heartbeat/' + id, 'POST');
  clock.mockReturnValue(start + 300_000);
  await request('/api/operator/monitors/' + id + '/maintenance', 'PUT', { endsAt: start + 400_000 });
  clock.mockReturnValue(start + 500_000);
  await read();
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(start + 500_000);
  expect((await read()).incidents).toMatchObject([
    { openedAt: start + 270_000, closedAt: null },
    { openedAt: start + 90_000, closedAt: start + 210_000 },
  ]);
});

it('preserves pending evidence across ordinary edits and validates mode-specific fields and legacy omitted grace', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await create({ cron: '*/5 * * * *', graceSeconds: 90, recoveryThreshold: 3 });
  const id = (await read()).monitor!.id;
  const path = '/api/operator/monitors/' + id;
  const before = await read();
  for (const field of ['intervalSeconds', 'silenceSeconds', 'recoverySpacingSeconds']) {
    expect((await request(path, 'PATCH', { [field]: 60 })).status).toBe(400);
    expect(await read()).toEqual(before);
  }
  expect((await request('/api/operator', 'PUT', { pageName: 'Legacy', name: 'Job', kind: 'heartbeat', scheduleMode: 'calendar', cron: '* * * * *' })).status).toBe(400);
  expect(await read()).toEqual(before);
  await request('/api/operator', 'PUT', { pageName: 'Legacy', name: 'Job', kind: 'heartbeat' });
  expect((await read()).monitor).toMatchObject({ id, graceSeconds: 90, cron: '*/5 * * * *' });
  await tick(start + 390_001);
  clock.mockReturnValue(start + 600_000);
  await request('/heartbeat/' + id, 'POST');
  await tick(start + 690_001);
  clock.mockReturnValue(start + 900_000);
  await request('/heartbeat/' + id, 'POST');
  await request(path, 'PATCH', { name: 'Renamed', published: false, recoveryThreshold: 2 });
  expect((await read()).monitor!.state).toBe('down');
  await tick(start + 990_001);
  expect((await read()).incidents).toMatchObject([{ openedAt: start + 390_000, closedAt: start + 990_000 }]);
  expect((await create({ cron: '0 9 * * 1', graceSeconds: 86400 })).status).toBe(201);
});

// Bound expensive Intl work independently of workerd's I/O-driven clock.
it('bounds dense named-zone grace validation over the full Gregorian horizon', () => {
  const format = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (this: Intl.DateTimeFormat, at) {
    calls++;
    if (calls > 160_000) throw new Error('Calendar validation exceeded 160000 timezone conversions');
    return format.call(this, at);
  });
  expect(calendar('*/2 * * * *', 'America/New_York').acceptsGrace(60, start)).toBe(true);
  expect(calls).toBeLessThan(160_000);
});

it.each([
  ['0-28/2,31-57/2 * * * *', 60, 120],
  ['*/4 * * * *', 180, 240],
] as const)('bounds exact half-hour DST validation for %s', (cron, grace, gap) => {
  const format = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (this: Intl.DateTimeFormat, at) {
    if (++calls > 200_000) throw new Error('Calendar validation exceeded 200000 timezone conversions');
    return format.call(this, at);
  });
  const schedule = calendar(cron, 'Australia/Lord_Howe');
  expect(schedule.acceptsGrace(grace, start)).toBe(true);
  expect(calls).toBeLessThan(200_000);
  calls = 0;
  expect(schedule.acceptsGrace(gap, start)).toBe(false);
});

it('validates creation once and saves unchanged Calendar settings without rescanning the horizon', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  const format = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (this: Intl.DateTimeFormat, at) {
    calls++;
    if (calls > 160_000) throw new Error('Repeated Calendar validation');
    return format.call(this, at);
  });
  expect((await create({ cron: '*/2 * * * *', timezone: 'America/New_York', graceSeconds: 60 })).status).toBe(201);
  const id = (await read()).monitor!.id;
  calls = 0;
  expect((await request('/api/operator/monitors/' + id, 'PATCH', {
    name: 'Renamed', published: false, recoveryThreshold: 3,
    scheduleMode: 'calendar', cron: '*/2 * * * *', timezone: 'America/New_York', graceSeconds: 60,
  })).status).toBe(200);
  expect(calls).toBeLessThan(100);
  expect((await request('/api/operator/monitors/' + id, 'PATCH', { name: 'Job', published: true })).status).toBe(200);
  expect(calls).toBeLessThan(100);
  expect((await request('/api/operator', 'PUT', { pageName: 'Legacy', name: 'Renamed', kind: 'heartbeat' })).status).toBe(200);
  expect(calls).toBeLessThan(100);
  expect((await request('/heartbeat/' + id, 'POST')).status).toBe(204);
  expect((await request('/api/operator/monitors/' + id, 'PATCH', { graceSeconds: 120 })).status).toBe(400);
  calls = 0;
  expect((await request('/api/operator/schedule-preview', 'POST', { cron: '*/2 * * * *', timezone: 'America/New_York', graceSeconds: 60, after: start })).status).toBe(200);
});

it.each([
  ['0 9 * * *', 'America/New_York', 82_800],
  ['0 9 * * *', 'Australia/Lord_Howe', 84_600],
  ['30 1,2 * * *', 'Australia/Lord_Howe', 1_800],
  ['0 0,3 * * *', 'America/New_York', 7_200],
  ['15,45 * * * *', 'Pacific/Chatham', 1_800],
  ['0,2 * * * *', 'Asia/Kathmandu', 120],
] as const)('preserves the exact strict gap for %s in %s', (cron, timezone, gap) => {
  const schedule = calendar(cron, timezone);
  expect(schedule.acceptsGrace(gap - 1, start)).toBe(true);
  expect(schedule.acceptsGrace(gap, start)).toBe(false);
});

it('accepts rare dates and distinguishes nearby calendar dates from overlapping windows', () => {
  const schedule = calendar('0 9 29 2 */7', 'Pacific/Chatham');
  expect(schedule.next(Date.UTC(2096, 2, 1), 3)).toEqual([
    Date.parse('2128-02-28T19:15:00Z'), Date.parse('2156-02-28T19:15:00Z'), Date.parse('2184-02-28T19:15:00Z'),
  ]);
  expect(schedule.acceptsGrace(86_400, start)).toBe(true);
});

it.each([
  ['0-28/2,31-57/2 * * * *', 60, 120],
  ['*/4 * * * *', 180, 240],
] as const)('validates dense Lord Howe schedules through preview, create and edits: %s', async (cron, graceSeconds, gap) => {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  const settings = { cron, timezone: 'Australia/Lord_Howe', graceSeconds };
  expect((await request('/api/operator/schedule-preview', 'POST', { ...settings, after: start })).status).toBe(200);
  expect((await create(settings)).status).toBe(201);
  const id = (await read()).monitor!.id;
  const path = '/api/operator/monitors/' + id;
  expect((await request(path, 'PATCH', { graceSeconds: gap - 1 })).status).toBe(200);
  const before = await read();
  expect((await request(path, 'PATCH', { graceSeconds: gap })).status).toBe(400);
  expect(await read()).toEqual(before);
  expect((await create({ ...settings, graceSeconds: gap })).status).toBe(400);
  expect((await request('/api/operator/schedule-preview', 'POST', { ...settings, graceSeconds: gap, after: start })).status).toBe(400);
});

it('interleaves receipts and ordinary edits with grace validation without restoring stale state', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  await create({ cron: '*/5 * * * *', graceSeconds: 90 });
  const id = (await read()).monitor!.id;
  const path = '/api/operator/monitors/' + id;
  const format = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (this: Intl.DateTimeFormat, at) {
    ++calls;
    if (calls > 200_000) throw new Error('Repeated validation after concurrent changes');
    return format.call(this, at);
  });
  const edit = request(path, 'PATCH', { cron: '0-28/2,31-57/2 * * * *', timezone: 'Australia/Lord_Howe', graceSeconds: 60 });
  while (calls < 1024) await scheduler.wait(0);
  expect((await request('/heartbeat/' + id, 'POST')).status).toBe(204);
  expect((await request(path, 'PATCH', { name: 'Concurrent', published: false })).status).toBe(200);
  expect(calls).toBeLessThan(10_000);
  expect((await edit).status).toBe(200);
  expect((await read()).monitor).toMatchObject({ name: 'Concurrent', published: false, lastSeen: start, cron: '0-28/2,31-57/2 * * * *', graceSeconds: 60 });
});

it.each(['PATCH', 'PUT'])('rejects a %s save when its Monitor is deleted during grace validation without editing the next Monitor', async method => {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  expect((await create({ cron: '*/5 * * * *', graceSeconds: 90 })).status).toBe(201);
  const id = (await read()).monitor!.id;
  expect((await create({ name: 'Sibling', cron: '*/5 * * * *' })).status).toBe(201);
  const sibling = (await read()).monitors[1];
  const format = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0, finished = false;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (this: Intl.DateTimeFormat, at) {
    if (++calls > 200_000) throw new Error('Unbounded grace validation');
    return format.call(this, at);
  });
  const saving = request(method === 'PATCH' ? '/api/operator/monitors/' + id : '/api/operator', method, {
    ...(method === 'PUT' ? { pageName: 'Changed', kind: 'heartbeat', name: 'Configured' } : {}),
    cron: '0-28/2,31-57/2 * * * *', timezone: 'Australia/Lord_Howe', graceSeconds: 60,
  }).then(response => { finished = true; return response; });
  for (let yields = 0; calls < 1024 && yields < 100; yields++) await scheduler.wait(0);
  expect(calls).toBeGreaterThanOrEqual(1024);
  expect(finished).toBe(false);
  expect((await request('/api/operator/monitors/' + id, 'DELETE')).status).toBe(200);
  const afterDeletion = await read();
  expect(afterDeletion.monitors).toEqual([sibling]);
  expect(finished).toBe(false);
  const response = await saving;
  expect(response.status).toBe(method === 'PATCH' ? 404 : 409);
  expect(await response.json()).toEqual({ error: method === 'PATCH' ? 'Monitor not found' : 'Monitor changed; reload before saving' });
  expect((await request('/heartbeat/' + id, 'POST')).status).toBe(404);
  await tick(start + 90_001);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  expect(await read()).toEqual(afterDeletion);
});

it.each([
  ['*/2 * * * *', 200, 60],
  ['* * * * *', 400, 30],
] as const)('revalidates pending grace against concurrent schedule %s and retains the latest other fields', async (cron, status, graceSeconds) => {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  expect((await create({ cron: '0-28/2,31-57/2 * * * *', timezone: 'Australia/Lord_Howe' })).status).toBe(201);
  const id = (await read()).monitor!.id;
  const path = '/api/operator/monitors/' + id;
  const format = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0, finished = false;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (this: Intl.DateTimeFormat, at) {
    if (++calls > 200_000) throw new Error('Repeated validation after concurrent schedule changes');
    return format.call(this, at);
  });
  const saving = request(path, 'PATCH', { graceSeconds: 60 }).then(response => { finished = true; return response; });
  for (let yields = 0; calls < 1024 && yields < 100; yields++) await scheduler.wait(0);
  expect(calls).toBeGreaterThanOrEqual(1024);
  expect(finished).toBe(false);
  expect((await request(path, 'PATCH', { cron, timezone: 'UTC', name: 'Concurrent', published: false, recoveryThreshold: 3 })).status).toBe(200);
  const concurrent = await read();
  expect(finished).toBe(false);
  const response = await saving;
  expect(response.status).toBe(status);
  const saved = await read();
  expect(saved.monitor).toMatchObject({ id, cron, timezone: 'UTC', graceSeconds, name: 'Concurrent', published: false, recoveryThreshold: 3 });
  if (status === 200) expect(await response.json()).toEqual(saved);
  else expect(saved).toEqual(concurrent);
  expect((await (await request('/api/status')).json() as import('../src/index').Status).monitors).toEqual([]);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(start + 90_001);
  const observed = (await read()).monitor!;
  expect(observed.lastResult).toEqual(status === 200 ? null : { at: start + 90_000, outcome: 'failure' });
  await tick(start + 180_001);
  expect((await read()).monitor!.lastResult).toEqual({ at: start + (status === 200 ? 180_000 : 150_000), outcome: 'failure' });
});

it('limits Calendar validation work per batch and overall', async () => {
  const format = Intl.DateTimeFormat.prototype.formatToParts;
  let total = 0, chunk = 0, maximum = 0;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (this: Intl.DateTimeFormat, at) {
    total++; chunk++;
    return format.call(this, at);
  });
  const wait = scheduler.wait.bind(scheduler);
  vi.spyOn(scheduler, 'wait').mockImplementation(async (delay, options) => {
    maximum = Math.max(maximum, chunk);
    chunk = 0;
    await wait(delay, options);
  });
  expect(await calendar('0-28/2,31-57/2 * * * *', 'Australia/Lord_Howe').acceptsGraceAsync(60, start)).toBe(true);
  expect(total).toBeLessThan(160_000);
  expect(Math.max(maximum, chunk)).toBeLessThan(600);
});
