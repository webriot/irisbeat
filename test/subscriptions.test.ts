// SPDX-License-Identifier: AGPL-3.0-only
import { env, exports } from 'cloudflare:workers';
import { reset, evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker, { createHostedWorker } from '../src/index';
const sockets: WebSocket[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) socket.close(1000); await flush(); await exports.default.fetch('https://status.example/__test-history?mode=available'); vi.restoreAllMocks(); await reset(); });
const request = (path: string, method = 'GET', body?: unknown) => worker.fetch(new Request('https://status.example' + path, { method, headers: { authorization: 'Bearer test-installation-secret', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
async function subscribe(app = worker, host = 'status.example') {
  const response = await app.fetch(new Request('https://' + host + '/api/status/subscribe', { headers: { Upgrade: 'websocket' } }), env);
  expect(response.status).toBe(101);
  const socket = response.webSocket!; socket.accept(); sockets.push(socket);
  const messages: string[] = []; socket.addEventListener('message', event => { messages.push(String(event.data)); });
  return { socket, messages };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 30));
it('accepts anonymous notification subscriptions but requires GET and WebSocket upgrade', async () => {
  expect((await request('/api/status/subscribe')).status).toBe(426);
  expect((await request('/api/status/subscribe', 'POST')).status).toBe(405);
  await subscribe();
});
it('notifies public changes only and coalesces until the subscriber requests resynchronization', async () => {
  const { socket, messages } = await subscribe();
  const created = await (await request('/api/operator/monitors', 'POST', { name: 'Private', kind: 'heartbeat', published: false })).json() as { monitor: { id: string } };
  const id = created.monitor.id;
  await request('/heartbeat/' + id, 'POST');
  await worker.scheduled({ scheduledTime: Date.now() + 180000 } as ScheduledController, env);
  await request('/api/operator/webhook', 'PUT', { url: 'https://secret.example/token' });
  await request('/api/operator/monitors/' + id, 'PATCH', { name: 'Still private' });
  await flush(); expect(messages).toEqual([]);
  await request('/api/operator/monitors/' + id, 'PATCH', { published: true });
  await flush(); expect(messages).toEqual(['{"type":"status-changed"}']);
  await request('/api/operator', 'PUT', { pageName: 'Public' });
  await flush(); expect(messages).toHaveLength(1);
  socket.send('resync'); await flush();
  expect(messages).toEqual(['{"type":"status-changed"}', '{"type":"status-changed"}']);
  expect(await (await request('/api/status')).json()).toMatchObject({ pageName: 'Public', monitor: { name: 'Still private' } });
});
it('routes subscriptions through trusted hosted resolution and survives object recreation', async () => {
  const app = createHostedWorker({ contractVersion: '1', resolve: request => ({ id: new URL(request.url).hostname, permission: 'editor', monitorLimit: 2 }), contexts: () => [] });
  const a = await subscribe(app, 'a.example'); const b = await subscribe(app, 'b.example');
  await evictDurableObject(env.MONITORING.getByName('a.example'));
  await app.fetch(new Request('https://a.example/api/operator', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageName: 'Only A' }) }), env);
  await flush(); expect(a.messages).toEqual(['{"type":"status-changed"}']); expect(b.messages).toEqual([]);
});

it('notifies published observations, Incidents, Maintenance, publication and deletion without exposing target edits', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 503 }));
  const { socket, messages } = await subscribe();
  const sync = async (operation: () => Promise<unknown>, changed = true) => {
    socket.send('resync'); await flush(); messages.length = 0;
    await operation(); await flush();
    expect(messages).toEqual(changed ? ['{"type":"status-changed"}'] : []);
  };
  let id = '';
  await sync(async () => {
    const value = await (await request('/api/operator/monitors', 'POST', { name: 'Site', url: 'https://private-target.example', failureThreshold: 1, recoveryThreshold: 1 })).json() as { monitor: { id: string } }; id = value.monitor.id;
  });
  const path = '/api/operator/monitors/' + id;
  await sync(() => request(path, 'PATCH', { url: 'https://other-secret.example', timeoutSeconds: 5 }), false);
  const now = Date.now();
  await sync(() => worker.scheduled({ scheduledTime: now } as ScheduledController, env));
  expect(await (await request('/api/status')).json()).toMatchObject({ monitor: { state: 'down', history: { percentage: 0 } }, incidents: [{ closedAt: null }] });
  await sync(() => request(path + '/maintenance', 'PUT', { endsAt: now + 600000 }));
  await sync(() => worker.scheduled({ scheduledTime: now + 60000 } as ScheduledController, env));
  await sync(() => request(path + '/maintenance', 'DELETE'));
  vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(null, { status: 200 }));
  await sync(() => worker.scheduled({ scheduledTime: now + 120000 } as ScheduledController, env));
  expect(await (await request('/api/status')).json()).toMatchObject({ monitor: { state: 'up' }, incidents: [{ closedAt: now + 120000 }] });
  await sync(() => request(path, 'PATCH', { published: false }));
  await sync(() => worker.scheduled({ scheduledTime: now + 180000 } as ScheduledController, env), false);
  await sync(() => request(path, 'PATCH', { published: true }));
  await sync(() => request(path, 'DELETE'));
});

it('notifies pause changes but stays silent for policy revisions and hosted heartbeat credential rotation', async () => {
  let paused = false, policyRevision = 1;
  const app = createHostedWorker({ contractVersion: '1', resolve: () => ({ id: 'hosted', permission: 'editor', monitorLimit: 2, paused, policyRevision }), contexts: () => [] });
  const write = (path: string, body?: unknown) => app.fetch(new Request('https://host.example' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  const created = await (await write('/api/operator/monitors', { name: 'Producer', kind: 'heartbeat', published: false })).json() as { monitor: { id: string } };
  const { messages, socket } = await subscribe(app);
  await write('/api/operator/monitors/' + created.monitor.id + '/heartbeat-secret'); await flush(); expect(messages).toEqual([]);
  paused = true; policyRevision++;
  await app.fetch(new Request('https://host.example/api/status'), env); await flush(); expect(messages).toHaveLength(1);
  socket.send('resync'); await flush(); messages.length = 0;
  policyRevision++; await app.fetch(new Request('https://host.example/api/status'), env); await flush(); expect(messages).toEqual([]);
  paused = false; policyRevision++; await app.fetch(new Request('https://host.example/api/status'), env); await flush(); expect(messages).toHaveLength(1);
});

it('handles hibernated pending notifications, rejects socket writes and reconciles after recreation', async () => {
  const { messages, socket } = await subscribe();
  await request('/api/operator', 'PUT', { pageName: 'First' }); await flush();
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await request('/api/operator', 'PUT', { pageName: 'Latest' }); await flush(); expect(messages).toHaveLength(1);
  socket.send('resync'); await flush(); expect(messages).toHaveLength(2);
  expect(await (await request('/api/status')).json()).toMatchObject({ pageName: 'Latest' });
  const closed = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code)));
  socket.send('{"pageName":"Injected"}'); expect(await closed).toBe(1008);
  expect(await (await request('/api/status')).json()).toMatchObject({ pageName: 'Latest' });
});

it('reconciles Maintenance expiry and UTC history rollover on a public clock independent of private activity', async () => {
  const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const created = await (await request('/api/operator/monitors', 'POST', { name: 'Public', kind: 'heartbeat' })).json() as { monitor: { id: string } };
  const id = created.monitor.id;
  const { messages, socket } = await subscribe();
  const stub = env.MONITORING.getByName('personal');
  await request('/api/operator/monitors/' + id + '/maintenance', 'PUT', { endsAt: now + 60000 });
  await flush(); socket.send('resync'); await flush(); messages.length = 0;
  await evictDurableObject(stub);
  clock.mockReturnValue(now + 60000);
  // A private write must not become the trigger for public clock changes.
  await request('/api/operator/webhook', 'PUT', { url: 'https://secret.example/path' });
  await flush(); expect(messages).toEqual([]);
  expect(await runDurableObjectAlarm(stub)).toBe(true); await flush(); expect(messages).toEqual(['{"type":"status-changed"}']);
  expect(await (await request('/api/status')).json()).toMatchObject({ monitor: { maintenance: null, state: 'unknown' } });
  socket.send('resync'); await flush(); messages.length = 0;
  const nextDay = (Math.floor(now / 86400000) + 1) * 86400000;
  clock.mockReturnValue(nextDay);
  await runDurableObjectAlarm(stub); await flush(); expect(messages).toHaveLength(1);
  const status = await (await request('/api/status')).json() as { monitor: { history: { days: { date: string }[] } } };
  expect(status.monitor.history.days.at(-1)!.date).toBe(new Date(nextDay).toISOString().slice(0, 10));
  socket.close(1000); await flush();
  expect(await runDurableObjectAlarm(stub)).toBe(false);
});

it('keeps a private rename straddling public Maintenance expiry silent until the alarm', async () => {
  const end = Date.now() + 60000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(end - 1000);
  const publicStatus = await (await request('/api/operator/monitors', 'POST', { name: 'Public', kind: 'heartbeat' })).json() as { monitor: { id: string } };
  await request('/api/operator/monitors/' + publicStatus.monitor.id + '/maintenance', 'PUT', { endsAt: end });
  const privateStatus = await (await request('/api/operator/monitors', 'POST', { name: 'Private', kind: 'heartbeat', published: false })).json() as { monitors: { id: string }[] };
  const { messages } = await subscribe();
  clock.mockReturnValue(end).mockReturnValueOnce(end - 1);
  expect((await request('/api/operator/monitors/' + privateStatus.monitors[1].id, 'PATCH', { name: 'Renamed' })).status).toBe(200);
  await flush(); expect(messages).toEqual([]);
  await runDurableObjectAlarm(env.MONITORING.getByName('personal'));
  await flush(); expect(messages).toEqual(['{"type":"status-changed"}']);
});

it.each(['fail-after-read', 'recover-after-read', 'missing-after-read', 'present-after-read'])('keeps private writes silent when public history changes availability: %s', async mode => {
  await request('/api/operator/monitors', 'POST', { name: 'Public', kind: 'heartbeat' });
  const created = await (await request('/api/operator/monitors', 'POST', { name: 'Private', kind: 'heartbeat', published: false })).json() as { monitors: { id: string }[] };
  const { messages } = await subscribe();
  await exports.default.fetch('https://status.example/__test-history?mode=' + mode);
  expect((await request('/api/operator/monitors/' + created.monitors[1].id, 'PATCH', { name: mode })).status).toBe(200);
  await flush(); expect(messages).toEqual([]);
});

it('does not restore expired public Maintenance when a private Heartbeat spans capture and commit', async () => {
  const end = Date.now() + 60000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(end - 1000);
  const publicStatus = await (await request('/api/operator/monitors', 'POST', { name: 'Public', kind: 'heartbeat' })).json() as { monitor: { id: string } };
  const path = '/api/operator/monitors/' + publicStatus.monitor.id;
  await request(path + '/maintenance', 'PUT', { endsAt: end });
  const created = await (await request('/api/operator/monitors', 'POST', { name: 'Private', kind: 'heartbeat', published: false })).json() as { monitors: { id: string }[] };
  const { messages } = await subscribe();
  // In the original path: ingress, before, and mutable read precede expiry;
  // record's nested snapshot follows it and must not let stale state restore the window.
  clock.mockReturnValue(end).mockReturnValueOnce(end - 1).mockReturnValueOnce(end - 1).mockReturnValueOnce(end - 1);
  expect((await request('/heartbeat/' + created.monitors[1].id, 'POST')).status).toBe(204);
  await flush(); expect(messages).toEqual([]);
  clock.mockReset().mockReturnValue(end);
  await runDurableObjectAlarm(env.MONITORING.getByName('personal'));
  await flush(); expect(messages).toEqual(['{"type":"status-changed"}']);
  expect(await (await request('/api/status')).json()).toMatchObject({ monitor: { maintenance: null } });
});

it.each(['create', 'edit', 'target', 'remove', 'maintenance', 'end-maintenance', 'heartbeat', 'check', 'webhook'].flatMap(operation => [false, true].map(backwards => ({ operation, backwards }))))(
  'keeps private $operation silent across public expiry (backwards=$backwards)', async ({ operation, backwards }) => {
    const end = Date.now() + 60000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(end - 1000);
    const value = await (await request('/api/operator/monitors', 'POST', { name: 'Public', kind: 'heartbeat', silenceSeconds: 86400 })).json() as { monitor: { id: string } };
    const publicPath = '/api/operator/monitors/' + value.monitor.id;
    await request(publicPath + '/maintenance', 'PUT', { endsAt: end });
    const created = await (await request('/api/operator/monitors', 'POST', { name: 'Private', url: 'https://private.example', published: false })).json() as { monitors: { id: string }[] };
    const privatePath = '/api/operator/monitors/' + created.monitors[1].id;
    const producer = await (await request('/api/operator/monitors', 'POST', { name: 'Producer', kind: 'heartbeat', published: false })).json() as { monitors: { id: string }[] };
    await request(privatePath + '/maintenance', 'PUT', { endsAt: end + 60000 });
    const { messages } = await subscribe();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 200 }));
    const mutate = () => {
      switch (operation) {
        case 'create': return request('/api/operator/monitors', 'POST', { name: 'Another private', kind: 'heartbeat', published: false });
        case 'edit': return request(privatePath, 'PATCH', { name: 'Renamed' });
        case 'target': return request(privatePath, 'PATCH', { url: 'https://changed.example', intervalSeconds: 120 });
        case 'remove': return request(privatePath, 'DELETE');
        case 'maintenance': return request(privatePath + '/maintenance', 'PUT', { endsAt: end + 120000 });
        case 'end-maintenance': return request(privatePath + '/maintenance', 'DELETE');
        case 'heartbeat': return request('/heartbeat/' + producer.monitors[2].id, 'POST');
        case 'check': return worker.scheduled({ scheduledTime: end - 1 } as ScheduledController, env);
        case 'webhook': return request('/api/operator/webhook', 'PUT', { url: 'https://private.example/token' });
      }
    };
    clock.mockReturnValue(backwards ? end - 1 : end).mockReturnValueOnce(backwards ? end : end - 1);
    await mutate(); await flush(); expect(messages).toEqual([]);
    clock.mockReset().mockReturnValue(end);
    await runDurableObjectAlarm(env.MONITORING.getByName('personal'));
    await flush(); expect(messages).toEqual(['{"type":"status-changed"}']);
  },
);

it.each(['failed', 'missing'])('notifies committed public history and settings while presentation history is %s', async mode => {
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
  const created = await (await request('/api/operator/monitors', 'POST', { name: 'Public', kind: 'heartbeat' })).json() as { monitor: { id: string } };
  const id = created.monitor.id;
  const { messages, socket } = await subscribe();
  await exports.default.fetch('https://status.example/__test-history?mode=' + mode);
  for (let i = 0; i < 2; i++) {
    // Same timestamp/result: only the second committed history count changes.
    await request('/heartbeat/' + id, 'POST'); await flush();
    expect(messages).toEqual(['{"type":"status-changed"}']);
    expect(await (await request('/api/status')).json()).toMatchObject({ monitor: { history: null, state: 'up' } });
    socket.send('resync'); await flush(); messages.length = 0;
  }
  await request('/api/operator/monitors/' + id, 'PATCH', { name: 'Renamed public' });
  await flush(); expect(messages).toHaveLength(1);
  socket.send('resync'); await flush(); messages.length = 0;
  await request('/api/operator/monitors/' + id, 'PATCH', { published: false });
  await flush(); expect(messages).toHaveLength(1);
  socket.send('resync'); await flush(); messages.length = 0;
  await exports.default.fetch('https://status.example/__test-history?mode=available');
  await request('/api/operator/monitors/' + id, 'PATCH', { published: true });
  await flush(); expect(messages).toHaveLength(1);
  expect(await (await request('/api/status')).json()).toMatchObject({ monitor: { history: { percentage: 100, days: expect.arrayContaining([expect.objectContaining({ successes: 2 })]) } } });
});

it('keeps unchanged hosted pause revisions and credential rotation silent at expiry without consuming its alarm', async () => {
  const end = Date.now() + 60000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(end - 1000);
  let paused = false, policyRevision = 1;
  const app = createHostedWorker({ contractVersion: '1', resolve: () => ({ id: 'clock-policy', permission: 'editor', monitorLimit: 3, paused, policyRevision }), contexts: () => [] });
  const write = (path: string, method: string, body?: unknown) => app.fetch(new Request('https://status.example' + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  const created = await (await write('/api/operator/monitors', 'POST', { name: 'Public', kind: 'heartbeat' })).json() as { monitor: { id: string } };
  await write('/api/operator/monitors/' + created.monitor.id + '/maintenance', 'PUT', { endsAt: end });
  const privateStatus = await (await write('/api/operator/monitors', 'POST', { name: 'Private', kind: 'heartbeat', published: false })).json() as { monitors: { id: string }[] };
  const { messages, socket } = await subscribe(app);
  await evictDurableObject(env.MONITORING.getByName('clock-policy'));
  policyRevision++;
  clock.mockReturnValue(end).mockReturnValueOnce(end - 1);
  await write('/api/operator/monitors/' + privateStatus.monitors[1].id + '/heartbeat-secret', 'POST');
  await flush(); expect(messages).toEqual([]);
  // A real public pause change must notify, but leave the overdue clock deadline owned by the alarm.
  paused = true; policyRevision++;
  await write('/api/status', 'GET'); await flush(); expect(messages).toHaveLength(1);
  socket.send('resync'); await flush(); messages.length = 0;
  await runDurableObjectAlarm(env.MONITORING.getByName('clock-policy'));
  await flush(); expect(messages).toEqual(['{"type":"status-changed"}']);
});

it('hands off authenticated single-use operator tickets without exposing the installation credential', async () => {
  const anonymous = await worker.fetch(new Request('https://status.example/api/operator/subscription', { method: 'POST' }), env);
  expect(anonymous.status).toBe(401);
  const response = await request('/api/operator/subscription', 'POST');
  expect(response.status).toBe(200);
  const { ticket } = await response.json() as { ticket: string };
  expect(ticket).toBeTruthy(); expect(ticket).not.toContain('test-installation-secret');
  const upgrade = () => worker.fetch(new Request('https://status.example/api/operator/subscribe?ticket=' + ticket, { headers: { Upgrade: 'websocket' } }), env);
  await evictDurableObject(env.MONITORING.getByName('personal'));
  const accepted = await upgrade(); expect(accepted.status).toBe(101);
  accepted.webSocket!.accept(); sockets.push(accepted.webSocket!);
  expect((await upgrade()).status).toBe(401);
});

async function operatorSubscription(app = worker, host = 'status.example', credential = 'test-installation-secret') {
  const response = await app.fetch(new Request('https://' + host + '/api/operator/subscription', { method: 'POST', headers: { authorization: 'Bearer ' + credential } }), env);
  expect(response.status).toBe(200);
  const { ticket } = await response.json() as { ticket: string };
  const upgraded = await app.fetch(new Request('https://' + host + '/api/operator/subscribe?ticket=' + ticket, { headers: { Upgrade: 'websocket' } }), env);
  expect(upgraded.status).toBe(101);
  const socket = upgraded.webSocket!; socket.accept(); sockets.push(socket);
  const messages: string[] = []; socket.addEventListener('message', event => { messages.push(String(event.data)); });
  return { socket, messages };
}
it('notifies private operator facts and isolates editor-only webhook activity from readers and public sockets', async () => {
  const app = createHostedWorker({ contractVersion: '1', resolve: request => ({ id: new URL(request.url).hostname, permission: request.headers.get('authorization') === 'Bearer reader' ? 'reader' : 'editor', monitorLimit: 10 }), contexts: () => [] });
  const reader = await operatorSubscription(app, 'a.example', 'reader');
  const editor = await operatorSubscription(app, 'a.example', 'editor');
  const other = await operatorSubscription(app, 'b.example');
  const anonymous = await subscribe(app, 'a.example');
  const write = (path: string, body: unknown) => app.fetch(new Request('https://a.example' + path, { method: path.endsWith('monitors') ? 'POST' : 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
  await write('/api/operator/webhook', { url: 'https://secret.example/token' });
  await flush(); expect(editor.messages).toHaveLength(1); expect(reader.messages).toEqual([]); expect(anonymous.messages).toEqual([]);
  editor.socket.send('resync'); await flush(); editor.messages.length = 0;
  await write('/api/operator/monitors', { name: 'Private', kind: 'heartbeat', published: false });
  await flush(); expect(editor.messages).toEqual(['{"type":"status-changed"}']); expect(reader.messages).toEqual(editor.messages);
  expect(other.messages).toEqual([]); expect(anonymous.messages).toEqual([]);
});

it('rejects expired tickets and cross-context/origin/audience redemption after object recreation', async () => {
  const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const app = createHostedWorker({ contractVersion: '1', resolve: request => ({ id: new URL(request.url).hostname === 'alias.example' ? 'a.example' : new URL(request.url).hostname, permission: 'reader', monitorLimit: 2 }), contexts: () => [] });
  const issued = await app.fetch(new Request('https://a.example/api/operator/subscription', { method: 'POST' }), env);
  const { ticket } = await issued.json() as { ticket: string };
  const redeem = (host: string, path = '/api/operator/subscribe') => app.fetch(new Request('https://' + host + path + '?ticket=' + ticket, { headers: { Upgrade: 'websocket' } }), env);
  expect((await redeem('b.example')).status).toBe(401);
  expect((await redeem('alias.example')).status).toBe(401);
  // An anonymous endpoint cannot consume an operator capability or reveal private facts.
  const publicResponse = await redeem('a.example', '/api/status/subscribe');
  expect(publicResponse.status).toBe(101); publicResponse.webSocket!.accept(); sockets.push(publicResponse.webSocket!);
  await evictDurableObject(env.MONITORING.getByName('a.example'));
  clock.mockReturnValue(now + 15000);
  expect((await redeem('a.example')).status).toBe(401);
});
it('expires revoked sockets without snapshot requests and preserves independent public clock alarms', async () => {
  const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  let permission: 'editor' | null = 'editor';
  const app = createHostedWorker({ contractVersion: '1', resolve: () => ({ id: 'lease', permission, monitorLimit: 2 }), contexts: () => [] });
  const write = (path: string, body: unknown) => app.fetch(new Request('https://lease.example' + path, { method: path.endsWith('monitors') ? 'POST' : 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
  const created = await (await write('/api/operator/monitors', { name: 'Public', kind: 'heartbeat' })).json() as { monitor: { id: string } };
  await write('/api/operator/monitors/' + created.monitor.id + '/maintenance', { endsAt: now + 120000 });
  const anonymous = await subscribe(app, 'lease.example');
  const operator = await operatorSubscription(app, 'lease.example');
  const closed = new Promise<number>(resolve => operator.socket.addEventListener('close', event => resolve(event.code)));
  permission = null;
  const stub = env.MONITORING.getByName('lease'); await evictDurableObject(stub);
  clock.mockReturnValue(now + 60000); expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await closed).toBe(4001); expect(operator.messages).toEqual([]); expect(anonymous.messages).toEqual([]);
  expect((await app.fetch(new Request('https://lease.example/api/operator/subscription', { method: 'POST' }), env)).status).toBe(401);
  clock.mockReturnValue(now + 120000); expect(await runDurableObjectAlarm(stub)).toBe(true);
  await flush(); expect(anonymous.messages).toEqual(['{"type":"status-changed"}']);
});

it('coalesces private observations, Incidents and Maintenance across hibernation without public timing signals', async () => {
  const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const created = await (await request('/api/operator/monitors', 'POST', { name: 'Private producer', kind: 'heartbeat', published: false, recoveryThreshold: 1 })).json() as { monitor: { id: string } };
  const id = created.monitor.id, path = '/api/operator/monitors/' + id;
  const operator = await operatorSubscription(); const anonymous = await subscribe();
  const sync = async (operation: () => Promise<unknown>) => {
    operator.socket.send('resync'); await flush(); operator.messages.length = 0;
    await operation(); await flush(); expect(operator.messages).toEqual(['{"type":"status-changed"}']); expect(anonymous.messages).toEqual([]);
  };
  await sync(() => request('/heartbeat/' + id, 'POST'));
  await evictDurableObject(env.MONITORING.getByName('personal'));
  await sync(() => worker.scheduled({ scheduledTime: now + 180000 } as ScheduledController, env));
  expect(await (await request('/api/operator')).json()).toMatchObject({ incidents: [{ closedAt: null }] });
  await sync(() => request(path + '/maintenance', 'PUT', { endsAt: now + 10000 }));
  operator.socket.send('resync'); await flush(); operator.messages.length = 0;
  clock.mockReturnValue(now + 10000);
  expect(await runDurableObjectAlarm(env.MONITORING.getByName('personal'))).toBe(true);
  await flush(); expect(operator.messages).toHaveLength(1); expect(anonymous.messages).toEqual([]);
  await sync(() => request('/heartbeat/' + id, 'POST'));
  expect(await (await request('/api/operator')).json()).toMatchObject({ incidents: [{ closedAt: now + 10000 }] });
  await sync(() => request(path, 'PATCH', { name: 'Renamed', silenceSeconds: 300 }));
  await sync(() => request(path, 'DELETE'));
});
it('renews hosted permissions through HTTP and never carries editor audience into a reader lease', async () => {
  const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  let permission: 'reader' | 'editor' | null = 'editor';
  const app = createHostedWorker({ contractVersion: '1', resolve: () => ({ id: 'downgrade', permission, monitorLimit: 2 }), contexts: () => [] });
  const old = await operatorSubscription(app);
  permission = 'reader'; clock.mockReturnValue(now + 60000);
  const closed = new Promise<number>(resolve => old.socket.addEventListener('close', event => resolve(event.code)));
  await runDurableObjectAlarm(env.MONITORING.getByName('downgrade')); expect(await closed).toBe(4001);
  const reader = await operatorSubscription(app);
  const response = await app.fetch(new Request('https://status.example/api/operator'), env);
  expect(await response.json()).toMatchObject({ permission: 'reader' });
  permission = 'editor';
  await app.fetch(new Request('https://status.example/api/operator/webhook', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://secret.example/new' }) }), env);
  await flush(); expect(reader.messages).toEqual([]); expect(old.messages).toEqual([]);
  permission = null;
  expect((await app.fetch(new Request('https://status.example/api/operator'), env)).status).toBe(401);
});

it('requires operator capabilities on upgrades, fixes the ticket audience and bounds lifetime from issuance', async () => {
  const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  expect((await worker.fetch(new Request('https://status.example/api/operator/subscription', { method: 'POST', headers: { authorization: 'Bearer wrong' } }), env)).status).toBe(401);
  expect((await request('/api/operator/subscription')).status).toBe(405);
  expect((await request('/api/operator/subscribe')).status).toBe(426);
  expect((await worker.fetch(new Request('https://status.example/api/operator/subscribe', { headers: { Upgrade: 'websocket', authorization: 'Bearer test-installation-secret' } }), env)).status).toBe(401);
  const app = createHostedWorker({ contractVersion: '1', resolve: request => ({ id: 'audience', permission: request.headers.get('authorization') === 'Bearer editor' ? 'editor' : 'reader', monitorLimit: 2 }), contexts: () => [] });
  const issued = await app.fetch(new Request('https://status.example/api/operator/subscription', { method: 'POST' }), env);
  const { ticket } = await issued.json() as { ticket: string };
  clock.mockReturnValue(now + 14999);
  const response = await app.fetch(new Request('https://status.example/api/operator/subscribe?ticket=' + ticket + '&audience=editor&context=other', { headers: { Upgrade: 'websocket', authorization: 'Bearer editor' } }), env);
  expect(response.status).toBe(101); const socket = response.webSocket!; socket.accept(); sockets.push(socket);
  const messages: string[] = []; socket.addEventListener('message', event => { messages.push(String(event.data)); });
  await app.fetch(new Request('https://status.example/api/operator/webhook', { method: 'PUT', headers: { authorization: 'Bearer editor', 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://secret.example/audience' }) }), env);
  await flush(); expect(messages).toEqual([]);
  const closed = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code)));
  clock.mockReturnValue(now + 60000);
  // Frame-time guard works even before the alarm runs, and never releases queued notifications.
  socket.send('resync'); expect(await closed).toBe(4001); expect(messages).toEqual([]);
});
it('keeps operator pause and private UTC rollover scoped while rejecting application writes over sockets', async () => {
  const now = Math.floor(Date.now() / 86400000) * 86400000 + 86400000 - 30000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  let paused = false, policyRevision = 1;
  const app = createHostedWorker({ contractVersion: '1', resolve: () => ({ id: 'operator-clock', permission: 'editor', monitorLimit: 2, paused, policyRevision }), contexts: () => [] });
  const call = (path: string, body?: unknown) => app.fetch(new Request('https://status.example' + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  await call('/api/operator/monitors', { name: 'Private', kind: 'heartbeat', published: false });
  const operator = await operatorSubscription(app), anonymous = await subscribe(app);
  clock.mockReturnValue(now + 30000);
  await runDurableObjectAlarm(env.MONITORING.getByName('operator-clock')); await flush();
  expect(operator.messages).toEqual(['{"type":"status-changed"}']); expect(anonymous.messages).toEqual([]);
  operator.socket.send('resync'); await flush(); operator.messages.length = 0;
  paused = true; policyRevision++; await call('/api/operator'); await flush();
  expect(operator.messages).toHaveLength(1); expect(anonymous.messages).toHaveLength(1); // Pause is a public context fact.
  operator.socket.send('resync'); await flush(); operator.messages.length = 0;
  policyRevision++; await call('/api/operator'); await flush(); expect(operator.messages).toEqual([]);
  const closed = new Promise<number>(resolve => operator.socket.addEventListener('close', event => resolve(event.code)));
  operator.socket.send('{"pageName":"Injected"}'); expect(await closed).toBe(1008);
  expect(await (await call('/api/operator')).json()).toMatchObject({ pageName: 'Irisbeat', paused: true });
});
