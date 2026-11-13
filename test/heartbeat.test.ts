// SPDX-License-Identifier: AGPL-3.0-only
import worker from '../src/index';
import { env, exports } from 'cloudflare:workers';
import { createScheduledController, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
const start = Date.UTC(2026, 10, 13);
const authorization = 'Bearer test-installation-secret';
const request = (path: string, init?: RequestInit) => exports.default.fetch(`https://irisbeat.example${path}`, init);
const configure = (extra = {}) => request('/api/operator', { method: 'PUT', headers: { authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ pageName: 'Status', name: 'Watchdog', kind: 'heartbeat', ...extra }) });
const status = async (): Promise<import('../src/index').Status> => (await request('/api/status')).json();
async function tick(offset: number) { await worker.scheduled(createScheduledController({ scheduledTime: start + offset, cron: '* * * * *' }), env); }
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
it('opens initial and ongoing silence only on scheduled evaluation with Watchdog defaults', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  expect(await (await configure()).json()).toMatchObject({ monitor: { kind: 'heartbeat', intervalSeconds: 60, silenceSeconds: 180, recoverySpacingSeconds: 60, recoveryThreshold: 2 } });
  await tick(179_999);
  expect((await status()).incidents).toEqual([]);
  await tick(180_000);
  expect(await status()).toMatchObject({ monitor: { state: 'down', lastResult: { at: start + 180_000, outcome: 'failure' } }, incidents: [{ openedAt: start + 180_000, closedAt: null }] });
  await tick(600_000);
  expect((await status()).incidents).toHaveLength(1);
});
it('authenticates receipts, ignores bodies, and requires spaced recovery after ongoing silence', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await configure();
  const receipt = (id = 'website', token = authorization, body?: BodyInit) => request('/heartbeat/' + id, { method: 'POST', headers: { authorization: token }, body });
  expect((await receipt('website', 'Bearer wrong')).status).toBe(401);
  expect((await receipt('unknown')).status).toBe(404);
  expect((await status()).monitor).toMatchObject({ lastSeen: null });
  expect((await receipt('website', authorization, 'not JSON'.repeat(1000))).status).toBe(204);
  expect((await status()).monitor).toMatchObject({ lastSeen: start, state: 'up' });
  clock.mockReturnValue(start + 180_000);
  expect((await status()).incidents).toEqual([]);
  await tick(180_000);
  clock.mockReturnValue(start + 200_000);
  await receipt();
  await receipt();
  clock.mockReturnValue(start + 259_999);
  await receipt();
  expect((await status()).monitor?.state).toBe('down');
  clock.mockReturnValue(start + 260_000);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); } });
  expect((await receipt('website', authorization, stream)).status).toBe(204);
  expect(await status()).toMatchObject({ monitor: { state: 'up', lastSeen: start + 260_000 }, incidents: [{ openedAt: start + 180_000, closedAt: start + 260_000 }] });
  clock.mockReturnValue(start + 430_000);
  await receipt('website', 'Bearer wrong');
  await receipt('unknown');
  await tick(440_000);
  expect((await status()).incidents).toHaveLength(2);
});
it('preserves history and freshness through prospective timing edits and validates heartbeat controls', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  await configure();
  await tick(180_000);
  const receipt = () => request('/heartbeat/website', { method: 'POST', headers: { authorization } });
  clock.mockReturnValue(start + 200_000);
  await receipt();
  const before = await status();
  await configure({ silenceSeconds: 300, recoverySpacingSeconds: 120, recoveryThreshold: 3 });
  expect(await status()).toEqual(before);
  clock.mockReturnValue(start + 260_000);
  await receipt();
  expect((await status()).monitor?.state).toBe('down');
  await configure({ recoveryThreshold: 2 });
  expect((await status()).incidents[0].closedAt).toBeNull();
  clock.mockReturnValue(start + 320_000);
  await receipt();
  expect((await status()).incidents[0].closedAt).toBe(start + 320_000);
  for (const field of ['silenceSeconds', 'recoverySpacingSeconds']) {
    for (const invalid of [59, 86401, null, '60', 60.5]) {
      expect((await configure({ [field]: invalid })).status).toBe(400);
    }
  }
  expect((await request('/heartbeat/website', { headers: { authorization } })).status).toBe(405);
  const html = await (await request('/operator')).text();
  expect(html).toContain('<option value="heartbeat">Heartbeat</option>');
  expect(html).toContain('id="silenceSeconds"');
  expect(html).toContain('id="recoverySpacingSeconds"');
  expect(await (await request('/')).text()).toContain('Watchdog');
});
