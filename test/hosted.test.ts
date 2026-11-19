// SPDX-License-Identifier: AGPL-3.0-only
import { createHostedWorker, type Status } from '../src/index';
import { env } from 'cloudflare:workers';
import { createScheduledController, evictDurableObject, reset } from 'cloudflare:test';
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
it('accepts exactly one concurrent Calendar Heartbeat creation at the hosted Monitor allowance after yielding validation', async () => {
  const start = Date.UTC(2026, 10, 16);
  vi.spyOn(Date, 'now').mockReturnValue(start);
  const wait = scheduler.wait.bind(scheduler);
  let release!: () => void;
  const validation = new Promise<void>(resolve => { release = resolve; });
  let yields = 0, finished = 0;
  vi.spyOn(scheduler, 'wait').mockImplementation(async (delay, options) => {
    if (++yields > 1000) throw new Error('Unbounded grace validation');
    await validation;
    await wait(delay, options);
  });
  const pending = ['First', 'Second'].map(name => request('a.example', '/api/operator/monitors', 'POST', {
    name, kind: 'heartbeat', published: false, scheduleMode: 'calendar',
    cron: '0-28/2,31-57/2 * * * *', timezone: 'Australia/Lord_Howe', graceSeconds: 60,
  }).then(response => { finished++; return response; }));
  try {
    for (let attempts = 0; yields < 2 && attempts < 100; attempts++) await wait(0);
    // Each request is held at its first yield, so neither can commit before both validate.
    expect(yields).toBe(2);
    expect(finished).toBe(0);
    expect(await (await request('a.example', '/api/operator')).json()).toMatchObject({ monitors: [] });
  } finally { release(); }
  const responses = await Promise.all(pending);
  expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
  expect(await responses.find(response => response.status === 409)!.json()).toEqual({ error: 'Monitor allowance reached' });
  const accepted = await responses.find(response => response.status === 201)!.json() as Status;
  expect(accepted.monitors).toHaveLength(1);
  const winner = responses.findIndex(response => response.status === 201);
  expect(accepted.monitor).toMatchObject({ name: ['First', 'Second'][winner], kind: 'heartbeat', published: false, graceSeconds: 60 });
  await evictDurableObject(env.MONITORING.getByName('a.example'));
  expect(await (await request('a.example', '/api/operator')).json()).toEqual(accepted);
  expect(await (await request('a.example', '/api/status')).json()).toMatchObject({ monitors: [] });
  await app.scheduled(createScheduledController({ scheduledTime: start + 180_001 }), env);
  const observed = await (await request('a.example', '/api/operator')).json() as Status;
  expect(observed.monitors).toHaveLength(1);
  expect(observed.monitor).toMatchObject({ id: accepted.monitor!.id, lastResult: { at: start + 180_000, outcome: 'failure' } });
  expect(observed.incidents).toMatchObject([{ monitorId: accepted.monitor!.id, openedAt: start + 180_000, closedAt: null }]);
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
it('reports hosted editor and reader access and labels the hosted sign-in field', async () => {
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

it('preserves hosted method responses and reader authorization before dispatch', async () => {
  for (const [path, method, token, status, allow] of [
    ['/heartbeat', 'GET', 'unknown', 405, 'POST'],
    ['/heartbeat/', 'POST', 'editor', 404, null],
    ['/heartbeat/missing', 'GET', 'unknown', 404, null],
    ['/api/operator', 'HEAD', 'reader', 403, null],
    ['/api/operator/monitors/missing/heartbeat-secret', 'GET', 'reader', 405, 'POST'],
    ['/api/operator/monitors/missing/heartbeat-secret', 'POST', 'unknown', 401, null],
    ['/api/operator/monitors/missing/heartbeat-secret', 'PUT', 'editor', 405, 'POST'],
  ] as const) {
    const response = await request('a.example', path, method, undefined, token);
    expect({ path, method, status: response.status, allow: response.headers.get('Allow') }).toEqual({ path, method, status, allow });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  }
});

it('returns the existing sanitized failure for adapter exceptions', async () => {
  for (const thrown of [new Error('private adapter detail'), 'private adapter detail']) {
    const failing = createHostedWorker({ contractVersion: '1', resolve: () => { throw thrown; }, contexts: () => [] });
    const response = await failing.fetch(new Request('https://a.example/api/status'), env);
    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  }
});
