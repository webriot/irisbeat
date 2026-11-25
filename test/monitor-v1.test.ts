// SPDX-License-Identifier: AGPL-3.0-only
import worker, { createHostedWorker } from '../src/index';
import { env } from 'cloudflare:workers';
import { createScheduledController, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { captureNotifications } from './notification-queue';

const monitors = '/api/v1/monitors';
const operatorMonitors = '/api/operator/monitors';
const installationSecret = 'test-installation-secret';
const origin = 'https://irisbeat.example';
const bindings = {
  ...env,
  NOTIFICATION_PUBLIC_ORIGIN: origin,
  NOTIFICATION_EMAIL: { async isConfigured() { return true; } },
};
const request = (path: string, method = 'GET', body?: unknown, secret: string | null = installationSecret) => worker.fetch(
  new Request(origin + path, {
    method,
    headers: {
      ...(secret === null ? {} : { authorization: 'Bearer ' + secret }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), bindings,
);
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

async function issueApiKey(role: 'read' | 'write') {
  const response = await request('/api/operator/api-keys', 'POST', { name: 'Monitor automation', role });
  expect(response.status).toBe(201);
  return response.json<{ secret: string; key: { id: string } }>();
}

it('creates and imports a private HTTP Monitor using only its saved configuration', async () => {
  const response = await request(monitors, 'POST', {
    name: '  Service  ', url: 'https://EXAMPLE.org/health#fragment', published: false,
  });
  expect(response.status).toBe(201);
  const { id } = await response.clone().json() as { id: string };
  const configuration = {
    id, name: 'Service', kind: 'http', url: 'https://example.org/health', published: false,
    scheduleMode: 'interval', intervalSeconds: 60, timeoutSeconds: 10, failureThreshold: 2,
    recoveryThreshold: 2, destinationIds: [],
  };
  expect(response.headers.get('Location')).toBe(monitors + '/' + id);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual(configuration);
  const imported = await request(monitors + '/' + id);
  expect(imported.status).toBe(200);
  expect(await imported.json()).toEqual(configuration);
  expect(await (await request('/api/status', 'GET', undefined, null)).json()).toMatchObject({ monitors: [] });
});

it('creates and imports a Monitor with assignments using a Write API key', async () => {
  const destinationId = await createWebhook('primary');
  const { secret } = await issueApiKey('write');
  const response = await request(monitors, 'POST', {
    name: 'Backup', kind: 'heartbeat', destinationIds: [destinationId],
  }, secret);
  expect(response.status).toBe(201);
  const saved = await response.json<{ id: string; destinationIds: string[] }>();
  expect(saved.destinationIds).toEqual([destinationId]);
  expect(await (await request(monitors + '/' + saved.id, 'GET', undefined, secret)).json()).toEqual(saved);
});

async function createWebhook(name: string) {
  const response = await request('/api/operator/destinations', 'POST', { name, url: 'https://hooks.example/' + name });
  expect(response.status).toBe(201);
  const { destinations } = await response.json<{ destinations: { id: string; name: string }[] }>();
  return destinations.find(destination => destination.name === name)!.id;
}

it('imports a TCP Monitor after an Operator edit and preserves assignments on a partial update', async () => {
  const created = await request(monitors, 'POST', { name: 'Service', kind: 'tcp', hostname: 'ORIGIN.example', port: 443 });
  expect(created.status).toBe(201);
  const { id } = await created.json<{ id: string }>();
  const destination = await request('/api/operator/destinations', 'POST', { url: 'https://hooks.example/alerts' });
  expect(destination.status).toBe(201);
  const { destinations: [{ id: destinationId }] } = await destination.json<{ destinations: { id: string }[] }>();
  expect((await request(operatorMonitors + '/' + id, 'PATCH', {
    port: 8443, destinationIds: [destinationId],
  })).status).toBe(200);

  const path = monitors + '/' + id;
  const imported = {
    id, name: 'Service', kind: 'tcp', hostname: 'origin.example', port: 8443, published: true,
    scheduleMode: 'interval', intervalSeconds: 60, timeoutSeconds: 10, failureThreshold: 2,
    recoveryThreshold: 2, destinationIds: [destinationId],
  };
  expect(await (await request(path)).json()).toEqual(imported);
  const updated = await request(path, 'PATCH', { name: 'Edge', published: false });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toEqual({ ...imported, name: 'Edge', published: false });
  expect(await (await request(path)).json()).toEqual({ ...imported, name: 'Edge', published: false });
  expect(await (await request('/api/status', 'GET', undefined, null)).json()).toMatchObject({ monitors: [] });
});

it('replaces and clears assignments with assignment-only patches', async () => {
  const primary = await createWebhook('primary');
  const secondary = await createWebhook('secondary');
  const created = await request(monitors, 'POST', {
    name: 'Backup', kind: 'heartbeat', published: false, scheduleMode: 'calendar',
    cron: '0 3 * * *', graceSeconds: 120, destinationIds: [primary],
  });
  expect(created.status).toBe(201);
  const saved = await created.json<{ id: string }>();
  const path = monitors + '/' + saved.id;
  for (const destinationIds of [[secondary], []]) {
    const updated = await request(path, 'PATCH', { destinationIds });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ ...saved, destinationIds });
    expect(await (await request(path)).json()).toEqual({ ...saved, destinationIds });
  }
});

it('rejects invalid assignments without creating or changing a Monitor', async () => {
  const primary = await createWebhook('primary');
  const secondary = await createWebhook('secondary');
  const body = { name: 'Backup', kind: 'heartbeat', destinationIds: [primary] };
  const created = await request(monitors, 'POST', body);
  expect(created.status).toBe(201);
  const saved = await created.json<{ id: string }>();
  const path = monitors + '/' + saved.id;

  for (const destinationIds of [[secondary, 'missing'], [secondary, secondary], [secondary, 42], secondary, null]) {
    for (const [route, method] of [[monitors, 'POST'], [path, 'PATCH']]) {
      const rejected = await request(route, method, { ...body, name: 'Rejected', destinationIds });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ error: 'Invalid Monitor configuration' });
    }
  }
  expect(await (await request('/api/v1/status')).json()).toMatchObject({ monitors: [{ id: saved.id }] });
});

it('rejects pending email assignments atomically and accepts the same requests after confirmation', async () => {
  const notifications = await captureNotifications();
  const primary = await createWebhook('primary');
  const email = await request('/api/operator/destinations', 'POST', { channel: 'email', address: 'alerts@example.org' });
  expect(email.status).toBe(201);
  const { destinations: [, pending] } = await email.json<{ destinations: { id: string; confirmed?: boolean }[] }>();
  expect(pending.confirmed).toBe(false);

  const original = await request(monitors, 'POST', { name: 'Backup', kind: 'heartbeat', destinationIds: [primary] });
  expect(original.status).toBe(201);
  const saved = await original.json<{ id: string }>();
  const path = monitors + '/' + saved.id;
  const destinationIds = [pending.id, primary];
  const create = () => request(monitors, 'POST', { name: 'New job', kind: 'heartbeat', destinationIds });
  const update = () => request(path, 'PATCH', { name: 'Renamed', destinationIds });
  for (const rejected of [await create(), await update()]) {
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: 'An email destination is awaiting confirmation', code: 'destination_pending_confirmation',
    });
  }
  expect(await (await request('/api/v1/status')).json()).toMatchObject({ monitors: [{ id: saved.id }] });

  // Resolve the queued invitation as the delivery Worker does.
  const [job] = await notifications.confirmationJobs();
  const invitation = await env.MONITORING.get(env.MONITORING.idFromString(job.contextId)).resolveConfirmation(job);
  expect(invitation).toMatchObject({ address: 'alerts@example.org' });
  const link = new URL(invitation!.url);
  const token = link.hash.slice(1);
  link.hash = '';
  const confirmed = await worker.fetch(new Request(link, {
    method: 'POST', body: new URLSearchParams({ token }),
  }), bindings);
  expect(confirmed.status).toBe(200);

  const created = await create();
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({ name: 'New job', destinationIds });
  const updated = await update();
  expect(updated.status).toBe(200);
  expect(await updated.json()).toEqual({ ...saved, name: 'Renamed', destinationIds });
});

it('deletes a Heartbeat Monitor while preserving its Incident for Operators', async () => {
  const start = Date.UTC(2026, 10, 13);
  vi.spyOn(Date, 'now').mockReturnValue(start);
  const created = await request(monitors, 'POST', { name: 'Nightly job', kind: 'heartbeat' });
  expect(created.status).toBe(201);
  const { id } = await created.clone().json<{ id: string }>();
  expect(await created.json()).toEqual({
    id, name: 'Nightly job', kind: 'heartbeat', published: true, scheduleMode: 'interval',
    intervalSeconds: 60, silenceSeconds: 180, recoverySpacingSeconds: 60,
    recoveryThreshold: 2, destinationIds: [],
  });
  const path = monitors + '/' + id;
  const updated = await request(path, 'PATCH', { silenceSeconds: 60 });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({ id, silenceSeconds: 60 });
  const openedAt = start + 60_000;
  await worker.scheduled(createScheduledController({ scheduledTime: openedAt, cron: '* * * * *' }), env);

  const deleted = await request(path, 'DELETE');
  expect(deleted.status).toBe(204);
  expect(await deleted.text()).toBe('');
  for (const [method, body] of [['GET'], ['PATCH', { name: 'Unknown' }], ['DELETE']] as const)
    expect((await request(path, method, body)).status).toBe(404);
  expect((await request('/heartbeat/' + id, 'POST')).status).toBe(404);
  expect(await (await request('/api/operator')).json()).toMatchObject({
    monitors: [], incidents: [{ monitorId: id, monitorName: 'Nightly job', openedAt }],
  });
});

it('accepts Calendar timing and rejects invalid configuration changes atomically', async () => {
  const response = await request(monitors, 'POST', {
    name: 'Backup', kind: 'heartbeat', scheduleMode: 'calendar', cron: '0 3 * * *', graceSeconds: 120,
  });
  expect(response.status).toBe(201);
  const { id } = await response.clone().json<{ id: string }>();
  const configuration = {
    id, name: 'Backup', kind: 'heartbeat', published: true, scheduleMode: 'calendar',
    cron: '0 3 * * *', timezone: 'UTC', graceSeconds: 120, recoveryThreshold: 2, destinationIds: [],
  };
  expect(await response.json()).toEqual(configuration);

  const path = monitors + '/' + id;
  for (const body of [
    { kind: 'http', url: 'https://example.org' },
    { cron: 'bad schedule' },
    { silenceSeconds: 90 },
    { name: 'Unexpected', destinationChanges: {} },
  ]) expect((await request(path, 'PATCH', body)).status).toBe(400);
  expect(await (await request(path)).json()).toEqual(configuration);
  expect((await request(monitors, 'POST', { name: 'Invalid', url: 'ftp://example.org' })).status).toBe(400);
  expect(await (await request('/api/v1/status')).json()).toMatchObject({ monitors: [{ id }] });
});

it('accepts JSON media types with parameters and rejects lookalike types', async () => {
  const create = (contentType: string) => worker.fetch(new Request('https://irisbeat.example' + monitors, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + installationSecret, 'content-type': contentType },
    body: JSON.stringify({ name: 'Nightly job', kind: 'heartbeat' }),
  }), env);
  expect((await create('application/jsonp')).status).toBe(415);
  expect((await create('Application/JSON; charset=UTF-8')).status).toBe(201);
});

it('requires credentials, limits methods and keeps Monitor routes self-hosted', async () => {
  const resource = monitors + '/missing';
  for (const [path, method] of [
    [monitors, 'POST'], [resource, 'GET'], [resource, 'PATCH'], [resource, 'DELETE'],
  ]) {
    expect((await request(path, method, undefined, null)).status).toBe(401);
    expect((await request(path, method, undefined, 'invalid')).status).toBe(401);
  }
  for (const [path, allow] of [[monitors, 'POST'], [resource, 'GET, PATCH, DELETE']]) {
    const response = await request(path, 'PUT');
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe(allow);
  }
  expect((await request(monitors)).status).toBe(405);
  expect((await request(resource)).status).toBe(404);
  expect((await request(resource + '/')).status).toBe(404);
  expect((await request(monitors, 'POST')).status).toBe(415);
  expect((await request(monitors, 'POST', { name: 'x'.repeat(4096), kind: 'heartbeat' })).status).toBe(413);

  const hosted = createHostedWorker({
    contractVersion: '1',
    resolve: () => ({ id: 'hosted', permission: 'editor', monitorLimit: 10 }),
    contexts: () => [],
  });
  const url = 'https://hosted.example' + monitors;
  const { secret: writeSecret } = await issueApiKey('write');
  for (const secret of ['editor', installationSecret, writeSecret]) {
    const response = await hosted.fetch(new Request(url, { headers: { authorization: 'Bearer ' + secret } }), env);
    expect(response.status).toBe(404);
  }
});

it('allows Write API keys to reconcile configuration and forbids Read keys on every Monitor route', async () => {
  const read = await issueApiKey('read');
  const write = await issueApiKey('write');
  const body = { name: 'Private job', kind: 'heartbeat', published: false, destinationIds: [] };
  const created = await request(monitors, 'POST', body, write.secret);
  expect(created.status).toBe(201);
  const { id } = await created.json<{ id: string }>();
  const path = monitors + '/' + id;

  expect((await request('/api/v1/status', 'GET', undefined, read.secret)).status).toBe(200);
  for (const [route, method] of [
    [monitors, 'POST'], [path, 'GET'], [path, 'PATCH'], [path, 'DELETE'],
  ]) {
    const response = await request(route, method, undefined, read.secret);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
  }

  expect(await (await request(path, 'GET', undefined, write.secret)).json()).toMatchObject({ id, ...body });
  expect(await (await request(path, 'PATCH', { name: 'Renamed' }, write.secret)).json()).toMatchObject({
    id, name: 'Renamed',
  });
  expect((await request(path, 'DELETE', undefined, write.secret)).status).toBe(204);
  expect((await request('/api/operator/api-keys/' + write.key.id, 'DELETE')).status).toBe(204);
  const revoked = await request(path, 'GET', undefined, write.secret);
  expect(revoked.status).toBe(401);
  expect(revoked.headers.get('WWW-Authenticate')).toBe('Bearer');
});
