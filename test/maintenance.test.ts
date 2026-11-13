// SPDX-License-Identifier: AGPL-3.0-only
import { connect } from "cloudflare:sockets";
import worker, { type Status } from '../src/index';
import { env, exports } from 'cloudflare:workers';
import { createScheduledController, evictDurableObject, reset } from 'cloudflare:test';
import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import { setupNetwork } from '@msw/cloudflare';
import { http, HttpResponse } from 'msw';
vi.mock("cloudflare:sockets", () => ({ connect: vi.fn() }));
const network = setupNetwork();
beforeAll(() => network.enable());
afterAll(() => network.disable());
const start = Date.UTC(2026, 10, 13);
const authorization = 'Bearer test-installation-secret';
const request = (path: string, init?: RequestInit) => exports.default.fetch(`https://irisbeat.example${path}`, init);
const mutate = (path: string, method: string, body?: unknown) => request(path, { method, headers: { authorization, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const status = async (): Promise<Status> => (await request('/api/status')).json();
const operator = async (): Promise<Status> => (await request('/api/operator', { headers: { authorization } })).json();
async function create(extra = {}) {
  const response = await mutate('/api/operator/monitors', 'POST', { name: 'Website', url: 'https://target.example/', ...extra });
  expect(response.status).toBe(201);
  return ((await response.json()) as Status).monitors.at(-1)!;
}
async function tick(offset: number) { await worker.scheduled(createScheduledController({ scheduledTime: start + offset, cron: '* * * * *' }), env); }
const maintenance = (id: string, endsAt?: number) => mutate('/api/operator/monitors/' + id + '/maintenance', endsAt === undefined ? 'DELETE' : 'PUT', endsAt === undefined ? undefined : { endsAt });
afterEach(async () => { vi.restoreAllMocks(); network.resetHandlers(); await reset(); });
it('authenticates and validates immediate per-Monitor windows, replaces, persists and ends them', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  const monitor = await create();
  const path = '/api/operator/monitors/' + monitor.id + '/maintenance';
  expect((await request(path, { method: 'DELETE' })).status).toBe(401);
  for (const endsAt of [null, 'tomorrow', start, start - 1, start + .5]) {
    expect((await mutate(path, 'PUT', { endsAt })).status).toBe(400);
  }
  expect((await maintenance('missing', start + 60_000)).status).toBe(404);
  expect((await maintenance(monitor.id, start + 60_000)).status).toBe(200);
  expect((await status()).monitor).toMatchObject({ state: 'maintenance', maintenance: { startedAt: start, endsAt: start + 60_000 } });
  clock.mockReturnValue(start + 20_000);
  await maintenance(monitor.id, start + 120_000);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  expect((await operator()).monitor).toMatchObject({ maintenance: { startedAt: start + 20_000, endsAt: start + 120_000 } });
  clock.mockReturnValue(start + 60_000);
  expect((await status()).monitor?.state).toBe('maintenance');
  await maintenance(monitor.id);
  expect((await status()).monitor).toMatchObject({ state: 'unknown', maintenance: null });
  await maintenance(monitor.id, start + 120_000);
  clock.mockReturnValue(start + 120_000);
  expect((await status()).monitor).toMatchObject({ state: 'unknown', maintenance: null });
  expect((await status()).incidents).toEqual([]);
});

it.each(['http', 'tcp'] as const)('continues %s attempts in Maintenance, suppresses alerts and restarts counts after expiry', async kind => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  const monitor = await create(kind === 'tcp' ? { kind, url: undefined, hostname: 'db.example', port: 5432 } : {});
  let up = false;
  let attempts = 0;
  const messages: unknown[] = [];
  network.use(http.get('https://target.example/', () => { attempts++; return new HttpResponse(null, { status: up ? 200 : 503 }); }),
    http.post('https://alerts.example/hook', async ({ request }) => { messages.push(await request.json()); return new HttpResponse(null, { status: 204 }); }));
  vi.mocked(connect).mockImplementation(() => {
    attempts++;
    return { opened: up ? Promise.resolve({}) : Promise.reject(new Error('refused')), closed: Promise.resolve(), close: async () => {} } as Socket;
  });
  await mutate('/api/operator/webhook', 'PUT', { url: 'https://alerts.example/hook' });
  await tick(0); // One pre-window failure must not survive expiry.
  await maintenance(monitor.id, start + 180_000);
  await tick(60_000); await tick(120_000);
  expect(attempts).toBe(3);
  expect((await status()).monitor).toMatchObject({ state: 'maintenance', lastResult: { at: start + 120_000, outcome: 'maintenance' } });
  expect((await status()).incidents).toEqual([]);
  expect(messages).toEqual([]);
  clock.mockReturnValue(start + 180_000);
  await tick(180_000);
  expect((await status()).incidents).toEqual([]);
  await tick(240_000);
  expect((await status()).incidents).toMatchObject([{ openedAt: start + 240_000, closedAt: null }]);
  expect(messages).toEqual([{ text: 'Website: Incident opened' }]);
  clock.mockReturnValue(start + 250_000);
  await maintenance(monitor.id, start + 600_000);
  up = true;
  await tick(300_000); await tick(360_000);
  expect((await status()).incidents[0].closedAt).toBeNull();
  clock.mockReturnValue(start + 400_000);
  await maintenance(monitor.id);
  up = false;
  await tick(420_000); await tick(480_000);
  expect(messages).toHaveLength(1);
  up = true;
  await tick(540_000);
  expect((await status()).incidents[0].closedAt).toBeNull();
  await tick(600_000);
  expect((await status()).incidents).toMatchObject([{ closedAt: start + 600_000 }]);
  expect(messages).toEqual([{ text: 'Website: Incident opened' }, { text: 'Website: Incident recovered' }]);
});
it('keeps fresh and silent Heartbeats observable without transitions and requires post-window recovery receipts', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  const monitor = await create({ kind: 'heartbeat', url: undefined });
  const receipt = () => request('/heartbeat/' + monitor.id, { method: 'POST', headers: { authorization }, body: 'ignored' });
  const messages: unknown[] = [];
  network.use(http.post('https://alerts.example/hook', async ({ request }) => { messages.push(await request.json()); return new HttpResponse(null, { status: 204 }); }));
  await mutate('/api/operator/webhook', 'PUT', { url: 'https://alerts.example/hook' });
  await maintenance(monitor.id, start + 600_000);
  await tick(180_000);
  expect((await status()).monitor).toMatchObject({ lastSeen: null, lastResult: { outcome: 'maintenance' } });
  clock.mockReturnValue(start + 200_000); await receipt();
  clock.mockReturnValue(start + 260_000); await receipt();
  expect((await status()).monitor).toMatchObject({ lastSeen: start + 260_000, lastResult: { at: start + 260_000, outcome: 'maintenance' } });
  expect(messages).toEqual([]);
  clock.mockReturnValue(start + 300_000); await maintenance(monitor.id);
  await tick(300_000);
  expect((await status()).incidents).toEqual([]);
  await tick(440_000);
  expect((await status()).incidents).toMatchObject([{ openedAt: start + 440_000, closedAt: null }]);
  clock.mockReturnValue(start + 450_000); await receipt(); // Partial recovery before the window.
  await maintenance(monitor.id, start + 800_000);
  clock.mockReturnValue(start + 520_000); await receipt();
  clock.mockReturnValue(start + 530_000); await receipt();
  expect((await status()).monitor?.lastResult).toEqual({ at: start + 530_000, outcome: 'maintenance' });
  clock.mockReturnValue(start + 600_000); await receipt();
  await tick(780_000);
  expect((await status()).incidents[0].closedAt).toBeNull();
  expect(messages).toHaveLength(1);
  clock.mockReturnValue(start + 800_000);
  await tick(800_000); // Still silent; no duplicate opening.
  clock.mockReturnValue(start + 810_000); await receipt(); await receipt();
  clock.mockReturnValue(start + 869_999); await receipt();
  expect((await status()).incidents[0].closedAt).toBeNull();
  clock.mockReturnValue(start + 870_000); await receipt();
  expect((await status()).incidents).toMatchObject([{ openedAt: start + 440_000, closedAt: start + 870_000 }]);
  expect(messages).toEqual([{ text: 'Website: Incident opened' }, { text: 'Website: Incident recovered' }]);
});
it('renders ledger Maintenance controls and published banners with open outage precedence', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  const a = await create({ name: 'API', failureThreshold: 1 });
  const b = await create({ name: 'Private', published: false });
  network.use(http.get('https://target.example/', () => new HttpResponse(null, { status: 503 })));
  await maintenance(a.id, start + 600_000);
  let html = await (await request('/')).text();
  expect(html).toContain('<h2>Maintenance</h2>');
  expect(html).toContain('<span class="status">Maintenance</span>');
  expect(html).not.toContain('Private');
  await maintenance(a.id);
  await tick(0);
  await maintenance(a.id, start + 600_000);
  html = await (await request('/')).text();
  expect(html).toContain('<h2>Services unavailable</h2>');
  expect(html).toContain('<span class="status">Maintenance</span>');
  await mutate('/api/operator/monitors/' + b.id, 'PATCH', { published: true });
  await maintenance(b.id, start + 600_000);
  expect(await (await request('/')).text()).toContain('<h2>Services unavailable</h2>');
  const operatorHtml = await (await request('/operator')).text();
  expect(operatorHtml).toContain('id="maintenance"');
  expect(operatorHtml).toContain('type="datetime-local"');
  const script = await (await request('/operator.js')).text();
  expect(script).toContain('/maintenance');
  expect(script).toContain('End Maintenance');
  expect(script).toContain('Replace Maintenance');
});
it('keeps healthy state, skips missing executions, and makes repeated early end harmless', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  const monitor = await create();
  let up = true;
  let attempts = 0;
  network.use(http.get('https://target.example/', () => { attempts++; return new HttpResponse(null, { status: up ? 200 : 503 }); }));
  await tick(0);
  await maintenance(monitor.id, start + 120_000);
  up = false;
  await tick(60_000);
  clock.mockReturnValue(start + 120_000);
  // Reading after a scheduler gap expires Maintenance without making a Check result.
  expect((await status()).monitor).toMatchObject({ state: 'up', lastResult: { at: start + 60_000, outcome: 'maintenance' } });
  expect(attempts).toBe(2);
  await tick(600_000);
  expect((await status()).incidents).toEqual([]);
  await maintenance(monitor.id); // Already ended; must not wipe the first failure.
  await tick(660_000);
  expect((await status()).incidents).toMatchObject([{ openedAt: start + 660_000 }]);
});
