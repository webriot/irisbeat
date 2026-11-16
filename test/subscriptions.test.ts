// SPDX-License-Identifier: AGPL-3.0-only
import { env } from 'cloudflare:workers';
import { reset, evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker, { createHostedWorker } from '../src/index';
const sockets: WebSocket[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) socket.close(1000); await flush(); vi.restoreAllMocks(); await reset(); });
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
