// SPDX-License-Identifier: AGPL-3.0-only
import worker, { createHostedWorker, type Status } from '../src/index';
import { env } from 'cloudflare:workers';
import { createScheduledController, evictDurableObject, runDurableObjectAlarm, runInDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
const origin = 'https://irisbeat.example';
const sockets: WebSocket[] = [];
afterEach(async () => {
  await Promise.all(sockets.splice(0).map(socket => socket.readyState === WebSocket.CLOSED ? undefined : new Promise<void>(resolve => { socket.addEventListener('close', () => resolve(), { once: true }); socket.close(); })));
  vi.restoreAllMocks(); await reset();
});
const request = (path: string, method = 'GET', body?: unknown) => worker.fetch(new Request(origin + path, { method, headers: { authorization: 'Bearer test-installation-secret', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
async function ticket() {
  const response = await request('/api/operator/events/ticket', 'POST');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return await response.json() as { ticket: string; expiresAt: number };
}
async function subscribe() {
  const response = await worker.fetch(new Request(origin + '/api/operator/events/v2', { headers: { Upgrade: 'websocket', Origin: origin } }), env);
  expect(response.status).toBe(101);
  const socket = response.webSocket!; socket.accept(); sockets.push(socket);
  const messages: unknown[] = []; socket.addEventListener('message', event => { messages.push(event.data === 'authorized' ? 'authorized' : JSON.parse(String(event.data)).type); });
  return { socket, messages };
}
it('authenticates only through the first message, then sends private invalidations without data', async () => {
  const grant = await ticket();
  const { socket, messages } = await subscribe();
  await request('/api/operator/monitors', 'POST', { name: 'Before auth', kind: 'heartbeat', published: false });
  await settle(); expect(messages).toEqual([]);
  socket.send(JSON.stringify({ type: 'auth', ticket: grant.ticket }));
  await settle(); expect(messages).toEqual(['authorized']);
  await request('/api/operator/webhook', 'PUT', { url: 'https://private.example/hook' });
  await settle(); expect(messages).toEqual(['authorized', 'changed']);
  await request('/api/operator/monitors', 'POST', { name: 'Private', kind: 'heartbeat', published: false });
  await settle(); expect(messages).toHaveLength(2);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  socket.send('ack'); await settle(); expect(messages).toEqual(['authorized', 'changed', 'changed']);
});
const closes = (socket: WebSocket) => new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code), { once: true }));
it('writes only changed subscription deadlines and wakes for overlapping leases after eviction', async () => {
  const at = Date.parse('2030-11-16T10:00Z');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  const context = env.MONITORING.getByName('personal');
  const alarm = () => runInDurableObject(context, (_instance, state) => state.storage.getAlarm());
  const writes: (number | null)[] = [];
  const trackWrites = () => runInDurableObject(context, (_instance, { storage }) => {
    const setAlarm = storage.setAlarm.bind(storage);
    const deleteAlarm = storage.deleteAlarm.bind(storage);
    vi.spyOn(storage, 'setAlarm').mockImplementation((deadline, options) => {
      writes.push(Number(deadline));
      return setAlarm(deadline, options);
    });
    vi.spyOn(storage, 'deleteAlarm').mockImplementation(options => {
      writes.push(null);
      return deleteAlarm(options);
    });
  });

  await trackWrites();
  await request('/api/operator', 'PUT', { pageName: 'No subscribers' });
  await request('/api/operator', 'PUT', { pageName: 'Still no subscribers' });
  expect(await alarm()).toBeNull();
  expect(writes).toEqual([]);

  const grant = await ticket();
  const [operator, sameDeadline] = await Promise.all([subscribe(), subscribe()]);
  expect(await alarm()).toBe(at + 10_000);
  expect(writes).toEqual([at + 10_000]);

  await evictDurableObject(context);
  await trackWrites();
  const expired = await subscribe();
  expect(await alarm()).toBe(at + 10_000);
  expect(writes).toEqual([at + 10_000]);

  operator.socket.send(JSON.stringify({ type: 'auth', ticket: grant.ticket }));
  await vi.waitFor(() => expect(operator.messages).toEqual(['authorized']));
  expect(await alarm()).toBe(at + 10_000);
  expect(writes).toEqual([at + 10_000]);

  const sameClosed = closes(sameDeadline.socket), expiredClosed = closes(expired.socket);
  clock.mockReturnValue(at + 10_000);
  expect(await runDurableObjectAlarm(context)).toBe(true);
  expect(await Promise.all([sameClosed, expiredClosed])).toEqual([1008, 1008]);
  expect(await alarm()).toBe(at + 300_000);

  const earlier = await subscribe();
  expect(await alarm()).toBe(at + 20_000);
  for (const { socket } of [earlier, operator]) {
    const closed = closes(socket);
    socket.close();
    await closed;
  }
  expect(await alarm()).toBeNull();
  expect(writes).toEqual([
    at + 10_000,
    null, // runDurableObjectAlarm removes the alarm before invoking the handler.
    at + 300_000, at + 20_000, at + 300_000, null,
  ]);
});

it('atomically consumes tickets once, rejects wrong first messages and expired tickets after hibernation', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-11-16T10:00Z'));
  const grant = await ticket();
  expect(grant.expiresAt).toBe(Date.now() + 30_000);
  const a = await subscribe(), b = await subscribe();
  const denied = closes(b.socket);
  a.socket.send(JSON.stringify({ type: 'auth', ticket: grant.ticket }));
  b.socket.send(JSON.stringify({ type: 'auth', ticket: grant.ticket }));
  await settle(); expect(a.messages).toEqual(['authorized']); expect(await denied).toBe(1008);
  const late = await ticket();
  await evictDurableObject(env.MONITORING.getByName('personal'));
  clock.mockReturnValue(Date.now() + 30_000);
  const c = await subscribe(); const expired = closes(c.socket);
  c.socket.send(JSON.stringify({ type: 'auth', ticket: late.ticket }));
  expect(await expired).toBe(1008); expect(c.messages).toEqual([]);
  for (const message of ['ack', JSON.stringify({ type: 'renew', ticket: (await ticket()).ticket }), 'x'.repeat(4096)]) {
    const d = await subscribe(); const invalid = closes(d.socket); d.socket.send(message); expect(await invalid).toBe(1008);
  }
});
it('enforces the five-minute lease before notifications and on the shared alarm, preserving public silence', async () => {
  const at = Date.parse('2030-11-16T10:00Z');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  const publicResponse = await worker.fetch(new Request(origin + '/api/status/events/v2', { headers: { Upgrade: 'websocket', Origin: origin } }), env);
  const publicSocket = publicResponse.webSocket!; publicSocket.accept(); sockets.push(publicSocket);
  const publicMessages: unknown[] = []; publicSocket.addEventListener('message', event => { publicMessages.push(event.data === 'authorized' ? 'authorized' : JSON.parse(String(event.data)).type); });
  const a = await subscribe(), b = await subscribe();
  a.socket.send(JSON.stringify({ type: 'auth', ticket: (await ticket()).ticket }));
  b.socket.send(JSON.stringify({ type: 'auth', ticket: (await ticket()).ticket }));
  await settle();
  await evictDurableObject(env.MONITORING.getByName('personal'));
  clock.mockReturnValue(at + 300_000);
  const aClosed = closes(a.socket), bClosed = closes(b.socket);
  await request('/api/operator/monitors', 'POST', { name: 'Private after expiry', kind: 'heartbeat', published: false });
  expect(await aClosed).toBe(1008); expect(await bClosed).toBe(1008);
  expect(a.messages).toEqual(['authorized']); expect(publicMessages).toEqual([]);
  const c = await subscribe(); c.socket.send(JSON.stringify({ type: 'auth', ticket: (await ticket()).ticket })); await settle();
  await evictDurableObject(env.MONITORING.getByName('personal'));
  clock.mockReturnValue(at + 600_000); const cClosed = closes(c.socket);
  await runDurableObjectAlarm(env.MONITORING.getByName('personal'));
  expect(await cClosed).toBe(1008); expect(publicMessages).toEqual([]);
});
it('renews in place across hibernation without resetting coalescing and rejects failed renewal', async () => {
  const at = Date.parse('2030-11-16T10:00Z');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  const { socket, messages } = await subscribe();
  socket.send(JSON.stringify({ type: 'auth', ticket: (await ticket()).ticket })); await settle();
  await request('/api/operator', 'PUT', { pageName: 'Before renewal' }); await settle();
  clock.mockReturnValue(at + 240_000);
  const renewal = await ticket();
  await evictDurableObject(env.MONITORING.getByName('personal'));
  socket.send(JSON.stringify({ type: 'renew', ticket: renewal.ticket })); await settle();
  expect(messages).toEqual(['authorized', 'changed', 'authorized']);
  clock.mockReturnValue(at + 300_001);
  await request('/api/operator', 'PUT', { pageName: 'After original expiry' }); await settle();
  socket.send('ack'); await settle(); expect(messages).toEqual(['authorized', 'changed', 'authorized', 'changed']);
  const closed = closes(socket);
  socket.send(JSON.stringify({ type: 'renew', ticket: renewal.ticket })); expect(await closed).toBe(1008);
});
it('bounds unauthenticated connections and closes them on timeout without private notices', async () => {
  const at = Date.parse('2030-11-16T10:00Z'); const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  const opened = [];
  for (let i = 0; i < 16; i++) opened.push(await subscribe());
  const response = await worker.fetch(new Request(origin + '/api/operator/events/v2', { headers: { Upgrade: 'websocket', Origin: origin } }), env);
  expect(response.status).toBe(503);
  const closed = opened.map(({ socket }) => closes(socket));
  await evictDurableObject(env.MONITORING.getByName('personal'));
  clock.mockReturnValue(at + 10_000);
  await runDurableObjectAlarm(env.MONITORING.getByName('personal'));
  expect(await Promise.all(closed)).toEqual(Array(16).fill(1008));
  expect(opened.every(({ messages }) => !messages.length)).toBe(true);
  await subscribe();
});
it('requires HTTP authorization and validates upgrade Origin, transport and credential-free URLs/protocols', async () => {
  for (const method of ['POST', 'GET']) {
    expect((await worker.fetch(new Request(origin + '/api/operator/events/ticket', { method }), env)).status).toBe(401);
  }
  for (const [url, headers, status] of [
    [origin + '/api/operator/events/v2', { Origin: 'https://evil.example', Upgrade: 'websocket' }, 403],
    [origin + '/api/operator/events/v2', { Upgrade: 'websocket' }, 403],
    ['http://irisbeat.example/api/operator/events/v2', { Origin: 'http://irisbeat.example', Upgrade: 'websocket' }, 403],
    [origin + '/api/operator/events/v2?ticket=secret', { Origin: origin, Upgrade: 'websocket' }, 400],
    [origin + '/api/operator/events/v2', { Origin: origin, Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'secret' }, 400],
    [origin + '/api/operator/events/v2', { Origin: origin }, 426],
  ] as const) expect((await worker.fetch(new Request(url, { headers }), env)).status).toBe(status);
});
it('re-resolves hosted reader/editor access for each ticket and keeps context, origin and snapshot permissions isolated', async () => {
  let permission: 'editor' | 'reader' | null = 'editor';
  const hosted = createHostedWorker({ contractVersion: '1', resolve: req => ({ id: new URL(req.url).hostname === 'alias.example' ? 'a.example' : new URL(req.url).hostname, permission, monitorLimit: 10 }), contexts: () => [] });
  const fetch = (host: string, path: string, method = 'GET', body?: unknown) => hosted.fetch(new Request('https://' + host + path, { method, headers: { Origin: 'https://' + host, Upgrade: 'websocket', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  const grant = await (await fetch('a.example', '/api/operator/events/ticket', 'POST')).json() as { ticket: string };
  for (const host of ['b.example', 'alias.example']) {
    const response = await fetch(host, '/api/operator/events/v2');
    const socket = response.webSocket!; socket.accept(); sockets.push(socket); const closed = closes(socket);
    socket.send(JSON.stringify({ type: 'auth', ticket: grant.ticket })); expect(await closed).toBe(1008);
  }
  permission = 'reader';
  const readerTicket = await fetch('a.example', '/api/operator/events/ticket', 'POST'); expect(readerTicket.status).toBe(200);
  const response = await fetch('a.example', '/api/operator/events/v2'); const socket = response.webSocket!; socket.accept(); sockets.push(socket);
  const messages: unknown[] = []; socket.addEventListener('message', event => { messages.push(event.data === 'authorized' ? 'authorized' : JSON.parse(String(event.data)).type); });
  socket.send(JSON.stringify({ type: 'auth', ticket: ((await readerTicket.json()) as { ticket: string }).ticket })); await settle();
  expect(messages).toEqual(['authorized']);
  expect((await fetch('a.example', '/api/operator/monitors', 'POST', { name: 'Denied', kind: 'heartbeat' })).status).toBe(403);
  permission = 'editor';
  const tenantMonitor = await (await fetch('a.example', '/api/operator/monitors', 'POST', { name: 'Tenant private', kind: 'heartbeat', published: false })).json() as Status;
  const row = '/api/operator/partials/monitor/' + tenantMonitor.monitor!.id;
  await fetch('a.example', '/api/operator/webhook', 'PUT', { url: 'https://private.example/hook' });
  await fetch('b.example', '/api/operator/monitors', 'POST', { name: 'Other private', kind: 'heartbeat', published: false });
  expect(await (await fetch('a.example', '/api/operator/partials/destinations')).text()).toContain('https://private.example/hook');
  permission = 'reader';
  await settle();
  expect(messages).toEqual(['authorized', 'changed']);
  expect(await (await fetch('a.example', '/api/operator')).json()).not.toHaveProperty('webhookUrl');
  expect((await fetch('a.example', '/api/operator/partials/destinations')).status).toBe(404);
  expect(await (await fetch('a.example', row)).json()).toMatchObject({
    permission: 'reader', revision: 1, html: expect.stringContaining('Tenant private'),
    monitors: [{ id: tenantMonitor.monitor!.id }],
  });
  expect(await (await fetch('b.example', row)).json()).toEqual({ permission: 'reader', revision: 1, html: '', monitors: [], minCheckIntervalSeconds: 60 });
  permission = null;
  expect((await fetch('a.example', '/api/operator/events/ticket', 'POST')).status).toBe(401);
  expect((await fetch('a.example', '/api/operator')).status).toBe(401);
  expect((await fetch('a.example', row)).status).toBe(401);
  const closed = closes(socket); socket.send(JSON.stringify({ type: 'renew', ticket: 'denied' })); expect(await closed).toBe(1008);
});
it('drops pending editor-only updates when a connection renews as a reader', async () => {
  let permission: 'editor' | 'reader' = 'editor';
  const hosted = createHostedWorker({ contractVersion: '1', resolve: () => ({ id: 'personal', permission, monitorLimit: 10 }), contexts: () => [] });
  const issue = async () => await (await hosted.fetch(new Request(origin + '/api/operator/events/ticket', { method: 'POST' }), env)).json() as { ticket: string };
  const { socket, messages } = await subscribe(); socket.send(JSON.stringify({ type: 'auth', ticket: (await issue()).ticket })); await settle();
  await request('/api/operator/webhook', 'PUT', { url: 'https://private.example/first' }); await settle();
  await request('/api/operator/webhook', 'PUT', { url: 'https://private.example/latest' }); await settle();
  permission = 'reader'; socket.send(JSON.stringify({ type: 'renew', ticket: (await issue()).ticket })); await settle();
  socket.send('ack'); await settle();
  expect(messages).toEqual(['authorized', 'changed', 'authorized']);
  await request('/api/operator/webhook', 'PUT', { url: 'https://private.example/reader-silent' }); await settle();
  expect(messages).toHaveLength(3);
  const saved = await (await request('/api/operator/monitors', 'POST', { name: 'Visible to reader', kind: 'heartbeat', published: false })).json() as Status;
  await settle(); expect(messages).toEqual(['authorized', 'changed', 'authorized', 'changed']);
  expect(await (await hosted.fetch(new Request(origin + '/api/operator'), env)).json()).toMatchObject({ permission: 'reader', monitors: [{ id: saved.monitor!.id }] });
});
it('notifies private results, history, Incidents, Maintenance expiry and hosted pause while public stays silent', async () => {
  const at = Date.parse('2030-11-16T10:00Z'); const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  const { socket, messages } = await subscribe(); socket.send(JSON.stringify({ type: 'auth', ticket: (await ticket()).ticket })); await settle();
  const publicResponse = await worker.fetch(new Request(origin + '/api/status/events/v2', { headers: { Upgrade: 'websocket', Origin: origin } }), env);
  const publicSocket = publicResponse.webSocket!; publicSocket.accept(); sockets.push(publicSocket);
  const publicMessages: unknown[] = []; publicSocket.addEventListener('message', event => { publicMessages.push(event.data === 'authorized' ? 'authorized' : JSON.parse(String(event.data)).type); });
  const saved = await (await request('/api/operator/monitors', 'POST', { name: 'Private heartbeat', kind: 'heartbeat', published: false })).json() as Status;
  const path = '/api/operator/monitors/' + saved.monitor!.id;
  let notices = 1;
  async function acknowledge() { await settle(); expect(messages.filter(message => message === 'changed')).toHaveLength(notices++); socket.send('ack'); await settle(); }
  await acknowledge();
  await request('/heartbeat/' + saved.monitor!.id, 'POST'); await acknowledge();
  clock.mockReturnValue(at + 180_000);
  await worker.scheduled(createScheduledController({ scheduledTime: Date.now() }), env); await acknowledge();
  expect(await (await request('/api/operator')).json()).toMatchObject({ monitor: { state: 'down', history: { percentage: 50 } }, incidents: [{ closedAt: null }] });
  await request(path + '/maintenance', 'PUT', { endsAt: at + 240_000 }); await acknowledge();
  await evictDurableObject(env.MONITORING.getByName('personal'));
  clock.mockReturnValue(at + 240_000); await runDurableObjectAlarm(env.MONITORING.getByName('personal')); await acknowledge();
  expect(publicMessages).toEqual([]);
  const hosted = createHostedWorker({ contractVersion: '1', resolve: () => ({ id: 'personal', paused: true, policyRevision: 1, permission: null, monitorLimit: 10 }), contexts: () => [] });
  await hosted.fetch(new Request(origin + '/api/status'), env); await acknowledge();
  expect(publicMessages).toEqual(['changed']); // Pause itself is public; private observations were silent.
});
it('does not postpone a due public boundary when private requests reschedule authorization alarms', async () => {
  const at = Date.parse('2030-11-16T10:00Z'); const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  const response = await worker.fetch(new Request(origin + '/api/status/events/v2', { headers: { Upgrade: 'websocket', Origin: origin } }), env);
  const socket = response.webSocket!; socket.accept(); sockets.push(socket);
  const messages: unknown[] = []; socket.addEventListener('message', event => { messages.push(event.data === 'authorized' ? 'authorized' : JSON.parse(String(event.data)).type); });
  const saved = await (await request('/api/operator/monitors', 'POST', { name: 'Public time boundary', kind: 'heartbeat' })).json() as Status;
  await settle(); socket.send('ack'); await settle();
  await request('/api/operator/monitors/' + saved.monitor!.id + '/maintenance', 'PUT', { endsAt: at + 60_000 });
  await settle(); socket.send('ack'); await settle();
  clock.mockReturnValue(at + 60_000);
  await request('/api/operator/webhook', 'PUT', { url: 'https://private.example/boundary' });
  await runDurableObjectAlarm(env.MONITORING.getByName('personal'));
  await settle(); expect(messages).toEqual(['changed', 'changed', 'changed']);
});

it('keeps the due UTC rollover when the Operator disconnects and Status stays subscribed', async () => {
  const midnight = Date.parse('2030-11-17T00:00Z');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(midnight - 1000);
  await request('/api/operator/monitors', 'POST', { name: 'Public rollover', kind: 'heartbeat' });
  const response = await worker.fetch(new Request(origin + '/api/status/events/v2', { headers: { Upgrade: 'websocket', Origin: origin } }), env);
  const publicSocket = response.webSocket!;
  publicSocket.accept();
  sockets.push(publicSocket);
  const hints: unknown[] = [];
  publicSocket.addEventListener('message', event => { hints.push(JSON.parse(String(event.data))); });
  const operator = await subscribe();
  operator.socket.send(JSON.stringify({ type: 'auth', ticket: (await ticket()).ticket }));
  await settle();
  expect(operator.messages).toEqual(['authorized']);

  clock.mockReturnValue(midnight + 1);
  const closed = closes(operator.socket);
  operator.socket.close();
  await closed;
  const context = env.MONITORING.getByName('personal');
  expect(await runInDurableObject(context, (_instance, state) => state.storage.getAlarm())).toBe(midnight);
  await runDurableObjectAlarm(context);
  await settle();
  expect(hints).toEqual([{ type: 'changed', revision: 2, scopes: ['monitors', 'incidents', 'banner'] }]);
});
