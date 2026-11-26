// SPDX-License-Identifier: AGPL-3.0-only
import { createHostedWorker, type Status } from '../src/index';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';

const tenantA = 'a.example';
const tenantB = 'b.example';
const secretA = 'test-tenant-a-secret';
const secretB = 'test-tenant-b-secret';
const keys = '/api/operator/api-keys';
const status = '/api/v1/status';
const monitors = '/api/v1/monitors';
const destinations = '/api/v1/destinations';
const app = createHostedWorker({
  contractVersion: '1',
  resolve(request) {
    const id = new URL(request.url).hostname;
    if (id !== tenantA && id !== tenantB) return null;
    const token = request.headers.get('Authorization');
    const permission = token === 'Bearer account-editor' ? 'editor' : token === 'Bearer account-reader' ? 'reader' : null;
    return { id, permission, monitorLimit: 1, installationSecret: id === tenantA ? secretA : secretB };
  },
  contexts: () => [tenantA, tenantB],
});

const request = (host: string, path: string, token: string, method = 'GET', body?: unknown, idempotencyKey?: string) => app.fetch(
  new Request('https://' + host + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env,
);

afterEach(async () => { await reset(); });

async function issue(role: 'read' | 'write') {
  const issued = await request(tenantA, keys, secretA, 'POST', { name: role, role });
  expect(issued.status).toBe(201);
  return issued.json<{ key: { id: string; role: string }; secret: string }>();
}

it('administers tenant API keys with the tenant installation secret', async () => {
  const read = await issue('read');
  const write = await issue('write');
  const response = await request(tenantA, keys, secretA);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ keys: expect.arrayContaining([read.key, write.key]) });
  expect(await (await request(tenantB, keys, secretB)).json()).toEqual({ keys: [] });
  expect((await request(tenantB, keys, secretA)).status).toBe(401);
  expect((await request(tenantA, keys, write.secret)).status).toBe(401);
  expect((await request(tenantA, status, read.secret)).status).toBe(200);
  expect((await request(tenantB, status, read.secret)).status).toBe(401);
  expect((await request(tenantB, keys + '/' + read.key.id, secretB, 'DELETE')).status).toBe(404);
  expect((await request(tenantA, keys + '/' + read.key.id, secretA, 'DELETE')).status).toBe(204);
  expect((await request(tenantA, status, read.secret)).status).toBe(401);
  expect((await request(tenantA, status, write.secret)).status).toBe(200);
});

it('enforces the Monitor allowance atomically and replays creates at capacity', async () => {
  const { secret: write } = await issue('write');
  const { secret: read } = await issue('read');
  const candidates = ['Primary', 'Backup'].map(name => ({ name, url: 'https://target.example/', published: false }));
  const responses = await Promise.all(candidates.map((body, index) =>
    request(tenantA, monitors, write, 'POST', body, 'monitor-' + index)));
  expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
  const winner = responses.findIndex(response => response.status === 201);
  expect(await responses[1 - winner].json()).toEqual({ error: 'Monitor allowance reached' });
  const created = await responses[winner].json<{ id: string; name: string }>();
  const body = candidates[winner];
  const key = 'monitor-' + winner;
  const path = monitors + '/' + created.id;
  expect(responses[winner].headers.get('Location')).toBe(path);
  expect(created).toMatchObject(body);

  const retry = await request(tenantA, monitors, write, 'POST', body, key);
  expect(retry.status).toBe(201);
  expect(retry.headers.get('Location')).toBe(path);
  expect(await retry.json()).toEqual(created);
  const conflict = await request(tenantA, monitors, write, 'POST', { ...body, name: 'Changed' }, key);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: 'Idempotency-Key was already used for a different request' });

  const visible = await (await request(tenantA, status, read)).json<Status>();
  expect(visible.monitors.map(monitor => monitor.id)).toEqual([created.id]);
  expect((await request(tenantA, monitors, read, 'POST', body, key)).status).toBe(403);
  expect((await request(tenantA, path, read, 'PATCH', { name: 'Denied' })).status).toBe(403);
  expect((await request(tenantB, path, write, 'DELETE')).status).toBe(401);
  expect((await request(tenantB, path, secretB)).status).toBe(404);
  const other = await request(tenantB, monitors, secretB, 'POST', { ...body, name: 'Other tenant' }, key);
  expect(other.status).toBe(201);
  const otherMonitor = await other.json<{ id: string; name: string }>();
  expect(otherMonitor.name).toBe('Other tenant');
  expect(otherMonitor.id).not.toBe(created.id);

  expect(await (await request(tenantA, path, write)).json()).toEqual(created);
  expect(await (await request(tenantA, path, write, 'PATCH', { name: 'Edited' })).json()).toEqual({ ...created, name: 'Edited' });
  expect((await request(tenantA, path, write, 'DELETE')).status).toBe(204);
  expect((await request(tenantA, path, write)).status).toBe(404);
  expect((await request(tenantA, monitors, write, 'POST', candidates[1 - winner], 'monitor-' + (1 - winner))).status).toBe(201);
});

it('allows a tenant Write key to reconcile destinations and retry creates', async () => {
  const { secret: write } = await issue('write');
  const { secret: read } = await issue('read');
  const body = { name: 'Alerts', url: 'https://hooks.example/alerts' };
  const key = 'destination-create';
  const response = await request(tenantA, destinations, write, 'POST', body, key);
  expect(response.status).toBe(201);
  const created = await response.json<{ id: string }>();
  expect(created).toMatchObject({ ...body, channel: 'webhook' });
  const path = destinations + '/' + created.id;

  const edited = { ...created, name: 'Edited' };
  const patch = await request(tenantA, path, write, 'PATCH', { name: edited.name });
  expect(patch.status).toBe(200);
  expect(await patch.json()).toEqual(edited);
  expect(await (await request(tenantA, path, write)).json()).toEqual(edited);
  const replay = await request(tenantA, destinations, write, 'POST', body, key);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(created);
  expect((await request(tenantA, destinations, write, 'POST', { ...body, name: 'Changed' }, key)).status).toBe(409);
  expect((await request(tenantA, path, read)).status).toBe(403);
  expect((await request(tenantB, path, write, 'DELETE')).status).toBe(401);
  expect((await request(tenantB, path, secretB)).status).toBe(404);
  expect((await request(tenantA, path, write, 'DELETE')).status).toBe(204);
  expect((await request(tenantA, path, write)).status).toBe(404);
});

it('keeps Accounts authorization independent of hosted automation and ignores the Worker secret', async () => {
  const { secret: write } = await issue('write');
  const operator = '/api/operator';
  for (const credential of [env.INSTALLATION_SECRET, secretA, write]) {
    expect((await request(tenantA, operator, credential)).status).toBe(401);
    expect((await request(tenantA, operator, credential, 'PUT', { pageName: 'Denied' })).status).toBe(401);
  }
  for (const credential of [env.INSTALLATION_SECRET, 'account-editor']) {
    expect((await request(tenantA, keys, credential)).status).toBe(401);
    const denied = await request(tenantA, status, credential);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('WWW-Authenticate')).toBe('Bearer');
  }
  expect((await request('unknown.example', status, secretA)).status).toBe(404);
  expect((await request(tenantA, operator, 'account-editor', 'PUT', { pageName: 'Tenant A' })).status).toBe(200);
  const reader = await request(tenantA, operator, 'account-reader');
  expect(reader.status).toBe(200);
  expect(await reader.json()).toMatchObject({ pageName: 'Tenant A', hosted: true, permission: 'reader' });
  expect((await request(tenantA, operator, 'account-reader', 'PUT', { pageName: 'Denied' })).status).toBe(403);
});

it.each([null, 123, '', '   ', 'token\n'])('fails closed for an invalid configured secret %j', async installationSecret => {
  const invalid = createHostedWorker({
    contractVersion: '1',
    resolve: () => ({ id: tenantA, monitorLimit: 1, permission: null, installationSecret: installationSecret as string }),
    contexts: () => [],
  });
  const response = await invalid.fetch(new Request('https://' + tenantA + status, {
    headers: { Authorization: 'Bearer ' + env.INSTALLATION_SECRET },
  }), env);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'Internal server error' });
});
