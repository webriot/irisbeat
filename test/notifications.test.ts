// SPDX-License-Identifier: AGPL-3.0-only
import worker, { createHostedWorker } from '../src/index';
import { env } from 'cloudflare:workers';
import { createScheduledController, evictDurableObject, runDurableObjectAlarm, reset } from 'cloudflare:test';
import { afterEach, beforeAll, afterAll, expect, it, vi } from 'vitest';
import { setupNetwork } from '@msw/cloudflare';
import { http, HttpResponse } from 'msw';
const network = setupNetwork();
beforeAll(() => network.enable());
afterAll(() => network.disable());
const sockets: WebSocket[] = [];
afterEach(async () => {
  await Promise.all(sockets.splice(0).map(socket => socket.readyState === WebSocket.CLOSED ? undefined : new Promise<void>(resolve => { socket.addEventListener('close', () => resolve(), { once: true }); socket.close(); })));
  vi.restoreAllMocks(); network.resetHandlers(); await reset();
});
const request = (path: string, method = 'GET', body?: unknown) => worker.fetch(new Request('https://irisbeat.example' + path, { method, headers: { authorization: 'Bearer test-installation-secret', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
async function subscribe() {
  const response = await worker.fetch(new Request('https://irisbeat.example/api/status/events', { headers: { Upgrade: 'websocket', Origin: 'https://irisbeat.example' } }), env);
  expect(response.status).toBe(101);
  const socket = response.webSocket!; socket.accept(); sockets.push(socket);
  const messages: unknown[] = []; socket.addEventListener('message', event => { messages.push(event.data); });
  return { socket, messages };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
it('routes Hono upgrades to hibernating public subscriptions and coalesces until acknowledged', async () => {
  const { socket, messages } = await subscribe();
  await request('/api/operator', 'PUT', { pageName: 'First' });
  await settle(); expect(messages).toEqual(['changed']);
  await request('/api/operator', 'PUT', { pageName: 'Latest' });
  await request('/api/operator', 'PUT', { pageName: 'Final' });
  await settle(); expect(messages).toEqual(['changed']);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  socket.send('ack'); await settle(); expect(messages).toEqual(['changed', 'changed']);
  expect(await (await request('/api/status')).json()).toMatchObject({ pageName: 'Final' });
  socket.send('ack'); await settle();
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await request('/api/operator', 'PUT', { pageName: 'After hibernation' });
  await settle(); expect(messages).toEqual(['changed', 'changed', 'changed']);
});
it('keeps private activity and configuration-only secrets silent, including after recreation', async () => {
  network.use(http.post('https://alerts.example/secret', () => new HttpResponse(null, { status: 204 })));
  const { socket, messages } = await subscribe();
  const saved = await (await request('/api/operator/monitors', 'POST', { name: 'Private', kind: 'heartbeat', published: false })).json() as import('../src/index').Status;
  const path = '/api/operator/monitors/' + saved.monitor!.id;
  await request('/api/operator/webhook', 'PUT', { url: 'https://alerts.example/secret' });
  await request(path, 'PATCH', { name: 'Private renamed' });
  await request(path + '/maintenance', 'PUT', { endsAt: Date.now() + 60_000 });
  await request('/heartbeat/' + saved.monitor!.id, 'POST');
  await worker.scheduled(createScheduledController({ scheduledTime: Date.now() + 300_000 }), env);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await request(path + '/maintenance', 'DELETE');
  await settle(); expect(messages).toEqual([]);
  await request(path, 'PATCH', { published: true });
  await settle(); expect(messages).toEqual(['changed']);
  socket.send('ack'); await settle();
  await request(path, 'PATCH', { silenceSeconds: 300 });
  await settle(); expect(messages).toEqual(['changed']);
  await request(path, 'DELETE');
  await settle(); expect(messages).toEqual(['changed', 'changed']);
});
it('validates Origin and secure transport before upgrade without trusting forwarded headers', async () => {
  for (const [url, origin, expected] of [
    ['https://irisbeat.example/api/status/events', 'https://evil.example', 403],
    ['https://irisbeat.example/api/status/events', '', 403],
    ['http://irisbeat.example/api/status/events', 'http://irisbeat.example', 403],
    ['https://irisbeat.example/api/status/events', 'https://irisbeat.example', 426],
  ] as const) {
    const response = await worker.fetch(new Request(url, { headers: { Origin: origin, 'X-Forwarded-Host': 'evil.example' } }), env);
    expect(response.status).toBe(expected);
  }
});
it('isolates anonymous subscriptions using trusted hosted context resolution', async () => {
  const hosted = createHostedWorker({ contractVersion: '1', resolve: req => ({ id: new URL(req.url).hostname, permission: 'editor', monitorLimit: 10 }), contexts: () => [] });
  const response = await hosted.fetch(new Request('https://a.example/api/status/events', { headers: { Origin: 'https://a.example', Upgrade: 'websocket', 'x-context-id': 'b.example' } }), env);
  expect(response.status).toBe(101); const socket = response.webSocket!; socket.accept(); sockets.push(socket);
  const messages: unknown[] = []; socket.addEventListener('message', event => { messages.push(event.data); });
  const save = (host: string) => hosted.fetch(new Request('https://' + host + '/api/operator', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageName: host }) }), env);
  await save('b.example'); await settle(); expect(messages).toEqual([]);
  await save('a.example'); await settle(); expect(messages).toEqual(['changed']);
});
it('notifies Calendar results/history, visible Incidents, Maintenance and pause but hides target/timing edits', async () => {
  const at = Date.parse('2030-11-16T10:00Z');
  vi.spyOn(Date, 'now').mockReturnValue(at);
  network.use(http.get('https://target.example/', () => new HttpResponse(null, { status: 503 })));
  const { socket, messages } = await subscribe();
  const saved = await (await request('/api/operator/monitors', 'POST', { name: 'Calendar', url: 'https://target.example/', scheduleMode: 'calendar', cron: '* * * * *', failureThreshold: 1 })).json() as import('../src/index').Status;
  const path = '/api/operator/monitors/' + saved.monitor!.id;
  async function acknowledge(count: number) { await settle(); expect(messages).toHaveLength(count); socket.send('ack'); await settle(); }
  await acknowledge(1);
  await request(path, 'PATCH', { timeoutSeconds: 20 });
  await settle(); expect(messages).toHaveLength(1);
  await worker.scheduled(createScheduledController({ scheduledTime: at + 60_000 }), env);
  await acknowledge(2);
  expect(await (await request('/api/status')).json()).toMatchObject({ monitor: { state: 'down', history: { percentage: 0 } }, incidents: [{ closedAt: null }] });
  await request(path + '/maintenance', 'PUT', { endsAt: at + 120_000 });
  await acknowledge(3);
  await request(path + '/maintenance', 'DELETE');
  await acknowledge(4);
  const hosted = createHostedWorker({ contractVersion: '1', resolve: () => ({ id: 'personal', paused: true, policyRevision: 1, permission: null, monitorLimit: 1 }), contexts: () => [] });
  await hosted.fetch(new Request('https://irisbeat.example/api/status'), env);
  await acknowledge(5);
  expect(await (await request('/api/status')).json()).toMatchObject({ paused: true });
});
it('bounds connections and rejects unsolicited or oversized application messages', async () => {
  const { socket } = await subscribe();
  const closed = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code)));
  socket.send('x'.repeat(4096)); expect(await closed).toBe(1008);
  for (let i = 0; i < 128; i++) await subscribe();
  const response = await worker.fetch(new Request('https://irisbeat.example/api/status/events', { headers: { Upgrade: 'websocket', Origin: 'https://irisbeat.example' } }), env);
  expect(response.status).toBe(503);
});
it('announces public time boundaries after hibernation without private activity', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-11-16T10:00Z'));
  const { socket, messages } = await subscribe();
  const created = await (await request('/api/operator/monitors', 'POST', { name: 'Public', kind: 'heartbeat' })).json() as import('../src/index').Status;
  await settle(); socket.send('ack'); await settle();
  const endsAt = Date.now() + 60_000;
  await request('/api/operator/monitors/' + created.monitor!.id + '/maintenance', 'PUT', { endsAt });
  await settle(); socket.send('ack'); await settle();
  expect(messages).toHaveLength(2);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  clock.mockReturnValue(endsAt);
  expect(await runDurableObjectAlarm(env.MONITORING.getByName('personal'))).toBe(true);
  await settle(); expect(messages).toHaveLength(3);
  expect(await (await request('/api/status')).json()).toMatchObject({ monitor: { maintenance: null, state: 'unknown' } });
  socket.send('ack'); await settle();
  clock.mockReturnValue(Date.parse('2030-11-17T00:00Z'));
  expect(await runDurableObjectAlarm(env.MONITORING.getByName('personal'))).toBe(true);
  await settle(); expect(messages).toHaveLength(4);
  const status = await (await request('/api/status')).json() as import('../src/index').Status;
  expect(status.monitor!.history!.days.at(-1)!.date).toBe('2030-11-17');
});
