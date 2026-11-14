// SPDX-License-Identifier: AGPL-3.0-only
import { createHostedWorker, type Status } from '../src/index';
import { env } from 'cloudflare:workers';
import { reset, evictDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';

const pause = new Map<string, boolean>();
const revisions = new Map<string, { paused: boolean; policyRevision: number }>();
const app = createHostedWorker({
  contractVersion: '1',
  resolve(request) {
    const id = new URL(request.url).hostname;
    if (!['a.example', 'b.example'].includes(id)) return null;
    const token = request.headers.get('authorization');
    const identity = { id, permission: token === 'Bearer editor' ? 'editor' as const : token === 'Bearer reader' ? 'reader' as const : null, monitorLimit: 10 };
    const paused = pause.get(id);
    if (paused === undefined) return identity;
    const prior = revisions.get(id);
    const policy = prior?.paused === paused ? prior : { paused, policyRevision: (prior?.policyRevision ?? -1) + 1 };
    revisions.set(id, policy);
    return { ...identity, ...policy };
  },
  contexts: () => ['a.example', 'b.example'],
});
const request = (path: string, method = 'GET', body?: unknown, host = 'a.example', token = 'editor') => app.fetch(new Request('https://' + host + path, {
  method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-paused': 'false', 'x-context-id': 'b.example' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), env);
const status = async (host = 'a.example') => await (await request('/api/operator', 'GET', undefined, host)).json() as Status;
const tick = (at: number) => app.scheduled({ scheduledTime: at } as ScheduledController, env);
afterEach(async () => { pause.clear(); revisions.clear(); vi.restoreAllMocks(); await reset(); });

it('pauses trusted contexts without outbound observations, preserves history and resumes with zero counts', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(0);
  const target = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
  await request('/api/operator/monitors', 'POST', { name: 'Website', url: 'https://target.example/' });
  await tick(0);
  const before = await status();
  pause.set('a.example', true);
  expect(await status()).toMatchObject({ paused: true, monitor: { state: 'paused' } });
  await evictDurableObject(env.MONITORING.getByName('a.example'));
  pause.delete('a.example');
  await tick(60_000); await tick(120_000);
  expect(target).toHaveBeenCalledTimes(1);
  expect((await status()).monitor?.history).toEqual(before.monitor?.history);
  expect(await (await request('/')).text()).toContain('Monitoring paused');
  expect(await status('b.example')).toMatchObject({ paused: false });
  pause.set('a.example', false);
  await status();
  await tick(180_000);
  expect((await status()).incidents).toHaveLength(0);
  await tick(240_000);
  expect((await status()).incidents).toHaveLength(1);
});

it('accepts paused heartbeat freshness without history, freezes Incidents and restarts recovery spacing', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
  await request('/api/operator/monitors', 'POST', { name: 'Producer', kind: 'heartbeat', silenceSeconds: 60 });
  const id = (await status()).monitor!.id;
  const { secret } = await (await request('/api/operator/monitors/' + id + '/heartbeat-secret', 'POST')).json() as { secret: string };
  const receipt = (host = 'a.example') => request('/heartbeat', 'POST', undefined, host, secret);
  await tick(60_000);
  const incident = (await status()).incidents[0];
  clock.mockReturnValue(70_000); await receipt();
  const before = await status();
  pause.set('a.example', true);
  clock.mockReturnValue(86_400_000);
  expect((await receipt()).status).toBe(204);
  expect((await receipt('b.example')).status).toBe(401);
  await tick(86_400_000);
  let current = await status();
  expect(current.monitor).toMatchObject({ state: 'paused', lastSeen: 86_400_000, lastResult: before.monitor!.lastResult });
  expect(current.monitor!.history!.days.at(-1)).toMatchObject({ state: 'empty', successes: 0, failures: 0, maintenance: 0 });
  expect(current.monitor!.history!.percentage).toBe(before.monitor!.history!.percentage);
  expect(current.incidents).toEqual(before.incidents);
  pause.set('a.example', false); await status();
  await tick(86_400_000);
  expect((await status()).incidents[0]).toEqual(incident);
  clock.mockReturnValue(86_401_000); await receipt();
  // Repeated explicit resume metadata must not reset this first recovery receipt.
  clock.mockReturnValue(86_401_001); await receipt();
  expect((await status()).incidents[0].closedAt).toBeNull();
  clock.mockReturnValue(86_461_000); await receipt();
  current = await status();
  expect(current.incidents[0]).toMatchObject({ id: incident.id, closedAt: 86_461_000 });
});

it('resumes fresh healthy and stale heartbeat producers through normal silence evaluation', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
  for (const host of ['a.example', 'b.example']) {
    await request('/api/operator/monitors', 'POST', { name: 'Producer', kind: 'heartbeat', silenceSeconds: 60 }, host);
    pause.set(host, true); await status(host);
  }
  const id = (await status()).monitor!.id;
  const { secret } = await (await request('/api/operator/monitors/' + id + '/heartbeat-secret', 'POST')).json() as { secret: string };
  clock.mockReturnValue(300_000);
  await request('/heartbeat', 'POST', undefined, 'a.example', secret);
  for (const host of ['a.example', 'b.example']) { pause.set(host, false); await status(host); }
  await tick(300_000);
  expect((await status()).incidents).toEqual([]);
  expect((await status('b.example')).incidents).toHaveLength(1);
  expect((await status()).monitor!.history!.percentage).toBeNull();
});

it('makes pause override Maintenance and restores an unexpired window on resume', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 503 }));
  await request('/api/operator/monitors', 'POST', { name: 'Website', url: 'https://target.example/' });
  const path = '/api/operator/monitors/' + (await status()).monitor!.id + '/maintenance';
  await request(path, 'PUT', { endsAt: 180_000 });
  pause.set('a.example', true); await status();
  clock.mockReturnValue(60_000); await tick(60_000);
  expect((await status()).monitor).toMatchObject({ state: 'paused', lastResult: null });
  pause.set('a.example', false); await status();
  expect((await status()).monitor!.state).toBe('maintenance');
  await tick(60_000);
  expect((await status()).monitor!.lastResult!.outcome).toBe('maintenance');
  pause.set('a.example', true); await status();
  clock.mockReturnValue(180_000);
  expect((await status()).monitor!.state).toBe('paused');
  pause.set('a.example', false); await status();
  expect((await status()).monitor!.maintenance).toBeNull();
  await tick(180_000); expect((await status()).incidents).toHaveLength(0);
  await tick(240_000); expect((await status()).incidents).toHaveLength(1);
});

it('fails closed on invalid trusted pause metadata before changing state or checking any context', async () => {
  const { createHostedWorker } = await import('../src/index');
  const target = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
  await request('/api/operator/monitors', 'POST', { name: 'Website', url: 'https://target.example/' });
  for (const value of [null, 0, 1, 'false', {}, []]) {
    // Deliberately simulate an untyped consumer at the trust boundary.
    const invalid = createHostedWorker({
      contractVersion: '1',
      // @ts-expect-error invalid consumer metadata must fail closed at runtime
      resolve: () => ({ id: 'a.example', permission: 'editor', monitorLimit: 10, paused: value, policyRevision: 0 }),
      // @ts-expect-error invalid consumer metadata must fail closed at runtime
      contexts: () => [{ id: 'a.example', paused: false, policyRevision: 0 }, { id: 'b.example', paused: value, policyRevision: 0 }],
    });
    expect((await invalid.fetch(new Request('https://a.example/api/status'), env)).status).toBe(500);
    await expect(invalid.scheduled({ scheduledTime: 60_000 } as ScheduledController, env)).rejects.toThrow('Invalid hosted context');
  }
  expect(target).not.toHaveBeenCalled();
  expect((await status()).paused).toBe(false);
});
