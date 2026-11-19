// SPDX-License-Identifier: AGPL-3.0-only
import { createHostedWorker, type Status } from '../src/index';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';

const partials = '/api/operator/partials';
const worker = createHostedWorker({
  contractVersion: '1',
  resolve: request => ({
    id: 'operator-partials', monitorLimit: 10,
    permission: request.headers.get('Authorization') === 'Bearer editor' ? 'editor'
      : request.headers.get('Authorization') === 'Bearer reader' ? 'reader' : null,
  }),
  contexts: () => [],
});
const request = (path: string, role = 'editor', method = 'GET', body?: unknown) => worker.fetch(
  new Request('https://tenant.example' + path, {
    method, headers: { Authorization: 'Bearer ' + role, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);

afterEach(async () => { await reset(); });

it('reads the requested Operator sections at one revision and only includes authorized data', async () => {
  const created = await request('/api/operator/monitors', 'editor', 'POST', {
    name: 'Private Heartbeat', kind: 'heartbeat', published: false,
  });
  const id = ((await created.json()) as Status).monitors[0].id;
  await request('/api/operator/webhook', 'editor', 'PUT', { url: 'https://example.com/private' });
  const batch = partials + '?revision=2&scope=page&scope=monitor/' + id + '&scope=monitors&scope=destinations';
  expect((await request(batch, 'anonymous')).status).toBe(401);
  const response = await request(batch);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toMatchObject({
    revision: 2, permission: 'editor',
    partials: [
      { scope: 'page', data: { pageName: 'Irisbeat' } },
      { scope: 'monitors', data: { monitors: [{ id, name: 'Private Heartbeat' }] } },
      { scope: 'destinations', data: { destinations: [{ url: 'https://example.com/private' }] } },
    ],
  });
  expect((await request(batch, 'reader')).status).toBe(404);
  const readable = partials + '?revision=1&scope=monitor/' + id + '&scope=monitor/missing&scope=incidents';
  const reader = await request(readable, 'reader');
  expect(reader.headers.get('Cache-Control')).toBe('no-store');
  const data = await reader.json();
  expect(data).toMatchObject({
    revision: 1, permission: 'reader',
    partials: [
      { scope: 'monitor/' + id, data: { monitors: [{ id }] } },
      { scope: 'monitor/missing', data: { html: '', monitors: [] } },
      { scope: 'incidents', data: { html: '<p>No Incidents</p>' } },
    ],
  });
  expect(JSON.stringify(data)).not.toContain('destinationIds');
  expect((await request(readable.replace('revision=1', 'revision=2'), 'reader')).status).toBe(409);
  expect((await request(partials + '?scope=page&scope=invalid')).status).toBe(404);
  expect((await request(partials + '?scope=page&revision=-1')).status).toBe(400);
  expect(await (await request(partials + '/monitor/' + id, 'reader')).json()).toMatchObject({
    revision: 1, permission: 'reader', monitors: [{ id }],
  });
});
