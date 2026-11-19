// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { createOperatorSession, type OperatorSessionCallbacks, type LiveSnapshots } from '../src/operator-session';

const snapshot = (pageName = 'Irisbeat') => ({
  partials: [{ scope: 'page', data: { pageName } }], hosted: false, permission: 'editor',
});
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
    snapshot: vi.fn(), partials: vi.fn(), pageNameSaved: vi.fn(), credential: vi.fn(), signedOut: vi.fn(), failed: vi.fn(), saved: vi.fn(),
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
  responses[1].resolve(Response.json(snapshot())); await current;
  responses[0].resolve(new Response(null, { status: 401 })); await previous;
  expect(callbacks.signedOut).not.toHaveBeenCalled();
  expect(requests[1].headers).toMatchObject({ Authorization: 'Bearer new-secret' });
  const older = session.run(); const newer = session.run();
  responses[3].resolve(Response.json(snapshot())); await newer;
  responses[2].resolve(new Response(null, { status: 401 })); await older;
  expect(callbacks.signedOut).toHaveBeenCalledOnce();
  expect(callbacks.failed).toHaveBeenLastCalledWith('Unauthorized', false);
});

it('runs one save at a time and refreshes changed sections without a WebSocket message', async () => {
  const { session, callbacks, responses, requests, live } = setup();
  const login = session.signIn('secret'); responses[0].resolve(Response.json(snapshot())); await login;
  const write = session.run('/api/operator', 'PUT', { pageName: 'saved' });
  await session.run('/api/operator/webhook', 'PUT', { url: '' });
  expect(requests).toHaveLength(2);
  responses[1].resolve(Response.json({ revision: 7, scopes: ['page'] }));
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  const data = { revision: 7, permission: 'editor', html: '<h1>saved</h1>', pageName: 'saved' };
  responses[2].resolve(Response.json(data));
  await write;
  expect(callbacks.partials).toHaveBeenCalledExactlyOnceWith([{ scope: 'page', data }]);
  expect(callbacks.pageNameSaved).toHaveBeenCalledOnce();
  expect(callbacks.saved).toHaveBeenCalledExactlyOnceWith('/api/operator', 'PUT');
  expect(vi.mocked(callbacks.writing).mock.results[0].value).toHaveBeenCalledOnce();
  expect(vi.mocked(live).mock.results[0].value.sync).not.toHaveBeenCalled();
});

it('refreshes only the named section when a WebSocket update arrives during a save', async () => {
  const { session, callbacks, responses, requests, live } = setup();
  const login = session.signIn('secret'); responses[0].resolve(Response.json(snapshot())); await login;
  const write = session.run('/api/operator', 'PUT', { pageName: 'saved' });
  const read = vi.mocked(live).mock.calls[0][1](() => true, { type: 'changed', revision: 8, scopes: ['incidents'] });
  expect(requests).toHaveLength(2);
  responses[1].resolve(Response.json({ revision: 7, scopes: ['page'] }));
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  responses[2].resolve(Response.json({ revision: 7, permission: 'editor', html: '<h1>saved</h1>' }));
  await write;
  const incidents = { revision: 8, permission: 'editor', html: '<p>No Incidents</p>' };
  responses[3].resolve(Response.json(incidents));
  await read;
  expect(callbacks.partials).toHaveBeenLastCalledWith([{ scope: 'incidents', data: incidents }]);
  expect(vi.mocked(live).mock.results[0].value.sync).not.toHaveBeenCalled();
});

it('recovers from a failed scoped refresh without reporting the committed write as failed', async () => {
  const { session, callbacks, responses, requests, live } = setup();
  const login = session.signIn('secret'); responses[0].resolve(Response.json(snapshot())); await login;
  const write = session.run('/api/operator/monitors/one', 'PATCH', { published: false });
  responses[1].resolve(Response.json({ revision: 7, scopes: ['monitor/one'] }));
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  responses[2].resolve(new Response(null, { status: 503 }));
  await write;
  expect(callbacks.failed).toHaveBeenCalledExactlyOnceWith('Updates unavailable', true);
  expect(callbacks.saved).toHaveBeenCalledExactlyOnceWith('/api/operator/monitors/one', 'PATCH');
  expect(vi.mocked(live).mock.results[0].value.sync).toHaveBeenCalledOnce();
});

it('debounces Calendar previews and suppresses late results after replacement or cancellation', async () => {
  vi.useFakeTimers();
  const { session, callbacks, responses, requests } = setup();
  const login = session.signIn('secret'); responses[0].resolve(Response.json(snapshot())); await login;
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
  const login = session.signIn('first'); responses[0].resolve(Response.json(snapshot())); await login;
  const authorize = vi.mocked(live).mock.calls[0][2];
  const grant = authorize();
  expect(requests[1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer first' } });
  responses[1].resolve(Response.json({ ticket: 'single-use-grant' }));
  await expect(grant).resolves.toBe('single-use-grant');
  const late = authorize();
  const rejected = expect(late).rejects.toThrow('Session ended');
  session.signOut();
  expect(vi.mocked(live).mock.results[0].value.stop).toHaveBeenCalledOnce();
  const next = session.signIn('second'); responses[3].resolve(Response.json(snapshot())); await next;
  responses[2].resolve(new Response(null, { status: 401 })); await rejected;
  expect(callbacks.signedOut).toHaveBeenCalledOnce();
  expect(callbacks.failed).not.toHaveBeenCalled();
  const renewal = vi.mocked(live).mock.calls[1][2]();
  const denied = expect(renewal).rejects.toThrow('Unauthorized');
  responses[4].resolve(new Response(null, { status: 403 })); await denied;
  expect(callbacks.signedOut).toHaveBeenCalledTimes(2);
});

it('checks whether a live update still applies after parsing its response', async () => {
  const { session, callbacks, responses, live } = setup();
  const login = session.signIn('secret'); responses[0].resolve(Response.json(snapshot())); await login;
  const body = deferred<unknown>(); const decoding = deferred<void>();
  const older = session.run();
  responses[1].resolve({ status: 200, ok: true, json: () => { decoding.resolve(); return body.promise; } } as Response);
  await decoding.promise;
  const newer = session.run(); responses[2].resolve(Response.json(snapshot('newest'))); await newer;
  body.resolve(snapshot('late body')); await older;
  expect(callbacks.snapshot).toHaveBeenCalledTimes(2);
  const coalesced = vi.mocked(live).mock.calls[0][1](() => false);
  responses[3].resolve(Response.json(snapshot('superseded notice'))); await coalesced;
  expect(callbacks.snapshot).toHaveBeenCalledTimes(2);
});

it('does not restore an old write or report its failure into a new Operator session', async () => {
  const { session, callbacks, responses } = setup();
  const login = session.signIn('secret'); responses[0].resolve(Response.json(snapshot())); await login;
  const write = session.run('/api/operator', 'PUT', { pageName: 'old write' });
  const waiting = session.run();
  session.signOut();
  const next = session.signIn('secret'); responses[2].resolve(Response.json(snapshot('new session'))); await next;
  responses[1].resolve(Response.json({ error: 'Denied' }, { status: 403 })); await write; await waiting;
  expect(vi.mocked(callbacks.writing).mock.results[0].value).not.toHaveBeenCalled();
  expect(callbacks.snapshot).toHaveBeenLastCalledWith(snapshot('new session'));
  expect(callbacks.failed).not.toHaveBeenCalled();
  expect(callbacks.saved).not.toHaveBeenCalled();
});

it('ignores previous-session preview failures but still signs out for a superseded current-session preview 401', async () => {
  vi.useFakeTimers();
  const { session, callbacks, responses } = setup();
  const login = session.signIn('secret'); responses[0].resolve(Response.json(snapshot())); await login;
  session.preview(() => ({ cron: '0 9 * * *', timezone: 'UTC' })); await vi.advanceTimersByTimeAsync(200);
  session.signOut();
  const next = session.signIn('secret'); responses[2].resolve(Response.json(snapshot())); await next;
  responses[1].resolve(Response.json({ error: 'Old error' }, { status: 400 })); await vi.advanceTimersByTimeAsync(0);
  expect(callbacks.previewFailed).not.toHaveBeenCalled();
  session.preview(() => ({ cron: '0 10 * * *', timezone: 'UTC' })); await vi.advanceTimersByTimeAsync(200);
  session.cancelPreview();
  responses[3].resolve(new Response(null, { status: 401 })); await vi.advanceTimersByTimeAsync(0);
  expect(callbacks.signedOut).toHaveBeenCalledTimes(2);
  expect(callbacks.failed).toHaveBeenLastCalledWith('Unauthorized', false);
});
