// SPDX-License-Identifier: AGPL-3.0-only
import { Window, type HTMLInputElement, type HTMLButtonElement } from 'happy-dom';
import { afterEach, expect, it } from 'vitest';
import type { Status } from '../src/index';
import { operatorPage, operatorScript, presentationScript, statusPage, statusScript } from '../src/ui';

const windows: Window[] = [];
const monitor = { id: 'one', name: 'Website', kind: 'http', url: 'https://private.example', published: true, state: 'up', history: null };
const snapshot = (overrides = {}) => ({ pageName: 'Status', webhookUrl: 'https://alerts.example', monitors: [monitor], incidents: [], ...overrides });
async function mount() {
  const window = new Window({ url: 'https://status.example/operator' }); windows.push(window);
  window.document.write(operatorPage());
  let data = snapshot();
  window.fetch = (async () => new window.Response(JSON.stringify(data))) as typeof window.fetch;
  window.eval(presentationScript);
  window.eval(operatorScript);
  const doc = window.document;
  doc.querySelector<HTMLInputElement>('#secret')!.value = 'secret';
  doc.querySelector('#login')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle();
  return { window, doc, set: (next: ReturnType<typeof snapshot>) => { data = next; }, refresh: async () => { doc.querySelector<HTMLButtonElement>('#refresh')!.click(); await settle(); } };
}
function action(doc: Window['document'], label: string) {
  const button = doc.querySelector<HTMLButtonElement>('button[aria-label="' + label + '"]')!;
  button.closest('details')!.querySelector<import('happy-dom').HTMLElement>('summary')!.click();
  button.click();
}
const rowSelector = '#monitor-rows tr, #monitor-rows-after tr';
async function settle() { for (let n = 0; n < 10; n++) await new Promise(resolve => setTimeout(resolve, 0)); }
afterEach(() => { for (const window of windows.splice(0)) window.happyDOM.abort(); });

it('refreshes changed Monitor state while preserving row identity, drafts and focus', async () => {
  const { doc, set, refresh } = await mount();
  const row = doc.querySelector(rowSelector);
  action(doc, 'Edit Website');
  const name = doc.querySelector<HTMLInputElement>('#name')!; name.value = 'Unsaved'; name.focus();
  doc.querySelector<HTMLInputElement>('#pageName')!.value = 'Draft page';
  doc.querySelector<HTMLInputElement>('#webhookUrl')!.value = 'https://draft.example';
  set(snapshot({ monitors: [{ ...monitor, state: 'down' }], pageName: 'Remote page' }));
  await refresh();
  expect(doc.querySelector(rowSelector)).toBe(row);
  expect(row!.textContent).toContain('Unavailable');
  expect(name.value).toBe('Unsaved');
  expect(doc.activeElement).toBe(name);
  expect(doc.querySelector<HTMLInputElement>('#pageName')!.value).toBe('Draft page');
  expect(doc.querySelector<HTMLInputElement>('#webhookUrl')!.value).toBe('https://draft.example');
});

it('retains Maintenance drafts and blocks saving deleted Monitor drafts', async () => {
  const { window, doc, set, refresh } = await mount();
  action(doc, 'Declare Maintenance Website');
  const end = doc.querySelector<HTMLInputElement>('#maintenance-end')!; end.value = '2030-11-16T12:30';
  action(doc, 'Edit Website');
  doc.querySelector<HTMLInputElement>('#name')!.value = 'Retained';
  set(snapshot({ monitors: [] })); await refresh();
  expect(doc.querySelector<HTMLInputElement>('#name')!.value).toBe('Retained');
  expect(end.value).toBe('2030-11-16T12:30');
  expect(doc.querySelector('#monitor-missing')!.hasAttribute('hidden')).toBe(false);
  expect(doc.querySelector<HTMLButtonElement>('#save-monitor')!.disabled).toBe(true);
  expect(doc.querySelector<HTMLButtonElement>('#save-maintenance')!.disabled).toBe(true);
  let writes = 0;
  window.fetch = (async () => { writes++; return new window.Response('{}'); }) as typeof window.fetch;
  doc.querySelector('#configuration')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
  doc.querySelector('#maintenance')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle(); expect(writes).toBe(0);
});

it('retains last-known state on failure, clears stale on recovery, and clears private data on authorization loss', async () => {
  const { window, doc, refresh } = await mount();
  window.fetch = (async () => { throw new Error('offline'); }) as typeof window.fetch;
  await refresh();
  expect([...doc.querySelectorAll(rowSelector)].map(row => row.textContent).join('')).toContain('Website');
  expect(doc.querySelector('#stale')!.hasAttribute('hidden')).toBe(false);
  window.fetch = (async () => new window.Response(JSON.stringify(snapshot()))) as typeof window.fetch;
  await refresh(); expect(doc.querySelector('#stale')!.hasAttribute('hidden')).toBe(true);
  action(doc, 'Edit Website');
  window.fetch = (async () => new window.Response('not JSON', { status: 401 })) as typeof window.fetch;
  await refresh();
  expect(doc.querySelector('#editor')!.hasAttribute('hidden')).toBe(true);
  expect([...doc.querySelectorAll(rowSelector)].map(row => row.textContent).join('')).toBe('');
  expect(doc.querySelector<HTMLInputElement>('#url')!.value).toBe('');
  expect(doc.querySelector<HTMLInputElement>('#webhookUrl')!.value).toBe('');
  expect(doc.querySelector('#message')!.textContent).toBe('Sign in required');
});

it('ignores late snapshots after a newer snapshot or own save', async () => {
  const { window, doc, refresh } = await mount();
  let resolve!: (response: InstanceType<typeof window.Response>) => void;
  window.fetch = (() => new Promise(done => { resolve = done; })) as typeof window.fetch;
  doc.querySelector<HTMLButtonElement>('#refresh')!.click();
  window.fetch = (async () => new window.Response(JSON.stringify(snapshot({ pageName: 'Saved', monitors: [{ ...monitor, name: 'Newest' }] })))) as typeof window.fetch;
  doc.querySelector<HTMLInputElement>('#pageName')!.value = 'Saved';
  doc.querySelector('#page-configuration')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle();
  resolve(new window.Response(JSON.stringify(snapshot()))); await settle();
  expect([...doc.querySelectorAll(rowSelector)].map(row => row.textContent).join('')).toContain('Newest');
  expect(doc.querySelector<HTMLInputElement>('#pageName')!.value).toBe('Saved');
  await refresh();
});

it.each(['GET', 'PUT'])('does not let an old session %s response revoke a new sign-in', async method => {
  const { window, doc } = await mount();
  let resolve!: (response: InstanceType<typeof window.Response>) => void;
  window.fetch = (() => new Promise(done => { resolve = done; })) as typeof window.fetch;
  if (method === 'GET') doc.querySelector<HTMLButtonElement>('#refresh')!.click();
  else doc.querySelector('#page-configuration')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
  doc.querySelector<HTMLButtonElement>('#logout')!.click();
  window.fetch = (async () => new window.Response(JSON.stringify(snapshot()))) as typeof window.fetch;
  doc.querySelector<HTMLInputElement>('#secret')!.value = 'secret';
  doc.querySelector('#login')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle();
  resolve(new window.Response('{}', { status: 401 })); await settle();
  expect(doc.querySelector('#editor')!.hasAttribute('hidden')).toBe(false);
});

it('polls only visible pages every minute and immediately resynchronizes on return', async () => {
  const window = new Window({ url: 'https://status.example/operator' }); windows.push(window);
  Object.defineProperty(window, 'WebSocket', { value: undefined });
  const timers = new Map<number, () => void>(); let timerId = 0;
  window.setTimeout = ((callback: () => void, delay: number) => { expect([15000, 60000]).toContain(delay); timers.set(++timerId, callback); return timerId; }) as unknown as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof window.clearTimeout;
  window.document.write(operatorPage());
  let reads = 0;
  window.fetch = (async () => { reads++; return new window.Response(JSON.stringify(snapshot())); }) as typeof window.fetch;
  window.eval(presentationScript);
  window.eval(operatorScript);
  const doc = window.document;
  doc.querySelector<HTMLInputElement>('#secret')!.value = 'secret';
  doc.querySelector('#login')!.dispatchEvent(new window.Event('submit', { cancelable: true })); await settle();
  expect(reads).toBe(1);
  const tick = timers.values().next().value!; timers.clear(); tick(); await settle(); expect(reads).toBe(2);
  Object.defineProperty(doc, 'hidden', { configurable: true, value: true });
  doc.dispatchEvent(new window.Event('visibilitychange')); expect(timers.size).toBe(0);
  Object.defineProperty(doc, 'hidden', { configurable: true, value: false });
  doc.dispatchEvent(new window.Event('visibilitychange')); await settle();
  expect(reads).toBe(3); expect(timers.size).toBe(1);
  doc.querySelector<HTMLButtonElement>('#logout')!.click();
  expect(timers.size).toBe(0); await settle(); expect(reads).toBe(3);
});

it('refreshes the public ledger, history and Incidents in place without a document reload', async () => {
  const window = new Window({ url: 'https://status.example/' }); windows.push(window);
  const doc = window.document;
  const history = { percentage: 100, days: [{ date: '2026-11-16', state: 'up', successes: 1, failures: 0, maintenance: 0 }] };
  const initial = snapshot({ monitors: [{ ...monitor, history }] });
  doc.write(statusPage(initial as unknown as Status));
  expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull();
  let next = snapshot({ pageName: 'Updated', monitors: [{ ...monitor, history: { ...history, percentage: 50, days: [{ ...history.days[0], failures: 1, state: 'degraded' }] }, state: 'down' }], incidents: [{ id: 'incident', monitorId: 'one', openedAt: 1, closedAt: null }] });
  window.fetch = (async () => new window.Response(JSON.stringify(next))) as typeof window.fetch;
  window.eval(presentationScript);
  window.eval(statusScript);
  const row = doc.querySelector('#public-monitors article');
  const day = doc.querySelector<import('happy-dom').HTMLElement>('.history-day')!;
  day.focus();
  doc.querySelector<HTMLButtonElement>('#refresh')!.click(); await settle();
  expect(doc.querySelector('#public-monitors article')).toBe(row);
  expect(doc.querySelector('.history-day')).toBe(day);
  expect(doc.activeElement).toBe(day);
  expect(day.classList.contains('degraded')).toBe(true);
  expect(doc.querySelector('.banner')!.textContent).toContain('Services unavailable');
  expect(doc.title).toBe('Updated');
  expect(doc.querySelector('.incidents')!.textContent).toContain('Ongoing');
  const incident = doc.querySelector('.incidents li');
  next = snapshot({ paused: true, monitors: [{ ...monitor, history }], incidents: [{ id: 'incident', monitorId: 'one', openedAt: 1, closedAt: 2 }] });
  doc.querySelector<HTMLButtonElement>('#refresh')!.click(); await settle();
  expect(doc.querySelector('.incidents li')).toBe(incident);
  expect(incident!.textContent).toContain('Recovered');
  expect(doc.querySelector('.banner')!.textContent).toContain('Monitoring paused');
  next = snapshot({ monitors: [] });
  doc.querySelector<HTMLButtonElement>('#refresh')!.click(); await settle();
  expect(doc.querySelector('#public-monitors')!.children.length).toBe(0);
  expect(doc.querySelector('.banner')!.textContent).toContain('No Monitors published');
});

it('clears all privileged Maintenance and Heartbeat details when signing out', async () => {
  const { doc, set, refresh } = await mount();
  set(snapshot({ monitors: [{ ...monitor, name: 'Private heartbeat', kind: 'heartbeat' }] })); await refresh();
  action(doc, 'Edit Private heartbeat');
  action(doc, 'Declare Maintenance Private heartbeat');
  doc.querySelector<HTMLButtonElement>('#logout')!.click();
  expect(doc.querySelector('#heartbeat-path')!.textContent).toBe('');
  expect(doc.querySelector('#maintenance-heading')!.textContent).toBe('Maintenance');
  expect(doc.querySelector<HTMLInputElement>('#maintenance-end')!.value).toBe('');
  expect(doc.querySelector('#maintenance')!.getAttribute('data-monitor-id')).toBeNull();
});

it('keeps drafts entered while an own save is in flight', async () => {
  const { window, doc } = await mount();
  let resolve!: (response: InstanceType<typeof window.Response>) => void;
  window.fetch = (() => new Promise(done => { resolve = done; })) as typeof window.fetch;
  const page = doc.querySelector<HTMLInputElement>('#pageName')!;
  page.value = 'Submitted';
  doc.querySelector('#page-configuration')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
  page.value = 'Next draft';
  resolve(new window.Response(JSON.stringify(snapshot({ pageName: 'Submitted' })))); await settle();
  expect(page.value).toBe('Next draft');
  action(doc, 'Edit Website');
  const name = doc.querySelector<HTMLInputElement>('#name')!; name.value = 'Submitted Monitor';
  doc.querySelector('#configuration')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
  name.value = 'Next Monitor draft';
  resolve(new window.Response(JSON.stringify(snapshot({ monitors: [{ ...monitor, name: 'Submitted Monitor' }] })))); await settle();
  expect(doc.querySelector('#configuration')!.hasAttribute('hidden')).toBe(false);
  expect(name.value).toBe('Next Monitor draft');
});

it('reconciles creation order and publication changes and binds actions to the latest snapshot', async () => {
  const { window, doc, set, refresh } = await mount();
  const oldRow = doc.querySelector(rowSelector);
  set(snapshot({ paused: true, monitors: [{ ...monitor, id: 'two', name: 'New' }, { ...monitor, name: 'Renamed', published: false, maintenance: { endsAt: 2000000000000 } }] }));
  await refresh();
  expect(doc.querySelectorAll(rowSelector)[2]).toBe(oldRow);
  expect(oldRow!.textContent).toContain('Private');
  expect(doc.querySelector('#paused')!.hasAttribute('hidden')).toBe(false);
  action(doc, 'Edit Renamed');
  expect(doc.querySelector<HTMLInputElement>('#name')!.value).toBe('Renamed');
  let request: { path: string; body: string } | undefined;
  window.fetch = (async (path, options) => { request = { path: String(path), body: String(options!.body) }; return new window.Response(JSON.stringify(snapshot())); }) as typeof window.fetch;
  action(doc, 'Publish Renamed'); await settle();
  expect(request).toEqual({ path: '/api/operator/monitors/one', body: '{"published":true}' });
  set(snapshot({ permission: 'reader' }));
  window.fetch = (async () => new window.Response(JSON.stringify(snapshot({ permission: 'reader' })))) as typeof window.fetch;
  await refresh();
  expect(doc.querySelector('#configuration')!.hasAttribute('hidden')).toBe(true);
  expect(doc.querySelector('#new-monitor')!.hasAttribute('hidden')).toBe(true);
  expect(doc.querySelector('button[aria-label="Edit Website"]')).toBeNull();
});

it('keeps public last-known data on failure and ignores older overlapping reads', async () => {
  const window = new Window({ url: 'https://status.example/' }); windows.push(window);
  const doc = window.document;
  doc.write(statusPage(snapshot() as unknown as Status));
  window.fetch = (async () => { throw new Error('offline'); }) as typeof window.fetch;
  window.eval(presentationScript);
  window.eval(statusScript);
  const refresh = () => doc.querySelector<HTMLButtonElement>('#refresh')!.click();
  refresh(); await settle();
  expect(doc.querySelector('#public-monitors')!.textContent).toContain('Website');
  expect(doc.querySelector('#stale')!.hasAttribute('hidden')).toBe(false);
  let resolve!: (response: InstanceType<typeof window.Response>) => void;
  window.fetch = (() => new Promise(done => { resolve = done; })) as typeof window.fetch;
  refresh();
  window.fetch = (async () => new window.Response(JSON.stringify(snapshot({ pageName: 'Newest' })))) as typeof window.fetch;
  refresh(); await settle();
  resolve(new window.Response(JSON.stringify(snapshot()))); await settle();
  expect(doc.querySelector('h1')!.textContent).toBe('Newest');
  expect(doc.querySelector('#stale')!.hasAttribute('hidden')).toBe(true);
});

it('clears editor-only values on reader downgrade and rehydrates on restored permission', async () => {
  const { doc, set, refresh } = await mount();
  set(snapshot({ permission: 'reader', webhookUrl: undefined })); await refresh();
  expect(doc.querySelector<HTMLInputElement>('#webhookUrl')!.value).toBe('');
  set(snapshot({ webhookUrl: 'https://restored.example' })); await refresh();
  expect(doc.querySelector<HTMLInputElement>('#webhookUrl')!.value).toBe('https://restored.example');
});

it('keeps another Maintenance draft when an earlier End Maintenance finishes', async () => {
  const { window, doc, set, refresh } = await mount();
  const other = { ...monitor, id: 'two', name: 'Other' };
  set(snapshot({ monitors: [{ ...monitor, maintenance: { endsAt: 2000000000000 } }, other] })); await refresh();
  let resolve!: (response: InstanceType<typeof window.Response>) => void;
  window.fetch = (() => new Promise(done => { resolve = done; })) as typeof window.fetch;
  action(doc, 'End Maintenance Website');
  action(doc, 'Declare Maintenance Other');
  const end = doc.querySelector<HTMLInputElement>('#maintenance-end')!;
  end.value = '2030-11-16T12:30'; end.focus();
  resolve(new window.Response(JSON.stringify(snapshot({ monitors: [monitor, other] })))); await settle();
  expect(doc.querySelector('#maintenance')!.hasAttribute('hidden')).toBe(false);
  expect(end.value).toBe('2030-11-16T12:30');
  expect(doc.activeElement).toBe(end);
});

it('ignores obsolete sign-in completion while a newer session edits a Monitor', async () => {
  const { window, doc } = await mount();
  doc.querySelector<HTMLButtonElement>('#logout')!.click();
  let resolve!: (response: InstanceType<typeof window.Response>) => void;
  window.fetch = (() => new Promise(done => { resolve = done; })) as typeof window.fetch;
  doc.querySelector<HTMLInputElement>('#secret')!.value = 'old';
  doc.querySelector('#login')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
  window.fetch = (async () => new window.Response(JSON.stringify(snapshot()))) as typeof window.fetch;
  doc.querySelector<HTMLInputElement>('#secret')!.value = 'new';
  doc.querySelector('#login')!.dispatchEvent(new window.Event('submit', { cancelable: true })); await settle();
  action(doc, 'Edit Website');
  const name = doc.querySelector<HTMLInputElement>('#name')!; name.value = 'New draft'; name.focus();
  resolve(new window.Response('{}', { status: 401 })); await settle();
  expect(doc.activeElement).toBe(name);
  expect(name.value).toBe('New draft');
});

it('returns focus to New Monitor after deleting from the ellipsis menu', async () => {
  const { window, doc } = await mount();
  window.eval('window.confirm = () => true');
  window.fetch = (async () => new window.Response(JSON.stringify(snapshot({ monitors: [] })))) as typeof window.fetch;
  action(doc, 'Delete Website'); await settle();
  expect(doc.activeElement).toBe(doc.querySelector('#new-monitor'));
});

it.each(['End Maintenance', 'Save Maintenance'])('keeps a reopened identical Maintenance draft when pending %s completes', async label => {
  const { window, doc, set, refresh } = await mount();
  const active = snapshot({ monitors: [{ ...monitor, maintenance: { endsAt: 2000000000000 } }] });
  set(active); await refresh();
  action(doc, 'Replace Maintenance Website');
  const end = doc.querySelector<HTMLInputElement>('#maintenance-end')!;
  const value = end.value;
  let resolve!: (response: InstanceType<typeof window.Response>) => void;
  window.fetch = (() => new Promise(done => { resolve = done; })) as typeof window.fetch;
  if (label === 'End Maintenance') action(doc, 'End Maintenance Website');
  else doc.querySelector('#maintenance')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
  doc.querySelector<HTMLButtonElement>('#cancel-maintenance')!.click();
  action(doc, 'Replace Maintenance Website');
  expect(end.value).toBe(value);
  end.focus();
  resolve(new window.Response(JSON.stringify(active))); await settle();
  expect(doc.querySelector('#maintenance')!.hasAttribute('hidden')).toBe(false);
  expect(doc.activeElement).toBe(end);
});

it('does not expose a pending Heartbeat credential in a different inline draft', async () => {
  const { window, doc, set, refresh } = await mount();
  const producer = { ...monitor, id: 'producer', name: 'Producer', kind: 'heartbeat' };
  const data = snapshot({ hosted: true, monitors: [monitor, producer] });
  set(data); await refresh();
  action(doc, 'Edit Producer');
  window.eval('window.confirm = () => true');
  let resolve!: (response: InstanceType<typeof window.Response>) => void;
  window.fetch = (() => new Promise(done => { resolve = done; })) as typeof window.fetch;
  doc.querySelector<HTMLButtonElement>('#rotate-heartbeat')!.click();
  action(doc, 'Edit Website');
  const name = doc.querySelector<HTMLInputElement>('#name')!;
  name.value = 'Next draft';
  resolve(new window.Response(JSON.stringify({ secret: 'old-producer-credential' }))); await settle();
  expect(doc.querySelector('#heartbeat-credential')!.textContent).toBe('');
  expect(name.value).toBe('Next draft');
  expect(doc.activeElement).toBe(name);
});

it.each(['Monitor', 'Maintenance'])('keeps a %s draft changed while Delete is pending and blocks saving the deleted Monitor', async kind => {
  const { window, doc } = await mount();
  action(doc, kind === 'Monitor' ? 'Edit Website' : 'Declare Maintenance Website');
  const input = doc.querySelector<HTMLInputElement>(kind === 'Monitor' ? '#name' : '#maintenance-end')!;
  const value = kind === 'Monitor' ? 'New draft' : '2030-11-16T12:30';
  window.eval('window.confirm = () => true');
  let resolve!: (response: InstanceType<typeof window.Response>) => void;
  window.fetch = (() => new Promise(done => { resolve = done; })) as typeof window.fetch;
  action(doc, 'Delete Website');
  input.value = value; input.focus();
  resolve(new window.Response(JSON.stringify(snapshot({ monitors: [] })))); await settle();
  expect(doc.querySelector(kind === 'Monitor' ? '#configuration' : '#maintenance')!.hasAttribute('hidden')).toBe(false);
  expect(input.value).toBe(value);
  expect(doc.activeElement).toBe(input);
  expect(doc.querySelector<HTMLButtonElement>(kind === 'Monitor' ? '#save-monitor' : '#save-maintenance')!.disabled).toBe(true);
});

it('resynchronizes public subscriptions, bounds duplicate reads, and polls only while disconnected and visible', async () => {
  const window = new Window({ url: 'https://status.example/' }); windows.push(window);
  const doc = window.document; doc.write(statusPage(snapshot() as unknown as Status));
  const sockets: { onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; onerror?: () => void; readyState: number; send: (value: string) => void; close: () => void }[] = [];
  const sent: string[] = [];
  class Socket {
    readyState = 0;
    constructor(readonly url: string) { expect(url).toBe('wss://status.example/api/status/subscribe'); sockets.push(this); }
    send(value: string) { sent.push(value); }
    close() { this.readyState = 3; }
  }
  Object.defineProperty(window, 'WebSocket', { value: Socket });
  const timers = new Map<number, { callback: () => void; delay: number }>(); let timerId = 0;
  window.setTimeout = ((callback: () => void, delay: number) => { timers.set(++timerId, { callback, delay }); return timerId; }) as unknown as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => timers.delete(id)) as unknown as typeof window.clearTimeout;
  let reads = 0; let release: (() => void) | undefined;
  window.fetch = (async () => { reads++; if (release) await new Promise<void>(resolve => { release = resolve; }); return new window.Response(JSON.stringify(snapshot({ pageName: 'Live' }))); }) as typeof window.fetch;
  window.eval(presentationScript); window.eval(statusScript);
  expect(sockets).toHaveLength(1);
  sockets[0].readyState = 1; sockets[0].onopen!(); await settle();
  expect(reads).toBe(1); expect(doc.title).toBe('Live'); expect([...timers.values()].filter(t => t.delay === 60000)).toHaveLength(0);
  release = () => {};
  for (let i = 0; i < 100; i++) sockets[0].onmessage!({ data: '{"type":"status-changed"}' });
  expect(reads).toBe(2);
  const finish = release!; release = undefined; finish(); await settle();
  expect(reads).toBeLessThanOrEqual(3);
  [...timers.values()].find(t => t.delay === 250)!.callback(); expect(sent).toContain('resync');
  sockets[0].readyState = 3; sockets[0].onclose!();
  expect(doc.querySelector('#stale')!.hasAttribute('hidden')).toBe(true);
  const [fallbackId, fallback] = [...timers].find(([, t]) => t.delay === 60000)!; timers.delete(fallbackId); fallback.callback(); await settle();
  expect(reads).toBeGreaterThanOrEqual(3);
  Object.defineProperty(doc, 'hidden', { configurable: true, value: true }); doc.dispatchEvent(new window.Event('visibilitychange'));
  expect([...timers.values()].filter(t => t.delay === 60000)).toHaveLength(0);
  const reconnect = [...timers.values()].find(t => t.delay < 60000)!; reconnect.callback();
  expect(sockets).toHaveLength(2); sockets[1].readyState = 1; sockets[1].onopen!(); await settle();
  expect([...timers.values()].filter(t => t.delay === 60000)).toHaveLength(0);
  expect(doc.title).toBe('Live');
  window.fetch = (async () => { throw new Error('snapshot unavailable'); }) as typeof window.fetch;
  sockets[1].onmessage!({ data: '{"type":"status-changed"}' }); await settle();
  expect(doc.querySelector('#stale')!.hasAttribute('hidden')).toBe(false);
  expect(sockets[1].readyState).toBe(3);
  window.fetch = (async () => new window.Response(JSON.stringify(snapshot({ pageName: 'Recovered' })))) as typeof window.fetch;
  // A failed snapshot must remain eligible for recovery even if no further public change occurs.
  [...timers.values()].filter(t => t.delay === 1000).at(-1)!.callback();
  sockets[2].readyState = 1; sockets[2].onopen!(); await settle();
  expect(doc.title).toBe('Recovered'); expect(doc.querySelector('#stale')!.hasAttribute('hidden')).toBe(true);
});

it('caps reconnect backoff without postponing the visible fallback and cleans up on page exit', async () => {
  const window = new Window({ url: 'https://status.example/' }); windows.push(window);
  window.document.write(statusPage(snapshot() as unknown as Status));
  Object.defineProperty(window, 'WebSocket', { value: class { constructor() { throw new Error('unavailable'); } } });
  const timers = new Map<number, { callback: () => void; delay: number }>(); let id = 0;
  window.setTimeout = ((callback: () => void, delay: number) => { timers.set(++id, { callback, delay }); return id; }) as unknown as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => timers.delete(id)) as unknown as typeof window.clearTimeout;
  let reads = 0;
  window.fetch = (async () => { reads++; return new window.Response(JSON.stringify(snapshot())); }) as typeof window.fetch;
  window.eval(presentationScript); window.eval(statusScript);
  const poll = [...timers].find(([, timer]) => timer.delay === 60000)!;
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const [key, timer] = [...timers].find(([, timer]) => timer.delay === delay)!;
    timers.delete(key); timer.callback();
    expect(timers.get(poll[0])).toBe(poll[1]);
  }
  timers.delete(poll[0]); poll[1].callback(); await settle(); expect(reads).toBe(1);
  window.dispatchEvent(new window.Event('pagehide')); expect(timers.size).toBe(0);
  window.dispatchEvent(new window.Event('pageshow')); await settle();
  expect(reads).toBe(2); expect([...timers.values()].some(timer => timer.delay === 60000)).toBe(true);
});

it('subscribes operators with an HTTP ticket, preserves live drafts, and closes and clears on authorization loss', async () => {
  const window = new Window({ url: 'https://status.example/operator' }); windows.push(window);
  const doc = window.document; doc.write(operatorPage());
  const sockets: Socket[] = [];
  class Socket {
    readyState = 0; onopen?: () => void; onmessage?: (event: { data: string }) => void;
    constructor(readonly url: string) { sockets.push(this); }
    send() {} close() { this.readyState = 3; }
  }
  Object.defineProperty(window, 'WebSocket', { value: Socket });
  let data = snapshot(), authorized = true;
  window.fetch = (async (path, options) => {
    if (!authorized) return new window.Response('{}', { status: 401 });
    if (path === '/api/operator/subscription') {
      expect(options?.method).toBe('POST'); expect((options?.headers as Record<string, string>).Authorization).toBe('Bearer private-secret');
      return new window.Response(JSON.stringify({ ticket: 'single-use' }));
    }
    return new window.Response(JSON.stringify(data));
  }) as typeof window.fetch;
  window.eval(presentationScript); window.eval(operatorScript);
  doc.querySelector<HTMLInputElement>('#secret')!.value = 'private-secret';
  doc.querySelector('#login')!.dispatchEvent(new window.Event('submit', { cancelable: true })); await settle();
  expect(sockets).toHaveLength(1); expect(sockets[0].url).toBe('wss://status.example/api/operator/subscribe?ticket=single-use');
  sockets[0].readyState = 1; sockets[0].onopen!(); await settle();
  action(doc, 'Edit Website'); const input = doc.querySelector<HTMLInputElement>('#name')!; input.value = 'Unsaved'; input.focus();
  const row = doc.querySelector(rowSelector);
  data = snapshot({ monitors: [{ ...monitor, state: 'down' }] });
  sockets[0].onmessage!({ data: '{"type":"status-changed"}' }); await settle();
  expect(row!.textContent).toContain('Unavailable'); expect(input.value).toBe('Unsaved'); expect(doc.activeElement).toBe(input);
  data = snapshot({ permission: 'reader', webhookUrl: undefined });
  sockets[0].onmessage!({ data: '{"type":"status-changed"}' }); await settle();
  expect(sockets[0].readyState).toBe(3); expect(sockets).toHaveLength(2);
  expect(doc.querySelector<HTMLInputElement>('#webhookUrl')!.value).toBe('');
  sockets[1].readyState = 1; sockets[1].onopen!(); await settle();
  authorized = false; sockets[1].onmessage!({ data: '{"type":"status-changed"}' }); await settle();
  expect(sockets[0].readyState).toBe(3); expect(doc.querySelector('#editor')!.hasAttribute('hidden')).toBe(true);
  expect(doc.querySelector('#monitor-rows')!.textContent).toBe(''); expect(input.value).toBe('');
});
