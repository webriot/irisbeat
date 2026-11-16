// SPDX-License-Identifier: AGPL-3.0-only
import worker from '../src/index';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';

const request = (path: string, method = 'GET', authenticated = true) => worker.fetch(
  new Request('https://irisbeat.example' + path, {
    method, headers: authenticated ? { authorization: 'Bearer test-installation-secret' } : {},
  }), env,
);
afterEach(reset);

it('preserves exact paths, unsupported methods, authentication order and response headers', async () => {
  for (const [path, method, authenticated, status, allow] of [
    ['/', 'GET', false, 200, null],
    ['/operator', 'GET', false, 200, null],
    ['/app.css', 'GET', false, 200, null],
    ['/theme.js', 'GET', false, 200, null],
    ['/operator.js', 'GET', false, 200, null],
    ['/api/status?refresh=1', 'GET', false, 200, null],
    ['/', 'HEAD', false, 404, null],
    ['/operator', 'POST', false, 404, null],
    ['/api/status', 'OPTIONS', false, 404, null],
    ['/operator/', 'GET', false, 404, null],
    ['/api/operator/', 'GET', false, 404, null],
    ['/api/operator/unknown/path', 'GET', false, 404, null],
    ['/api/operator', 'OPTIONS', false, 401, null],
    ['/api/operator', 'OPTIONS', true, 405, 'GET, PUT'],
    ['/api/operator', 'HEAD', true, 405, 'GET, PUT'],
    ['/api/operator/webhook', 'GET', true, 200, null],
    ['/api/operator/monitors', 'PUT', true, 405, 'GET, POST'],
    ['/api/operator/monitors/missing', 'GET', true, 405, 'PATCH, DELETE'],
    ['/api/operator/monitors/missing/maintenance', 'GET', true, 405, 'PUT, DELETE'],
    ['/api/operator/monitors/missing/heartbeat-secret', 'POST', true, 404, null],
    ['/heartbeat/', 'POST', false, 401, null],
    ['/heartbeat/', 'POST', true, 404, null],
    ['/heartbeat/missing', 'GET', false, 401, null],
    ['/heartbeat/missing', 'GET', true, 405, 'POST'],
    ['/heartbeat/missing/extra', 'POST', true, 404, null],
    ['/heartbeat', 'POST', true, 404, null],
  ] as const) {
    const response = await request(path, method, authenticated);
    expect({ path, method, status: response.status, allow: response.headers.get('Allow') }).toEqual({ path, method, status, allow });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  }
});

it('does not decode opaque Monitor IDs in routes or accept trailing path segments', async () => {
  const response = await worker.fetch(new Request('https://irisbeat.example/api/operator/monitors', {
    method: 'POST', headers: { authorization: 'Bearer test-installation-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Producer', kind: 'heartbeat' }),
  }), env);
  const { monitor } = await response.json() as { monitor: { id: string } };
  const encoded = '%' + monitor.id.charCodeAt(0).toString(16) + monitor.id.slice(1);
  expect((await request('/heartbeat/' + encoded, 'POST')).status).toBe(404);
  expect((await request('/api/operator/monitors/' + encoded, 'DELETE')).status).toBe(404);
  expect((await request('/api/operator/monitors/' + monitor.id + '/', 'DELETE')).status).toBe(404);
  expect((await request('/heartbeat/' + monitor.id, 'POST')).status).toBe(204);
});
