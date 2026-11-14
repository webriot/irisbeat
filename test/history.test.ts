// SPDX-License-Identifier: AGPL-3.0-only
import worker, { type Status } from '../src/index';
import { env, exports } from 'cloudflare:workers';
import { createScheduledController, evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';

const day = 86_400_000;
const today = Date.UTC(2026, 10, 13);
const authorization = 'Bearer test-installation-secret';
const request = (path: string, init?: RequestInit) => exports.default.fetch('https://irisbeat.example' + path, init);
const mutate = (path: string, method: string, body?: unknown) => request(path, { method, headers: { authorization, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const status = async (operator = false): Promise<Status> => (await request(operator ? '/api/operator' : '/api/status', { headers: operator ? { authorization } : {} })).json();
async function create(extra = {}) {
  const response = await mutate('/api/operator/monitors', 'POST', { name: 'Website', url: 'https://target.example/', failureThreshold: 1, recoveryThreshold: 1, ...extra });
  expect(response.status).toBe(201);
  return ((await response.json()) as Status).monitors.at(-1)!;
}
async function tick(at: number) { await worker.scheduled(createScheduledController({ scheduledTime: at, cron: '* * * * *' }), env); }
afterEach(async () => { await request('/__test-history?mode=available'); vi.restoreAllMocks(); await reset(); });

it('renders exactly 90 UTC days and counts only in-range observations across midnight and eviction', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(today - 90 * day);
  await create();
  let up = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: up ? 200 : 503 }));
  await tick(today - 90 * day); // Outside the displayed range.
  up = true;
  await tick(today - 89 * day); // First included midnight.
  await tick(today - 1); // Yesterday, one millisecond before UTC midnight.
  up = false;
  await tick(today + 60_000);
  clock.mockReturnValue(today + 120_000);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  const history = (await status()).monitor!.history!;
  expect(history.days).toHaveLength(90);
  expect(history.days[0]).toEqual({ date: '2026-08-16', state: 'up', successes: 1, failures: 0, maintenance: 0 });
  expect(history.days[1]).toMatchObject({ state: 'empty' });
  expect(history.days[88]).toMatchObject({ date: '2026-11-12', state: 'up' });
  expect(history.days[89]).toMatchObject({ date: '2026-11-13', state: 'down' });
  expect(history.percentage).toBeCloseTo(200 / 3);
  const html = await (await request('/')).text();
  expect(html.match(/class="history-day /g)).toHaveLength(90);
  expect(html).toContain('66.67%');
  expect(html).toContain('2026-11-13 UTC: down');
});

it('distinguishes empty, Maintenance-only and mixed counted days without inventing a denominator', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(today - 2 * day);
  const monitor = await create();
  let html = await (await request('/')).text();
  expect(html).toContain('aria-label="Availability">Unavailable');
  expect(html).not.toContain('100.00%');
  expect((await status()).monitor!.history!.days.every(day => day.state === 'empty')).toBe(true);
  const path = '/api/operator/monitors/' + monitor.id + '/maintenance';
  let up = true;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: up ? 200 : 503 }));
  await mutate(path, 'PUT', { endsAt: today - day });
  await tick(today - 2 * day);
  expect((await status()).monitor!.history).toMatchObject({ percentage: null, days: expect.arrayContaining([expect.objectContaining({ state: 'maintenance' })]) });
  clock.mockReturnValue(today - day);
  await tick(today - day);
  await mutate(path, 'PUT', { endsAt: today });
  await tick(today - day + 60_000);
  clock.mockReturnValue(today);
  up = false;
  await tick(today);
  await mutate(path, 'PUT', { endsAt: today + day });
  await tick(today + 60_000);
  await mutate(path, 'DELETE');
  up = true;
  clock.mockReturnValue(today + 120_000);
  await tick(today + 120_000);
  const history = (await status()).monitor!.history!;
  expect(history.days.slice(-3)).toEqual([
    { date: '2026-11-11', state: 'maintenance', successes: 0, failures: 0, maintenance: 1 },
    { date: '2026-11-12', state: 'up', successes: 1, failures: 0, maintenance: 1 },
    { date: '2026-11-13', state: 'degraded', successes: 1, failures: 1, maintenance: 1 },
  ]);
  expect(history.percentage).toBeCloseTo(200 / 3);
  html = await (await request('/')).text();
  expect(html).toContain('2026-11-11 UTC: Maintenance');
  expect(html).toContain('2026-11-13 UTC: degraded');
});

it('shows overlapping published Incidents newest first in UTC and retains older/private/deleted history only for operators', async () => {
  const first = today - 89 * day;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(first - 2 * day);
  const old = await create({ name: 'Old recovered', url: 'https://old.example/' });
  const touching = await create({ name: 'Ends at boundary', url: 'https://boundary.example/' });
  const ongoing = await create({ name: 'Older still open', url: 'https://open.example/' });
  const privateMonitor = await create({ name: 'Secret monitor', url: 'https://secret.example/', published: false });
  const deleted = await create({ name: 'Deleted monitor', url: 'https://deleted.example/' });
  const recovered = new Set<string>();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => new Response(null, { status: recovered.has(String(input)) ? 200 : 503 }));
  await tick(first - 2 * day);
  recovered.add('https://old.example/');
  clock.mockReturnValue(first - day);
  await tick(first - day);
  recovered.add('https://boundary.example/');
  clock.mockReturnValue(first);
  await tick(first);
  clock.mockReturnValue(today);
  const recent = await create({ name: 'Recent', url: 'https://recent.example/' });
  await tick(today);
  await mutate('/api/operator/monitors/' + deleted.id, 'DELETE');
  const publicData = await status();
  expect(publicData.incidents.map(incident => incident.monitorId)).toEqual([recent.id, ongoing.id]);
  const html = await (await request('/')).text();
  expect(html).toContain('2026-08-14T00:00:00.000Z');
  expect(html.indexOf('Recent — Open')).toBeLessThan(html.indexOf('Older still open — Open'));
  for (const name of ['Old recovered —', 'Ends at boundary —', 'Secret monitor', 'Deleted monitor']) expect(html).not.toContain(name);
  const operator = await status(true);
  expect(operator.incidents).toHaveLength(6);
  expect(operator.incidents.find(incident => incident.monitorId === old.id)?.closedAt).toBe(first - day);
  expect(operator.incidents.find(incident => incident.monitorId === touching.id)?.closedAt).toBe(first);
  expect(operator.incidents.find(incident => incident.monitorId === deleted.id)?.monitorName).toBe('Deleted monitor');
  expect(operator.monitors.find(monitor => monitor.id === privateMonitor.id)?.history?.days.at(-1)?.state).toBe('down');
  await mutate('/api/operator/monitors/' + ongoing.id, 'PATCH', { published: false });
  expect((await status()).incidents.map(incident => incident.monitorId)).toEqual([recent.id]);
  await mutate('/api/operator/monitors/' + privateMonitor.id, 'PATCH', { published: true });
  expect((await status()).incidents.map(incident => incident.monitorId)).toEqual([recent.id, privateMonitor.id]);
});


it.each(['missing', 'failed'])('keeps rendered current state and Incidents when the series is %s', async mode => {
  vi.spyOn(Date, 'now').mockReturnValue(today);
  await create();
  await create({ name: 'Private outage', published: false });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
  await tick(today);
  await request('/__test-history?mode=' + mode);
  const data = await status();
  expect(data.monitor).toMatchObject({ state: 'down', history: null });
  expect(data.incidents).toHaveLength(1);
  const html = await (await request('/')).text();
  expect(html).toContain('Services unavailable');
  expect(html).toContain('Website — Open');
  expect(html).toContain('Bars unavailable');
  expect(html).not.toContain('Private outage');
  expect(html).not.toContain('100.00%');
  expect(html).not.toContain('0.00%');
  const operator = await status(true);
  expect(operator.monitors).toHaveLength(2);
  expect(operator.monitors.every(monitor => monitor.history === null)).toBe(true);
  expect(operator.incidents).toHaveLength(2);
});

it('assigns any-overlap Maintenance to attempt-start UTC day and excludes skipped dispatches', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(today - 1_000);
  const monitor = await create();
  const path = '/api/operator/monitors/' + monitor.id + '/maintenance';
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    clock.mockReturnValue(today + 1_000);
    await mutate(path, 'PUT', { endsAt: today + 30_000 });
    await tick(today); // In flight: no observation.
    await mutate(path, 'DELETE');
    return new Response(null, { status: 503 });
  });
  await tick(today - 1_000);
  let history = (await status()).monitor!.history!;
  expect(history.days.slice(-2)).toMatchObject([{ state: 'maintenance', maintenance: 1 }, { state: 'empty' }]);
  expect(history.percentage).toBeNull();
  expect((await status()).incidents).toEqual([]);
  await tick(today + 1_000); // Not due: no observation.
  history = (await status()).monitor!.history!;
  expect(history.days.at(-1)?.state).toBe('empty');
});

it('counts actual Heartbeat receipts and silence evaluations, with Maintenance excluded', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(today);
  const monitor = await create({ kind: 'heartbeat', url: undefined, failureThreshold: undefined });
  const receipt = () => request('/heartbeat/' + monitor.id, { method: 'POST', headers: { authorization } });
  await receipt();
  await tick(today + 60_000); // Fresh: no observation.
  clock.mockReturnValue(today + 180_000);
  await tick(today + 180_000);
  await mutate('/api/operator/monitors/' + monitor.id + '/maintenance', 'PUT', { endsAt: today + day });
  await receipt();
  expect((await status()).monitor!.history!.days.at(-1)).toMatchObject({ state: 'degraded', successes: 1, failures: 1, maintenance: 1 });
  expect((await status()).monitor!.history!.percentage).toBe(50);
});

it('retains operator Incidents after observation rollover without removing newer or unfinished-day history', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(today - 100 * day);
  await create();
  let up = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: up ? 200 : 503 }));
  await tick(today - 100 * day);
  const original = (await status(true)).incidents[0];
  up = true;
  clock.mockReturnValue(today - 99 * day);
  await tick(today - 99 * day);
  clock.mockReturnValue(today);
  await tick(today);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  expect((await status()).incidents).toEqual([]);
  expect((await status(true)).incidents).toEqual([{ ...original, closedAt: today - 99 * day }]);
  expect((await status()).monitor!.history).toMatchObject({ percentage: 100, days: expect.arrayContaining([expect.objectContaining({ date: '2026-11-13', successes: 1 })]) });
  // Rewinding the query window makes bounded retention observable without storage inspection.
  clock.mockReturnValue(today - 100 * day);
  expect((await status(true)).monitor!.history!.percentage).toBeNull();
});

it('bounds observation cleanup per execution while preserving the unfinished UTC day', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(today - 100 * day);
  const monitor = await create({ kind: 'heartbeat', url: undefined, failureThreshold: undefined });
  const receipt = () => request('/heartbeat/' + monitor.id, { method: 'POST', headers: { authorization } });
  for (let index = 0; index < 1001; index++) expect((await receipt()).status).toBe(204);
  clock.mockReturnValue(today + 1_000);
  await receipt(); // Deletes at most 1,000 expired observations.
  clock.mockReturnValue(today - 100 * day);
  expect((await status()).monitor!.history!.days.at(-1)?.successes).toBe(1);
  clock.mockReturnValue(today + 2_000);
  await receipt();
  expect((await status()).monitor!.history!.days.at(-1)?.successes).toBe(2);
  clock.mockReturnValue(today - 100 * day);
  expect((await status()).monitor!.history!.percentage).toBeNull();
});

it('keeps percentages per Monitor and uses down for failure with Maintenance', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(today);
  await create({ name: 'Healthy', url: 'https://up.example/' });
  const down = await create({ name: 'Failing', url: 'https://down.example/' });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => new Response(null, { status: String(input).includes('up.example') ? 200 : 503 }));
  await tick(today);
  await mutate('/api/operator/monitors/' + down.id + '/maintenance', 'PUT', { endsAt: today + day });
  await tick(today + 60_000);
  const data = await status();
  expect(data.monitors.map(monitor => monitor.history?.percentage)).toEqual([100, 0]);
  expect(data.monitors[1].history!.days.at(-1)).toMatchObject({ state: 'down', successes: 0, failures: 1, maintenance: 1 });
  expect(data).not.toHaveProperty('percentage');
  const html = await (await request('/')).text();
  expect(html.match(/class="percentage"/g)).toHaveLength(2);
});
