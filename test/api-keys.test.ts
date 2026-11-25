// SPDX-License-Identifier: AGPL-3.0-only
import worker, { createHostedWorker, type Status } from '../src/index';
import { env } from 'cloudflare:workers';
import { createScheduledController, evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';

const installation = 'test-installation-secret';
const keyPath = '/api/operator/api-keys';
const statusPath = '/api/v1/status';
const now = Date.UTC(2026, 10, 25);
const request = (path: string, token: string | null, method = 'GET', body?: unknown, app = worker) => app.fetch(
  new Request('https://irisbeat.example' + path, {
    method,
    headers: { ...(token === null ? {} : { authorization: 'Bearer ' + token }), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env,
);
type IssuedKey = {
  key: { id: string; name: string; role: 'read' | 'write'; createdAt: number; expiresAt: number | null };
  secret: string;
};
async function issue(body: { name: string; role: 'read' | 'write'; expiresAt?: number }) {
  const response = await request(keyPath, installation, 'POST', body);
  expect(response.status).toBe(201);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return response.json<IssuedKey>();
}

afterEach(async () => { vi.restoreAllMocks(); await reset(); });

it('issues named keys once, allows overlap, expires on time and revokes across eviction', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  expect(await (await request(keyPath, installation)).json()).toEqual({ keys: [] });
  const read = await issue({ name: ' Dashboard ', role: 'read' });
  const write = await issue({ name: 'Automation', role: 'write', expiresAt: now + 60_000 });
  expect(read).toEqual({
    key: { id: expect.any(String), name: 'Dashboard', role: 'read', createdAt: now, expiresAt: null },
    secret: expect.any(String),
  });
  expect(write).toEqual({
    key: { id: expect.any(String), name: 'Automation', role: 'write', createdAt: now, expiresAt: now + 60_000 },
    secret: expect.any(String),
  });
  expect(write.secret).not.toBe(read.secret);
  expect(write.key.id).not.toBe(read.key.id);

  await evictDurableObject(env.MONITORING.getByName('personal'));
  const { keys } = await (await request(keyPath, installation)).json<{ keys: IssuedKey['key'][] }>();
  expect(keys.sort((a, b) => a.name.localeCompare(b.name))).toEqual([write.key, read.key]);
  for (const token of [read.secret, write.secret, installation]) {
    expect((await request(statusPath, token)).status).toBe(200);
  }

  clock.mockReturnValue(now + 60_000);
  expect((await request(statusPath, write.secret)).status).toBe(401);
  const replacement = await issue({ name: 'Dashboard', role: 'read' });
  expect((await request(statusPath, read.secret)).status).toBe(200);
  expect((await request(statusPath, replacement.secret)).status).toBe(200);
  expect((await request(keyPath + '/' + read.key.id, installation, 'DELETE')).status).toBe(204);
  expect((await request(statusPath, read.secret)).status).toBe(401);
  expect((await request(statusPath, replacement.secret)).status).toBe(200);
  expect(await (await request(keyPath, installation)).json()).toEqual({ keys: [replacement.key, write.key] });
  expect((await request(keyPath + '/' + read.key.id, installation, 'DELETE')).status).toBe(404);
});

it('returns public fields and availability for active private Monitors without exposing them anonymously', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
  async function createMonitor(name: string, published: boolean) {
    const response = await request('/api/operator/monitors', installation, 'POST', {
      name, url: 'https://target.example/', kind: 'http', published, failureThreshold: 1,
    });
    expect(response.status).toBe(201);
    return (await response.json<Status>()).monitors.find(monitor => monitor.name === name)!.id;
  }
  const publishedId = await createMonitor('Published', true);
  const privateId = await createMonitor('Private', false);
  const deletedId = await createMonitor('Deleted', true);
  expect((await request('/api/operator/webhook', installation, 'PUT', { url: 'https://alerts.example/secret' })).status).toBe(200);
  await worker.scheduled(createScheduledController({ scheduledTime: now }), env);
  expect((await request('/api/operator/monitors/' + deletedId, installation, 'DELETE')).status).toBe(200);
  const operator = await (await request('/api/operator', installation)).json<Status>();
  expect(operator.incidents.some(incident => incident.monitorId === deletedId)).toBe(true);
  expect(operator.webhookUrl).toBe('https://alerts.example/secret');

  const anonymous = await (await request('/api/status', null)).json<Status>();
  expect(anonymous.monitors.map(monitor => monitor.id)).toEqual([publishedId]);
  expect(anonymous.incidents.map(incident => incident.monitorId)).toEqual([publishedId]);
  const { secret } = await issue({ name: 'Status client', role: 'read' });
  const response = await request(statusPath, secret);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const data = await response.json<Status>();
  expect(Object.keys(data).sort()).toEqual(Object.keys(anonymous).sort());
  expect(data.monitors.map(monitor => monitor.id)).toEqual([publishedId, privateId]);
  expect(data.monitors[0]).toEqual(anonymous.monitors[0]);
  expect(data.monitors[1]).toEqual({ ...anonymous.monitors[0], id: privateId, name: 'Private' });
  expect(data.monitors[1].history?.days.at(-1)).toEqual({
    date: '2026-11-25', state: 'down', successes: 0, failures: 1, maintenance: 0,
  });
  expect(data.incidents.map(incident => incident.monitorId).sort()).toEqual([publishedId, privateId].sort());
});

it('accepts case-insensitive Bearer schemes and multiple separator spaces on the new routes', async () => {
  const { secret } = await issue({ name: 'Dashboard', role: 'read' });
  const withHeader = (path: string, authorization: string) => worker.fetch(
    new Request('https://irisbeat.example' + path, { headers: { authorization } }), env,
  );
  expect((await withHeader(statusPath, 'bearer   ' + secret)).status).toBe(200);
  expect((await withHeader(statusPath, 'bEaReR  ' + installation)).status).toBe(200);
  expect((await withHeader(keyPath, 'bearer  ' + installation)).status).toBe(200);
  expect((await withHeader(statusPath, 'bearer  ' + secret.toUpperCase())).status).toBe(401);
  expect((await withHeader(keyPath, 'bearer  ' + secret)).status).toBe(401);
});

it('keeps API keys out of Operator, Heartbeat and hosted authorization', async () => {
  const heartbeat = await request('/api/operator/monitors', installation, 'POST', { name: 'Job', kind: 'heartbeat' });
  expect(heartbeat.status).toBe(201);
  const receiptPath = '/heartbeat/' + (await heartbeat.json<Status>()).monitor!.id;
  const read = await issue({ name: 'Dashboard', role: 'read' });
  const write = await issue({ name: 'Automation', role: 'write' });
  for (const token of [null, 'wrong-secret', 'irb_' + '0'.repeat(64)]) {
    const response = await request(statusPath, token);
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
  }
  for (const { secret, key } of [read, write]) {
    expect((await request('/api/operator', secret)).status).toBe(401);
    expect((await request('/api/operator', secret, 'PUT', { pageName: 'Denied' })).status).toBe(401);
    expect((await request(keyPath, secret)).status).toBe(401);
    expect((await request(keyPath, secret, 'POST', { name: 'Denied', role: 'write' })).status).toBe(401);
    expect((await request(keyPath + '/' + key.id, secret, 'DELETE')).status).toBe(401);
    expect((await request(receiptPath, secret, 'POST')).status).toBe(401);
  }
  expect((await request(receiptPath, installation, 'POST')).status).toBe(204);
  expect((await request('/api/operator', installation, 'PUT', { pageName: 'Irisbeat' })).status).toBe(200);

  const hosted = createHostedWorker({
    contractVersion: '1',
    resolve: request => ({
      id: 'personal', monitorLimit: 1,
      permission: request.headers.get('Authorization') === 'Bearer hosted-editor' ? 'editor' : null,
    }),
    contexts: () => ['personal'],
  });
  for (const token of [installation, read.secret, write.secret, 'hosted-editor']) {
    expect((await request(statusPath, token, 'GET', undefined, hosted)).status).toBe(404);
    expect((await request(keyPath, token, 'GET', undefined, hosted)).status).toBe(404);
  }
  expect((await request('/api/operator', write.secret, 'GET', undefined, hosted)).status).toBe(401);
  expect((await request('/api/operator', 'hosted-editor', 'GET', undefined, hosted)).status).toBe(200);
});

it('rejects invalid key creation without changing the inventory', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  for (const body of [
    null, [], { name: ' ', role: 'read' }, { name: 'a'.repeat(121), role: 'read' },
    { name: 'Client', role: 'admin' }, { name: 'Client', role: 'read', expiresAt: now },
    { name: 'Client', role: 'read', expiresAt: now + 0.5 }, { name: 'Client', role: 'read', expiresAt: String(now + 1) },
    { name: 'Client', role: 'read', expiresAt: null },
  ]) {
    expect((await request(keyPath, installation, 'POST', body)).status).toBe(400);
  }
  expect(await (await request(keyPath, installation)).json()).toEqual({ keys: [] });
});
