// SPDX-License-Identifier: AGPL-3.0-only
import { createHostedWorker } from '../src/index';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
const app = createHostedWorker({
  contractVersion: '1',
  resolve(request) {
    const host = new URL(request.url).hostname;
    if (!['a.example', 'b.example'].includes(host)) return null;
    const token = request.headers.get('authorization');
    return { id: host, permission: token === 'Bearer editor' ? 'editor' : token === 'Bearer reader' ? 'reader' : null, monitorLimit: 1 };
  },
  contexts: () => ['a.example', 'b.example'],
});
const request = (host: string, path: string, method = 'GET', body?: unknown, token = 'editor') => app.fetch(new Request('https://' + host + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-context-id': 'b.example' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
it('resolves only trusted hosts and isolates context names and operator access', async () => {
  expect((await request('unknown.example', '/api/status')).status).toBe(404);
  expect((await request('a.example', '/api/operator', 'PUT', { pageName: 'Tenant A' })).status).toBe(200);
  expect(await (await request('a.example', '/api/status')).json()).toMatchObject({ pageName: 'Tenant A' });
  expect(await (await request('b.example', '/api/status')).json()).toMatchObject({ pageName: 'Irisbeat', monitors: [] });
  expect((await request('a.example', '/api/operator', 'PUT', { pageName: 'Denied' }, 'reader')).status).toBe(403);
  expect((await request('a.example', '/api/operator', 'GET', undefined, 'unknown')).status).toBe(401);
});
it('counts private Monitors atomically, releases deleted slots and prevents legacy allowance bypass', async () => {
  const results = await Promise.all(Array.from({ length: 4 }, (_, i) => request('a.example', '/api/operator/monitors', 'POST', { name: 'Private ' + i, kind: 'heartbeat', published: false })));
  expect(results.map(r => r.status).sort()).toEqual([201, 409, 409, 409]);
  const saved = await (await request('a.example', '/api/operator')).json() as { monitors: { id: string }[] };
  expect(saved.monitors).toHaveLength(1);
  expect((await request('a.example', '/api/operator', 'PUT', { pageName: 'Bypass', name: 'Legacy', kind: 'heartbeat' })).status).toBe(400);
  await request('a.example', '/api/operator/monitors/' + saved.monitors[0].id, 'DELETE');
  expect((await request('a.example', '/api/operator/monitors', 'POST', { name: 'Replacement', kind: 'heartbeat' })).status).toBe(201);
  expect((await request('b.example', '/api/operator/monitors', 'POST', { name: 'Other context', kind: 'heartbeat' })).status).toBe(201);
});
it('filters credentials for readers and confines heartbeat credentials to their tenant with immediate rotation', async () => {
  await request('a.example', '/api/operator/monitors', 'POST', { name: 'Producer', kind: 'heartbeat' });
  const editor = await (await request('a.example', '/api/operator')).json() as { monitor: { id: string } };
  const path = '/api/operator/monitors/' + editor.monitor.id + '/heartbeat-secret';
  await request('a.example', '/api/operator/webhook', 'PUT', { url: 'https://alerts.example/private-token' });
  const reader = await (await request('a.example', '/api/operator', 'GET', undefined, 'reader')).json();
  expect(JSON.stringify(reader)).not.toContain('private-token');
  expect((await request('a.example', path, 'POST', undefined, 'reader')).status).toBe(403);
  const rotated = await request('a.example', path, 'POST');
  expect(rotated.status).toBe(200);
  const { secret } = await rotated.json() as { secret: string };
  expect(secret.length).toBeGreaterThanOrEqual(32);
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { producer = controller; controller.enqueue(new Uint8Array([1])); } });
  try {
    expect((await app.fetch(new Request('https://a.example/heartbeat', { method: 'POST', headers: { authorization: 'Bearer ' + secret }, body }), env)).status).toBe(204);
  } finally { producer.close(); }
  expect((await request('b.example', '/heartbeat', 'POST', undefined, secret)).status).toBe(401);
  expect((await request('a.example', '/heartbeat/' + editor.monitor.id, 'POST', undefined, 'test-installation-secret')).status).toBe(404);
  const replacement = await (await request('a.example', path, 'POST')).json() as { secret: string };
  expect(replacement.secret).not.toBe(secret);
  expect((await request('a.example', '/heartbeat', 'POST', undefined, secret)).status).toBe(401);
  const { evictDurableObject } = await import('cloudflare:test');
  await evictDurableObject(env.MONITORING.getByName('a.example'));
  expect((await request('a.example', '/heartbeat', 'POST', undefined, replacement.secret)).status).toBe(204);
  for (const token of ['editor', 'reader', 'unknown']) {
    const response = await request('a.example', token === 'unknown' ? '/api/status' : '/api/operator', 'GET', undefined, token);
    const text = await response.text();
    expect(text).not.toContain(secret); expect(text).not.toContain(replacement.secret);
  }
  await request('a.example', '/api/operator/monitors/' + editor.monitor.id, 'DELETE');
  expect((await request('a.example', '/heartbeat', 'POST', undefined, replacement.secret)).status).toBe(401);
});
it('rejects unsupported contract versions before serving requests', () => {
  expect(() => createHostedWorker({ contractVersion: '2', resolve: () => null, contexts: () => [] })).toThrow('Unsupported Irisbeat contract version');
});
it('exposes hosted capabilities for the existing operator ledger without exposing credentials in assets', async () => {
  expect(await (await request('a.example', '/api/operator')).json()).toMatchObject({ hosted: true, permission: 'editor' });
  expect(await (await request('a.example', '/api/operator', 'GET', undefined, 'reader')).json()).toMatchObject({ hosted: true, permission: 'reader' });
  expect(await (await request('a.example', '/operator')).text()).toContain('Access token');
});
it('fails closed when an adapter returns an invalid allowance', async () => {
  const invalid = createHostedWorker({ contractVersion: '1', resolve: () => ({ id: 'a.example', permission: 'editor', monitorLimit: -1 }), contexts: () => [] });
  expect((await invalid.fetch(new Request('https://a.example/api/operator'), env)).status).toBe(500);
});
it('denies every mutation to readers and keeps public names and destinations isolated after eviction', async () => {
  await request('a.example', '/api/operator', 'PUT', { pageName: 'A only' });
  await request('a.example', '/api/operator/monitors', 'POST', { name: 'Private producer', kind: 'heartbeat', published: false });
  const data = await (await request('a.example', '/api/operator')).json() as { monitor: { id: string } };
  const path = '/api/operator/monitors/' + data.monitor.id;
  for (const [url, method, body] of [
    ['/api/operator/monitors', 'POST', { name: 'Denied', kind: 'heartbeat' }],
    [path, 'PATCH', { name: 'Denied' }], [path, 'DELETE', undefined],
    ['/api/operator/webhook', 'PUT', { url: 'https://alerts.example/denied' }],
    ['/api/operator', 'PUT', { pageName: 'Denied' }],
  ] as const) expect((await request('a.example', url, method, body, 'reader')).status).toBe(403);
  expect((await request('b.example', path, 'DELETE')).status).toBe(404);
  const { evictDurableObject } = await import('cloudflare:test');
  await evictDurableObject(env.MONITORING.getByName('a.example'));
  expect(await (await request('a.example', '/api/operator', 'GET', undefined, 'reader')).json()).toMatchObject({ pageName: 'A only', monitors: [{ name: 'Private producer' }] });
  expect(await (await request('a.example', '/api/status')).json()).toMatchObject({ pageName: 'A only', monitors: [] });
  expect(await (await request('b.example', '/api/status')).json()).toMatchObject({ pageName: 'Irisbeat', monitors: [] });
});

it('restricts Maintenance to context editors and preserves hosted metadata and reader destination filtering', async () => {
  const now = Date.UTC(2026, 10, 13);
  vi.spyOn(Date, 'now').mockReturnValue(now);
  await request('a.example', '/api/operator/monitors', 'POST', { name: 'Producer', kind: 'heartbeat', published: false });
  const saved = await (await request('a.example', '/api/operator')).json() as { monitor: { id: string } };
  const path = '/api/operator/monitors/' + saved.monitor.id + '/maintenance';
  expect((await request('a.example', path, 'PUT', { endsAt: now + 60_000 }, 'reader')).status).toBe(403);
  expect((await request('a.example', path, 'DELETE', undefined, 'reader')).status).toBe(403);
  expect((await request('b.example', path, 'PUT', { endsAt: now + 60_000 })).status).toBe(404);
  expect(await (await request('a.example', path, 'PUT', { endsAt: now + 60_000 })).json()).toMatchObject({ hosted: true, permission: 'editor', monitor: { state: 'maintenance' } });
  await request('a.example', '/api/operator/webhook', 'PUT', { url: 'https://alerts.example/private-destination' });
  const reader = await request('a.example', '/api/operator', 'GET', undefined, 'reader');
  const data = await reader.text();
  expect(data).toContain('maintenance');
  expect(data).not.toContain('private-destination');
  expect(await (await request('a.example', '/api/status')).json()).toMatchObject({ monitors: [] });
  expect(await (await request('a.example', path, 'DELETE')).json()).toMatchObject({ hosted: true, permission: 'editor', monitor: { maintenance: null } });
});
