// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { createOperatorSession, type OperatorSessionCallbacks, type LiveSnapshots } from '../src/operator-session';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const responses: ReturnType<typeof deferred<Response>>[] = [];
  const requests: RequestInit[] = [];
  vi.stubGlobal('fetch', (_path: string, init: RequestInit) => {
    requests.push(init);
    const response = deferred<Response>(); responses.push(response); return response.promise;
  });
  const callbacks: OperatorSessionCallbacks = {
    received: vi.fn(), signedOut: vi.fn(), failed: vi.fn(), saved: vi.fn(),
    writing: vi.fn(() => vi.fn()), previewed: vi.fn(), previewFailed: vi.fn(),
  };
  const live: LiveSnapshots = vi.fn(() => ({ sync: vi.fn(), stop: vi.fn() }));
  const session = createOperatorSession(live, callbacks);
  return { session, callbacks, responses, requests, live };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('discards previous-session responses while an older current-session 401 still signs out', async () => {
  const { session, callbacks, responses, requests } = setup();
  const previous = session.signIn('old-secret');
  const current = session.signIn('new-secret');
  responses[1].resolve(Response.json({ monitors: [] })); await current;
  responses[0].resolve(new Response(null, { status: 401 })); await previous;
  expect(callbacks.signedOut).not.toHaveBeenCalled();
  expect(requests[1].headers).toMatchObject({ Authorization: 'Bearer new-secret' });
  const older = session.run(); const newer = session.run();
  responses[3].resolve(Response.json({ monitors: [] })); await newer;
  responses[2].resolve(new Response(null, { status: 401 })); await older;
  expect(callbacks.signedOut).toHaveBeenCalledOnce();
  expect(callbacks.failed).toHaveBeenLastCalledWith('Unauthorized', false);
});

it('serializes writes, suppresses superseded reads and refreshes once after a pending write', async () => {
  const { session, callbacks, responses, requests, live } = setup();
  const login = session.signIn('secret'); responses[0].resolve(Response.json({ monitors: [] })); await login;
  const older = session.run(); const newer = session.run();
  responses[2].resolve(Response.json({ pageName: 'new' })); await newer;
  responses[1].resolve(Response.json({ pageName: 'old' })); await older;
  expect(callbacks.received).toHaveBeenLastCalledWith({ pageName: 'new' }, undefined);
  const write = session.run('/api/operator', 'PUT', { pageName: 'saved' });
  await session.run('/api/operator/webhook', 'PUT', { url: '' });
  await session.run(); await session.run();
  expect(requests).toHaveLength(4);
  responses[3].resolve(Response.json({ pageName: 'saved' })); await write;
  expect(callbacks.received).toHaveBeenLastCalledWith({ pageName: 'saved' }, 'pageName');
  expect(callbacks.writing).toHaveBeenCalledOnce();
  expect(vi.mocked(callbacks.writing).mock.results[0].value).toHaveBeenCalledOnce();
  expect(vi.mocked(live).mock.results[0].value.sync).toHaveBeenCalledOnce();
});

it('debounces Calendar previews and suppresses late results after replacement or cancellation', async () => {
  vi.useFakeTimers();
  const { session, callbacks, responses, requests } = setup();
  const login = session.signIn('secret'); responses[0].resolve(Response.json({ monitors: [] })); await login;
  session.preview(() => ({ cron: '0 8 * * *', timezone: 'UTC' }));
  await vi.advanceTimersByTimeAsync(100);
  session.preview(() => ({ cron: '0 9 * * *', timezone: 'UTC' }));
  await vi.advanceTimersByTimeAsync(199); expect(requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); expect(requests).toHaveLength(2);
  session.preview(() => ({ cron: '0 10 * * *', timezone: 'UTC', graceSeconds: 30 }));
  await vi.advanceTimersByTimeAsync(200);
  responses[2].resolve(Response.json({ explanation: '10 AM', timezone: 'UTC', occurrences: [1000] }));
  await vi.advanceTimersByTimeAsync(0);
  responses[1].resolve(Response.json({ explanation: '9 AM', timezone: 'UTC', occurrences: [0] }));
  await vi.advanceTimersByTimeAsync(0);
  expect(callbacks.previewed).toHaveBeenCalledExactlyOnceWith({ explanation: '10 AM', timezone: 'UTC', occurrences: [1000] });
  session.preview(() => ({ cron: '0 11 * * *', timezone: 'UTC' }));
  await vi.advanceTimersByTimeAsync(200);
  session.cancelPreview();
  responses[3].resolve(Response.json({ error: 'Invalid cron' }, { status: 400 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(callbacks.previewFailed).not.toHaveBeenCalled();
});

it('owns authenticated subscription tickets and stops the old lifecycle before a new sign-in', async () => {
  const { session, callbacks, responses, requests, live } = setup();
  const login = session.signIn('first'); responses[0].resolve(Response.json({ monitors: [] })); await login;
  const authorize = vi.mocked(live).mock.calls[0][2];
  const grant = authorize();
  expect(requests[1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer first' } });
  responses[1].resolve(Response.json({ ticket: 'single-use-grant' }));
  await expect(grant).resolves.toBe('single-use-grant');
  const late = authorize();
  const rejected = expect(late).rejects.toThrow('Session ended');
  session.signOut();
  expect(vi.mocked(live).mock.results[0].value.stop).toHaveBeenCalledOnce();
  const next = session.signIn('second'); responses[3].resolve(Response.json({ monitors: [] })); await next;
  responses[2].resolve(new Response(null, { status: 401 })); await rejected;
  expect(callbacks.signedOut).toHaveBeenCalledOnce();
  expect(callbacks.failed).not.toHaveBeenCalled();
  const renewal = vi.mocked(live).mock.calls[1][2]();
  const denied = expect(renewal).rejects.toThrow('Unauthorized');
  responses[4].resolve(new Response(null, { status: 403 })); await denied;
  expect(callbacks.signedOut).toHaveBeenCalledTimes(2);
});

it('rechecks eligibility after JSON decoding and honors subscription coalescing', async () => {
  const { session, callbacks, responses, live } = setup();
  const login = session.signIn('secret'); responses[0].resolve(Response.json({ monitors: [] })); await login;
  const body = deferred<unknown>(); const decoding = deferred<void>();
  const older = session.run();
  responses[1].resolve({ status: 200, ok: true, json: () => { decoding.resolve(); return body.promise; } } as Response);
  await decoding.promise;
  const newer = session.run(); responses[2].resolve(Response.json({ pageName: 'newest' })); await newer;
  body.resolve({ pageName: 'late body' }); await older;
  expect(callbacks.received).toHaveBeenCalledTimes(2);
  const coalesced = vi.mocked(live).mock.calls[0][1](() => false);
  responses[3].resolve(Response.json({ pageName: 'superseded notice' })); await coalesced;
  expect(callbacks.received).toHaveBeenCalledTimes(2);
});

it('does not restore an old write or report its failure into a new Operator session', async () => {
  const { session, callbacks, responses } = setup();
  const login = session.signIn('secret'); responses[0].resolve(Response.json({ monitors: [] })); await login;
  const write = session.run('/api/operator', 'PUT', { pageName: 'old write' });
  await session.run();
  session.signOut();
  const next = session.signIn('secret'); responses[2].resolve(Response.json({ pageName: 'new session' })); await next;
  responses[1].resolve(Response.json({ error: 'Denied' }, { status: 403 })); await write;
  expect(vi.mocked(callbacks.writing).mock.results[0].value).not.toHaveBeenCalled();
  expect(callbacks.received).toHaveBeenLastCalledWith({ pageName: 'new session' }, undefined);
  expect(callbacks.failed).not.toHaveBeenCalled();
  expect(callbacks.saved).not.toHaveBeenCalled();
});

it('ignores previous-session preview failures but still signs out for a superseded current-session preview 401', async () => {
  vi.useFakeTimers();
  const { session, callbacks, responses } = setup();
  const login = session.signIn('secret'); responses[0].resolve(Response.json({ monitors: [] })); await login;
  session.preview(() => ({ cron: '0 9 * * *', timezone: 'UTC' })); await vi.advanceTimersByTimeAsync(200);
  session.signOut();
  const next = session.signIn('secret'); responses[2].resolve(Response.json({ monitors: [] })); await next;
  responses[1].resolve(Response.json({ error: 'Old error' }, { status: 400 })); await vi.advanceTimersByTimeAsync(0);
  expect(callbacks.previewFailed).not.toHaveBeenCalled();
  session.preview(() => ({ cron: '0 10 * * *', timezone: 'UTC' })); await vi.advanceTimersByTimeAsync(200);
  session.cancelPreview();
  responses[3].resolve(new Response(null, { status: 401 })); await vi.advanceTimersByTimeAsync(0);
  expect(callbacks.signedOut).toHaveBeenCalledTimes(2);
  expect(callbacks.failed).toHaveBeenLastCalledWith('Unauthorized', false);
});
