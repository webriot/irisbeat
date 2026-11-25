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

it('keeps API keys out of Operator and Heartbeat authorization', async () => {
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
      id: 'hosted-keys', monitorLimit: 1,
      permission: request.headers.get('Authorization') === 'Bearer hosted-editor' ? 'editor' : null,
    }),
    contexts: () => ['hosted-keys'],
  });
  for (const token of [installation, read.secret, write.secret]) {
    expect((await request(statusPath, token, 'GET', undefined, hosted)).status).toBe(401);
    expect((await request(keyPath, token, 'GET', undefined, hosted)).status).toBe(401);
  }
  expect((await request(statusPath, 'hosted-editor', 'GET', undefined, hosted)).status).toBe(401);
  expect(await (await request(keyPath, 'hosted-editor', 'GET', undefined, hosted)).json()).toEqual({ keys: [] });
  expect((await request('/api/operator', write.secret, 'GET', undefined, hosted)).status).toBe(401);
  expect((await request('/api/operator', 'hosted-editor', 'GET', undefined, hosted)).status).toBe(200);
});

it('lets a hosted editor manage one Product tenant’s Monitors with a Write key', async () => {
  const tenants = { 'a.example': 'tenant-a', 'b.example': 'tenant-b' } as const;
  const hosted = createHostedWorker({
    contractVersion: '1',
    resolve: incoming => {
      const id = tenants[new URL(incoming.url).hostname as keyof typeof tenants];
      if (!id) return null;
      const authorization = incoming.headers.get('Authorization');
      const permission = authorization === 'Bearer editor' ? 'editor' as const
        : authorization === 'Bearer reader' ? 'reader' as const : null;
      return { id, permission, monitorLimit: 1 };
    },
    contexts: () => [],
  });
  const call = (host: string, path: string, token: string | null, method = 'GET', body?: unknown, headers?: Record<string, string>) =>
    hosted.fetch(new Request(`https://${host}${path}`, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: 'Bearer ' + token }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);

  expect((await call('a.example', keyPath, 'reader')).status).toBe(403);
  expect((await call('a.example', keyPath, 'reader', 'POST', { name: 'Denied', role: 'write' })).status).toBe(403);
  expect((await call('a.example', keyPath, null)).status).toBe(401);
  const issued = await call('a.example', keyPath, 'editor', 'POST', { name: ' Automation ', role: 'write' });
  expect(issued.status).toBe(201);
  const write = await issued.json<IssuedKey>();
  expect(write).toMatchObject({ key: { name: 'Automation', role: 'write', expiresAt: null }, secret: expect.stringMatching(/^irb_[0-9a-f]{64}$/) });
  const inventory = await (await call('a.example', keyPath, 'editor')).json<{ keys: IssuedKey['key'][] }>();
  expect(inventory).toEqual({ keys: [write.key] });
  expect(JSON.stringify(inventory)).not.toContain(write.secret);
  const read = await (await call('a.example', keyPath, 'editor', 'POST', { name: 'Dashboard', role: 'read' })).json<IssuedKey>();

  const calendar = {
    name: 'Nightly', kind: 'heartbeat' as const, published: false, scheduleMode: 'calendar' as const,
    cron: '15 4 * * *', timezone: 'America/New_York', graceSeconds: 120,
  };
  const monitors = '/api/v1/monitors';
  const created = await call('a.example', monitors, write.secret, 'POST', calendar, { 'Idempotency-Key': 'nightly-1' });
  expect(created.status).toBe(201);
  const monitor = await created.json<{ id: string }>();
  expect(monitor).toMatchObject(calendar);
  const replay = await call('a.example', monitors, write.secret, 'POST', calendar, { 'Idempotency-Key': 'nightly-1' });
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(monitor);
  expect((await call('a.example', monitors, write.secret, 'POST', { ...calendar, name: 'Other' }, { 'Idempotency-Key': 'nightly-1' })).status).toBe(409);

  const path = monitors + '/' + monitor.id;
  expect((await call('a.example', statusPath, read.secret)).status).toBe(200);
  expect(await (await call('a.example', statusPath, read.secret)).json()).toMatchObject({
    monitors: [{ id: monitor.id, kind: 'heartbeat', name: 'Nightly' }],
  });
  expect((await call('a.example', path, read.secret, 'PATCH', { name: 'Changed' })).status).toBe(403);
  expect((await call('a.example', monitors, read.secret, 'POST', calendar)).status).toBe(403);
  const updated = await call('a.example', path, write.secret, 'PATCH', { graceSeconds: 90 });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({
    id: monitor.id, graceSeconds: 90, cron: calendar.cron, timezone: calendar.timezone, published: false,
  });

  expect((await call('b.example', path, write.secret, 'GET', undefined, { 'x-context-id': 'tenant-a' })).status).toBe(401);
  expect((await call('b.example', statusPath, read.secret)).status).toBe(401);
  expect(await (await call('b.example', keyPath, 'editor')).json()).toEqual({ keys: [] });
  expect((await call('a.example', monitors, installation, 'POST', calendar)).status).toBe(401);
  expect((await call('a.example', monitors, write.secret, 'POST', { ...calendar, name: 'Second' })).status).toBe(409);
  expect((await call('a.example', '/api/v1/destinations', write.secret, 'POST', { url: 'https://hooks.example/a' })).status).toBe(404);
  expect((await call('a.example', keyPath, write.secret, 'POST', { name: 'Nested', role: 'write' })).status).toBe(401);

  const rotated = await call('a.example', '/api/operator/monitors/' + monitor.id + '/heartbeat-secret', 'editor', 'POST');
  expect(rotated.status).toBe(200);
  const { secret } = await rotated.json<{ secret: string }>();
  for (const token of [installation, write.secret, read.secret]) {
    expect((await call('a.example', '/heartbeat', token, 'POST')).status).toBe(401);
  }
  expect((await call('a.example', '/heartbeat', secret, 'POST')).status).toBe(204);
  expect((await call('b.example', '/heartbeat', secret, 'POST')).status).toBe(401);

  expect((await call('a.example', path, write.secret, 'DELETE')).status).toBe(204);
  expect((await call('a.example', path, write.secret)).status).toBe(404);
  expect((await call('a.example', keyPath + '/' + write.key.id, 'editor', 'DELETE')).status).toBe(204);
  expect((await call('a.example', statusPath, write.secret)).status).toBe(401);
  expect(await (await call('a.example', keyPath, 'editor')).json()).toEqual({ keys: [read.key] });
  expect((await call('a.example', keyPath + '/' + read.key.id, 'reader', 'DELETE')).status).toBe(403);
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
