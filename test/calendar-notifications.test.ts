// SPDX-License-Identifier: AGPL-3.0-only
import worker, { type Status } from '../src/index';
import { env } from 'cloudflare:workers';
import { createScheduledController, evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
const origin = 'https://irisbeat.example';
const sockets: WebSocket[] = [];
const request = (path: string, method = 'GET', body?: unknown) => worker.fetch(new Request(origin + path, {
  method, headers: { authorization: 'Bearer test-installation-secret', 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), env);
const read = async (operator = true) => (await request(operator ? '/api/operator' : '/api/status')).json() as Promise<Status>;
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
async function subscribe(audience: 'public' | 'operator') {
  const response = await worker.fetch(new Request(origin + '/api/' + (audience === 'public' ? 'status' : 'operator') + '/events', {
    headers: { Upgrade: 'websocket', Origin: origin },
  }), env);
  expect(response.status).toBe(101);
  const socket = response.webSocket!; socket.accept(); sockets.push(socket);
  const messages: unknown[] = [];
  socket.addEventListener('message', event => { messages.push(event.data); });
  if (audience === 'operator') {
    const grant = await (await request('/api/operator/events/ticket', 'POST')).json() as { ticket: string };
    socket.send(JSON.stringify({ type: 'auth', ticket: grant.ticket }));
    await settle(); expect(messages.splice(0)).toEqual(['authorized']);
  }
  return { socket, messages };
}
afterEach(async () => {
  await Promise.all(sockets.splice(0).map(socket => socket.readyState === WebSocket.CLOSED ? undefined : new Promise<void>(resolve => {
    socket.addEventListener('close', () => resolve(), { once: true }); socket.close();
  })));
  vi.restoreAllMocks(); await reset();
});
it.each([true, false])('notifies scoped Calendar Heartbeat receipts and catch-up commits with coalescing (published=%s)', async published => {
  const start = Date.parse('2030-11-16T10:00Z');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  expect((await request('/api/operator/monitors', 'POST', {
    name: 'Calendar job', kind: 'heartbeat', scheduleMode: 'calendar', cron: '* * * * *', published,
  })).status).toBe(201);
  const id = (await read()).monitor!.id;
  const publicView = await subscribe('public'), operator = await subscribe('operator');
  for (const minute of [2, 3]) {
    clock.mockReturnValue(start + minute * 60_000);
    expect((await request('/heartbeat/' + id, 'POST')).status).toBe(204);
  }
  await settle();
  expect(operator.messages).toEqual(['changed']);
  expect(publicView.messages).toEqual(published ? ['changed'] : []);
  expect((await read()).monitor).toMatchObject({ lastSeen: start + 180_000, lastResult: null });
  operator.socket.send('ack'); if (published) publicView.socket.send('ack'); await settle();
  expect(operator.messages).toEqual(['changed', 'changed']);
  operator.socket.send('ack'); if (published) publicView.socket.send('ack'); await settle();
  await evictDurableObject(env.MONITORING.getByName('personal'));
  clock.mockReturnValue(start + 210_001);
  await worker.scheduled(createScheduledController({ scheduledTime: Date.now() }), env);
  await settle();
  expect(operator.messages).toEqual(['changed', 'changed', 'changed']);
  expect(publicView.messages).toEqual(published ? ['changed', 'changed', 'changed'] : []);
  expect((await read()).monitor).toMatchObject({ state: 'up', history: { percentage: 2 / 3 * 100 } });
  expect((await read()).incidents).toMatchObject([{ openedAt: start + 90_000, closedAt: start + 210_000 }]);
  operator.socket.send('ack'); if (published) publicView.socket.send('ack'); await settle();
  expect(operator.messages).toEqual(['changed', 'changed', 'changed', 'changed']);
  expect(publicView.messages).toEqual(published ? ['changed', 'changed', 'changed', 'changed'] : []);
  operator.socket.send('ack'); if (published) publicView.socket.send('ack'); await settle();
  await worker.scheduled(createScheduledController({ scheduledTime: Date.now() }), env);
  await settle(); expect(operator.messages).toHaveLength(4);
  const publicStatus = await read(false);
  expect(publicStatus.monitors).toHaveLength(published ? 1 : 0);
  expect(JSON.stringify(publicStatus)).not.toMatch(/cron|graceSeconds|test-installation-secret/);
});
it.each(['PATCH', 'PUT'])('notifies after %s validation without overwriting concurrent receipts or settings', async method => {
  const start = Date.parse('2030-11-16T10:00Z');
  vi.spyOn(Date, 'now').mockReturnValue(start);
  await request('/api/operator/monitors', 'POST', {
    name: 'Job', kind: 'heartbeat', published: false, scheduleMode: 'calendar', cron: '*/5 * * * *', graceSeconds: 90,
  });
  const id = (await read()).monitor!.id;
  const path = '/api/operator/monitors/' + id;
  const publicView = await subscribe('public'), operator = await subscribe('operator');
  const format = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (this: Intl.DateTimeFormat, at) {
    if (++calls > 200_000) throw new Error('Repeated validation after concurrent changes');
    return format.call(this, at);
  });
  const saving = request(method === 'PATCH' ? path : '/api/operator', method, {
    ...(method === 'PUT' ? { pageName: 'Irisbeat', kind: 'heartbeat', name: 'Configured' } : {}),
    cron: '0-28/2,31-57/2 * * * *', timezone: 'Australia/Lord_Howe', graceSeconds: 60,
  });
  while (calls < 1024) await scheduler.wait(0);
  expect((await request('/heartbeat/' + id, 'POST')).status).toBe(204);
  expect((await request(path, 'PATCH', { name: 'Concurrent' })).status).toBe(200);
  expect(calls).toBeLessThan(10_000);
  await settle(); expect(operator.messages).toEqual(['changed']);
  operator.socket.send('ack'); await settle();
  operator.socket.send('ack'); await settle();
  expect((await saving).status).toBe(200);
  await settle();
  expect(operator.messages).toEqual(['changed', 'changed', 'changed']);
  expect(publicView.messages).toEqual([]);
  expect((await read()).monitor).toMatchObject({
    name: method === 'PATCH' ? 'Concurrent' : 'Configured', lastSeen: start, published: false,
    cron: '0-28/2,31-57/2 * * * *', timezone: 'Australia/Lord_Howe', graceSeconds: 60,
  });
});
