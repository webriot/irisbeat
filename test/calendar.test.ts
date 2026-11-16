// SPDX-License-Identifier: AGPL-3.0-only
import worker from '../src/index';
import { exports, env } from 'cloudflare:workers';
import { createScheduledController, evictDurableObject, reset } from 'cloudflare:test';
import { setupNetwork } from '@msw/cloudflare';
import { http, HttpResponse } from 'msw';
import { beforeAll, afterAll, afterEach, it, expect, vi } from 'vitest';
const network = setupNetwork();
beforeAll(() => network.enable());
afterAll(() => network.disable());
afterEach(async () => { vi.restoreAllMocks(); network.resetHandlers(); await reset(); });
const request = (path: string, method = 'GET', body?: unknown, authenticated = true) => exports.default.fetch('https://irisbeat.example' + path, {
  method, headers: { ...(authenticated ? { authorization: 'Bearer test-installation-secret' } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const preview = (cron: string, timezone = 'UTC', after = '2026-03-07T12:00:00Z') => request('/api/operator/schedule-preview', 'POST', { cron, timezone, after: Date.parse(after) });
const read = async () => (await request('/api/operator')).json() as Promise<import('../src/index').Status>;
const create = (settings = {}) => request('/api/operator/monitors', 'POST', { name: 'Calendar', url: 'https://target.example/', scheduleMode: 'calendar', cron: '*/5 * * * *', ...settings });
const tick = (at: number) => worker.scheduled(createScheduledController({ scheduledTime: at, cron: '* * * * *' }), env);

it('previews authoritative named-zone occurrences, skipping gaps and using only the first repeated wall time', async () => {
  const spring = await preview('30 2 * * *', 'America/New_York');
  expect(spring.status).toBe(200);
  expect(await spring.json()).toMatchObject({ occurrences: [Date.parse('2026-03-09T06:30:00Z'), Date.parse('2026-03-10T06:30:00Z'), Date.parse('2026-03-11T06:30:00Z')] });
});

it('rejects invalid grammar, impossible dates, zones and unauthenticated preview atomically', async () => {
  const created = await create();
  expect(created.status).toBe(201);
  const before = await read();
  const path = '/api/operator/monitors/' + before.monitor!.id;
  for (const cron of ['@daily', '0 0 0 * * *', '0 9 * JAN MON', '0 0 L * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', '0 0 30 2 *', '0 0 31 4 *', '0 0 * * 8', '0 0 * * 5-1']) {
    expect((await preview(cron)).status, cron).toBe(400);
    expect((await request(path, 'PATCH', { name: 'Invalid', cron })).status, cron).toBe(400);
    expect(await read()).toEqual(before);
  }
  expect((await preview('* * * * *', 'Invalid/Zone')).status).toBe(400);
  expect((await request('/api/operator/schedule-preview', 'POST', { cron: '* * * * *' }, false)).status).toBe(401);
  expect((await create({ kind: 'heartbeat' })).status).toBe(400); // HTTP targets remain wrong-kind fields.
  expect((await create({ kind: 'heartbeat', url: undefined })).status).toBe(201);
  expect((await read()).monitors.at(-1)).toMatchObject({ kind: 'heartbeat', scheduleMode: 'calendar', graceSeconds: 30 });
});

it('supports lists, ranges, steps, Sunday 7 and OR day semantics with explicit explanations', async () => {
  const response = await preview('0,30 9-10/1 15 * 1', 'UTC', '2026-11-13T00:00:00Z');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ explanation: expect.stringContaining('day-of-month 15 OR Monday'), occurrences: [Date.parse('2026-11-15T09:00:00Z'), Date.parse('2026-11-15T09:30:00Z'), Date.parse('2026-11-15T10:00:00Z')] });
  const leap = await preview('0 0 29 2 *', 'UTC', '2096-03-01T00:00:00Z');
  expect(await leap.json()).toMatchObject({ occurrences: [Date.parse('2104-02-29T00:00:00Z'), Date.parse('2108-02-29T00:00:00Z'), Date.parse('2112-02-29T00:00:00Z')] });
  expect(await (await preview('0 0 * * 7', 'UTC', '2026-11-13T00:00:00Z')).json()).toMatchObject({ explanation: expect.stringContaining('Sunday') });
});

it.each([
  ['0 9 */1 * 1', 'Monday', ['2026-11-23', '2026-11-30', '2026-12-07']],
  ['0 9 23 * */1', 'day-of-month 23', ['2026-11-23', '2026-12-23', '2027-01-23']],
  ['0 9 */2 * 1', ' AND Monday', ['2026-11-23', '2026-12-07', '2026-12-21']],
  ['0 9 20-23 * */2', ' AND Sunday, Tuesday, Thursday, Saturday', ['2026-11-21', '2026-11-22', '2026-12-20']],
  ['0 9 */2 * */2', ' AND Sunday, Tuesday, Thursday, Saturday', ['2026-11-17', '2026-11-19', '2026-11-21']],
])('uses wildcard day matching for preview and dispatch: %s', async (cron, explanation, dates) => {
  const after = '2026-11-16T10:00:00Z';
  const occurrences = dates.map(date => Date.parse(date + 'T09:00:00Z'));
  const response = await preview(cron, 'UTC', after);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({ explanation: expect.stringContaining(explanation), occurrences });
  expect(result).toMatchObject({ explanation: expect.not.stringContaining(' OR ') });
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(after));
  expect((await create({ cron })).status).toBe(201);
  let attempts = 0;
  network.use(http.get('https://target.example/', () => { attempts++; return new HttpResponse(null, { status: 204 }); }));
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(occurrences[0] - 60_000);
  expect(attempts).toBe(0);
  for (const [index, at] of occurrences.entries()) {
    await tick(at);
    await tick(at);
    expect(attempts).toBe(index + 1);
    await tick(occurrences[index + 1] === undefined ? at + 60_000 : occurrences[index + 1] - 60_000);
    expect(attempts).toBe(index + 1);
  }
});

it('accepts wildcard-step leap days beyond a single leap year and the skipped-century gap', async () => {
  const after = '2088-03-01T00:00:00Z';
  const cron = '0 0 29 2 */7'; // Sunday leap days: the skipped century creates a forty-year gap.
  const response = await preview(cron, 'UTC', after);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ occurrences: [Date.parse('2128-02-29T00:00:00Z'), Date.parse('2156-02-29T00:00:00Z'), Date.parse('2184-02-29T00:00:00Z')] });
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(after));
  expect((await create({ cron })).status).toBe(201);
  let attempts = 0;
  network.use(http.get('https://target.example/', () => { attempts++; return new HttpResponse(null, { status: 204 }); }));
  await tick(Date.parse('2128-02-28T00:00:00Z'));
  expect(attempts).toBe(0);
  await tick(Date.parse('2128-02-29T00:00:00Z'));
  expect(attempts).toBe(1);
});

it('rejects impossible wildcard-step dates without saving any legacy or collection fields', async () => {
  await create();
  const before = await read();
  for (const cron of ['0 0 31 2 */1', '0 0 31 2 */2']) {
    expect((await preview(cron)).status).toBe(400);
    expect((await request('/api/operator/monitors/' + before.monitor!.id, 'PATCH', { name: 'Invalid', cron })).status).toBe(400);
    expect((await request('/api/operator', 'PUT', { pageName: 'Invalid', name: 'Invalid', url: 'https://target.example/', cron })).status).toBe(400);
    expect(await read()).toEqual(before);
  }
});

it('previews only first occurrences across hour and half-hour fall-back transitions', async () => {
  expect(await (await preview('30 1 * * *', 'America/New_York', '2026-11-01T04:00:00Z')).json()).toMatchObject({ occurrences: [Date.parse('2026-11-01T05:30:00Z'), Date.parse('2026-11-02T06:30:00Z'), Date.parse('2026-11-03T06:30:00Z')] });
  expect(await (await preview('30 1 * * *', 'America/New_York', '2026-11-01T05:31:00Z')).json()).toMatchObject({ occurrences: [Date.parse('2026-11-02T06:30:00Z'), Date.parse('2026-11-03T06:30:00Z'), Date.parse('2026-11-04T06:30:00Z')] });
  expect(await (await preview('45 1 * * *', 'Australia/Lord_Howe', '2026-04-04T13:00:00Z')).json()).toMatchObject({ occurrences: [Date.parse('2026-04-04T14:45:00Z'), Date.parse('2026-04-05T15:15:00Z'), Date.parse('2026-04-06T15:15:00Z')] });
});

it('starts in the future, persists due times and collapses overdue occurrences without duplicate Checks', async () => {
  const start = Date.UTC(2026, 10, 16, 0, 1);
  vi.spyOn(Date, 'now').mockReturnValue(start);
  expect((await create({ failureThreshold: 1, recoveryThreshold: 1 })).status).toBe(201);
  let attempts = 0;
  let outcome = 503;
  network.use(http.get('https://target.example/', () => { attempts++; return new HttpResponse(null, { status: outcome }); }));
  await tick(start);
  expect(attempts).toBe(0);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(start + 4 * 60_000);
  const opened = await read();
  expect(opened).toMatchObject({ monitor: { scheduleMode: 'calendar', timezone: 'UTC', state: 'down', lastResult: { at: start + 4 * 60_000, outcome: 'failure' } }, incidents: [{ openedAt: start + 4 * 60_000, closedAt: null }] });
  await tick(start + 4 * 60_000);
  expect(attempts).toBe(1);
  outcome = 204;
  await tick(start + 61 * 60_000); // 00:10 through 01:00 collapse to one current Check at 01:02.
  await tick(start + 61 * 60_000);
  expect(attempts).toBe(2);
  expect((await read()).incidents[0]).toMatchObject({ id: opened.incidents[0].id, closedAt: start + 61 * 60_000 });
  await tick(start + 63 * 60_000);
  expect(attempts).toBe(2);
  await tick(start + 64 * 60_000);
  expect(attempts).toBe(3);
  const publicStatus = await (await request('/api/status', 'GET', undefined, false)).json() as Record<string, unknown>;
  expect(JSON.stringify(publicStatus)).not.toContain('cron');
  expect(JSON.stringify(publicStatus)).not.toContain('target.example');
});

it('preserves interval defaults and omission while resetting detection on actual schedule changes', async () => {
  const start = Date.UTC(2026, 10, 16, 0, 1);
  vi.spyOn(Date, 'now').mockReturnValue(start);
  await create({ scheduleMode: undefined, cron: undefined });
  const initial = await read();
  const path = '/api/operator/monitors/' + initial.monitor!.id;
  expect(initial.monitor).toMatchObject({ scheduleMode: 'interval' });
  network.use(http.get('https://target.example/', () => new HttpResponse(null, { status: 503 })));
  await tick(start); // One interval failure must not seed the new Calendar detector.
  await request(path, 'PATCH', { scheduleMode: 'calendar', cron: '*/5 * * * *' });
  await request(path, 'PATCH', { name: 'Renamed', intervalSeconds: 300 });
  await evictDurableObject(env.MONITORING.getByName('personal'));
  expect((await read()).monitor).toMatchObject({ id: initial.monitor!.id, scheduleMode: 'calendar', cron: '*/5 * * * *', timezone: 'UTC' });
  await tick(start + 4 * 60_000);
  expect((await read()).incidents).toEqual([]);
  await tick(start + 9 * 60_000);
  const opened = await read();
  expect(opened.incidents).toHaveLength(1);
  // Identical schedule saves must not reset a streak; a changed schedule must reset recovery.
  network.use(http.get('https://target.example/', () => new HttpResponse(null, { status: 204 })));
  await tick(start + 14 * 60_000);
  vi.spyOn(Date, 'now').mockReturnValue(start + 14 * 60_000);
  await request(path, 'PATCH', { cron: '*/10 * * * *' });
  await tick(start + 19 * 60_000);
  expect((await read()).incidents[0].closedAt).toBeNull();
  await request(path, 'PATCH', { cron: '*/10 * * * *' });
  await tick(start + 29 * 60_000);
  expect((await read()).incidents[0]).toMatchObject({ id: opened.incidents[0].id, closedAt: start + 29 * 60_000 });
  await request(path, 'PATCH', { scheduleMode: 'interval' });
  expect((await read()).monitor).toMatchObject({ scheduleMode: 'interval', intervalSeconds: 300 });
});

it('keeps starting targets and thresholds through edits, prevents overlap, and discards deleted results', async () => {
  const start = Date.UTC(2026, 10, 16);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await create({ cron: '* * * * *', failureThreshold: 1 });
  const path = '/api/operator/monitors/' + (await read()).monitor!.id;
  const target = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async input => {
    expect(String(input)).toBe('https://target.example/');
    clock.mockReturnValue(start + 61_000);
    await request(path, 'PATCH', { url: 'https://new.example/', cron: '*/5 * * * *', failureThreshold: 100 });
    await tick(start + 120_000);
    return new Response(null, { status: 503 });
  });
  await tick(start + 60_000);
  expect(target).toHaveBeenCalledTimes(1);
  expect(await read()).toMatchObject({ monitor: { url: 'https://new.example/', cron: '*/5 * * * *', failureThreshold: 100, state: 'down' }, incidents: [{ openedAt: start + 60_000, closedAt: null }] });
  await tick(start + 120_000);
  expect(target).toHaveBeenCalledTimes(1);
  target.mockImplementationOnce(async input => {
    expect(String(input)).toBe('https://new.example/');
    await request(path, 'DELETE');
    return new Response(null, { status: 204 });
  });
  await tick(start + 300_000);
  expect(await read()).toMatchObject({ monitors: [], incidents: [{ closedAt: null }] });
});

it('records Calendar Maintenance without counting or recovery and preserves webhook transitions', async () => {
  const start = Date.UTC(2026, 10, 16);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await create({ cron: '* * * * *', failureThreshold: 1, recoveryThreshold: 2 });
  const path = '/api/operator/monitors/' + (await read()).monitor!.id;
  const messages: unknown[] = [];
  await request('/api/operator/webhook', 'PUT', { url: 'https://hooks.example/calendar' });
  network.use(http.post('https://hooks.example/calendar', async ({ request }) => { messages.push(await request.json()); return new HttpResponse(null, { status: 204 }); }));
  network.use(http.get('https://target.example/', () => new HttpResponse(null, { status: 503 })));
  await tick(start + 60_000);
  const incident = (await read()).incidents[0];
  clock.mockReturnValue(start + 65_000);
  await request(path + '/maintenance', 'PUT', { endsAt: start + 180_000 });
  network.use(http.get('https://target.example/', () => new HttpResponse(null, { status: 204 })));
  await tick(start + 120_000);
  expect((await read()).monitor!.history!.days.at(-1)).toMatchObject({ successes: 0, failures: 1, maintenance: 1 });
  expect((await read()).incidents[0]).toEqual(incident);
  clock.mockReturnValue(start + 180_000);
  await tick(start + 180_000);
  expect((await read()).incidents[0].closedAt).toBeNull();
  await tick(start + 240_000);
  expect((await read()).incidents[0]).toMatchObject({ id: incident.id, closedAt: start + 240_000 });
  expect(messages).toEqual([{ text: 'Calendar: Incident opened' }, { text: 'Calendar: Incident recovered' }]);
  // A window declared and ended during an active Check still exempts the Check.
  vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
    clock.mockReturnValue(start + 301_000);
    await request(path + '/maintenance', 'PUT', { endsAt: start + 310_000 });
    await request(path + '/maintenance', 'DELETE');
    return new Response(null, { status: 503 });
  });
  await tick(start + 300_000);
  expect((await read()).monitor!.lastResult).toEqual({ at: start + 300_000, outcome: 'maintenance' });
  expect(messages).toHaveLength(2);
});

it('dispatches no nonexistent or second repeated wall time', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-03-07T12:00:00Z'));
  await create({ cron: '30 2 * * *', timezone: 'America/New_York' });
  let attempts = 0;
  network.use(http.get('https://target.example/', () => { attempts++; return new HttpResponse(null, { status: 204 }); }));
  await tick(Date.parse('2026-03-08T07:30:00Z'));
  expect(attempts).toBe(0);
  await tick(Date.parse('2026-03-09T06:30:00Z'));
  expect(attempts).toBe(1);
  const path = '/api/operator/monitors/' + (await read()).monitor!.id;
  clock.mockReturnValue(Date.parse('2026-11-01T04:00:00Z'));
  await request(path, 'PATCH', { cron: '30 1 * * *' });
  await tick(Date.parse('2026-11-01T05:30:00Z'));
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(Date.parse('2026-11-01T06:30:00Z'));
  expect(attempts).toBe(2);
  await tick(Date.parse('2026-11-02T06:30:00Z'));
  expect(attempts).toBe(3);
});

it('accepts repeated Interval saves and later omitted-field patches after Calendar is removed', async () => {
  await create();
  const path = '/api/operator/monitors/' + (await read()).monitor!.id;
  for (const patch of [{ scheduleMode: 'interval' }, { scheduleMode: 'interval' }, { name: 'Still editable' }]) {
    expect((await request(path, 'PATCH', patch)).status).toBe(200);
  }
  expect((await read()).monitor).toMatchObject({ name: 'Still editable', scheduleMode: 'interval' });
});

it('preserves Calendar settings through legacy omitted-field saves and rejects invalid schedule changes atomically', async () => {
  await create();
  const initial = await read();
  const id = initial.monitor!.id;
  expect((await request('/api/operator', 'PUT', { pageName: 'Legacy', name: 'Legacy Calendar', url: 'https://target.example/' })).status).toBe(200);
  const before = await read();
  expect(before.monitor).toMatchObject({ id, scheduleMode: 'calendar', cron: '*/5 * * * *', timezone: 'UTC' });
  for (const patch of [{ scheduleMode: null }, { scheduleMode: 'unknown' }, { timezone: null }, { timezone: '+01:00' }, { timezone: 'Missing/Zone' }, { scheduleMode: 'interval', cron: '* * * * *' }]) {
    expect((await request('/api/operator/monitors/' + id, 'PATCH', { name: 'Invalid', ...patch })).status).toBe(400);
    expect(await read()).toEqual(before);
  }
});

it('preserves the latest Calendar schedule, due time and detector progress during a streamed legacy save', async () => {
  const start = Date.UTC(2026, 10, 16, 8);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await create({ cron: '0 9 * * *' });
  const id = (await read()).monitor!.id;
  let attempts = 0;
  network.use(http.get('https://target.example/', () => { attempts++; return new HttpResponse(null, { status: 503 }); }));
  // A zero-sized queue starts pulling only when the route reads the body, after selecting its Monitor.
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      expect((await request('/api/operator/monitors/' + id, 'PATCH', { cron: '0 10 * * *', timeoutSeconds: 5 })).status).toBe(200);
      await tick(Date.UTC(2026, 10, 16, 10));
      expect((await read()).incidents).toEqual([]);
      clock.mockReturnValue(Date.UTC(2026, 10, 17, 11)); // The next due occurrence is now overdue.
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ pageName: 'Legacy', name: 'Legacy Calendar', url: 'https://target.example/' })));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const saved = await worker.fetch(new Request('https://irisbeat.example/api/operator', {
    method: 'PUT', headers: { authorization: 'Bearer test-installation-secret', 'Content-Type': 'application/json' }, body,
  }), env);
  expect(saved.status).toBe(200);
  expect((await read()).monitor).toMatchObject({ id, name: 'Legacy Calendar', cron: '0 10 * * *', timeoutSeconds: 5 });
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await tick(Date.UTC(2026, 10, 17, 11));
  expect(attempts).toBe(2); // An omitted save must not move the overdue Check to tomorrow.
  expect((await read()).incidents).toMatchObject([{ openedAt: Date.UTC(2026, 10, 17, 11), closedAt: null }]);
});

it('does not seed a changed schedule with a late starting-configuration result', async () => {
  const start = Date.UTC(2026, 10, 16);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await create({ cron: '* * * * *' });
  const path = '/api/operator/monitors/' + (await read()).monitor!.id;
  const target = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
    clock.mockReturnValue(start + 61_000);
    await request(path, 'PATCH', { cron: '*/5 * * * *' });
    return new Response(null, { status: 503 });
  });
  await tick(start + 60_000);
  target.mockImplementation(async () => new Response(null, { status: 503 }));
  await tick(start + 300_000);
  expect((await read()).incidents).toEqual([]);
  await tick(start + 600_000);
  expect((await read()).incidents).toMatchObject([{ openedAt: start + 600_000, closedAt: null }]);
});
