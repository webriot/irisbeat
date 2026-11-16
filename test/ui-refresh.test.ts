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
async function settle() { for (let n = 0; n < 10; n++) await new Promise(resolve => setTimeout(resolve, 0)); }
afterEach(() => { for (const window of windows.splice(0)) window.happyDOM.abort(); });

it('refreshes changed Monitor state while preserving row identity, drafts and focus', async () => {
  const { doc, set, refresh } = await mount();
  const row = doc.querySelector('#monitor-rows tr');
  doc.querySelector<HTMLButtonElement>('button[aria-label="Edit Website"]')!.click();
  const name = doc.querySelector<HTMLInputElement>('#name')!; name.value = 'Unsaved'; name.focus();
  doc.querySelector<HTMLInputElement>('#pageName')!.value = 'Draft page';
  doc.querySelector<HTMLInputElement>('#webhookUrl')!.value = 'https://draft.example';
  set(snapshot({ monitors: [{ ...monitor, state: 'down' }], pageName: 'Remote page' }));
  await refresh();
  expect(doc.querySelector('#monitor-rows tr')).toBe(row);
  expect(row!.textContent).toContain('Unavailable');
  expect(name.value).toBe('Unsaved');
  expect(doc.activeElement).toBe(name);
  expect(doc.querySelector<HTMLInputElement>('#pageName')!.value).toBe('Draft page');
  expect(doc.querySelector<HTMLInputElement>('#webhookUrl')!.value).toBe('https://draft.example');
});

it('retains Maintenance drafts and blocks saving deleted Monitor drafts', async () => {
  const { window, doc, set, refresh } = await mount();
  doc.querySelector<HTMLButtonElement>('button[aria-label="Declare Maintenance Website"]')!.click();
  const end = doc.querySelector<HTMLInputElement>('#maintenance-end')!; end.value = '2030-11-16T12:30';
  doc.querySelector<HTMLButtonElement>('button[aria-label="Edit Website"]')!.click();
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
  expect(doc.querySelector('#monitor-rows')!.textContent).toContain('Website');
  expect(doc.querySelector('#stale')!.hasAttribute('hidden')).toBe(false);
  window.fetch = (async () => new window.Response(JSON.stringify(snapshot()))) as typeof window.fetch;
  await refresh(); expect(doc.querySelector('#stale')!.hasAttribute('hidden')).toBe(true);
  doc.querySelector<HTMLButtonElement>('button[aria-label="Edit Website"]')!.click();
  window.fetch = (async () => new window.Response('not JSON', { status: 401 })) as typeof window.fetch;
  await refresh();
  expect(doc.querySelector('#editor')!.hasAttribute('hidden')).toBe(true);
  expect(doc.querySelector('#monitor-rows')!.textContent).toBe('');
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
  expect(doc.querySelector('#monitor-rows')!.textContent).toContain('Newest');
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
  const timers = new Map<number, () => void>(); let timerId = 0;
  window.setTimeout = ((callback: () => void, delay: number) => { expect(delay).toBe(60000); timers.set(++timerId, callback); return timerId; }) as unknown as typeof window.setTimeout;
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
  const signedOutTick = timers.values().next().value!; timers.clear(); signedOutTick(); await settle(); expect(reads).toBe(3);
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
  doc.querySelector<HTMLButtonElement>('button[aria-label="Edit Private heartbeat"]')!.click();
  doc.querySelector<HTMLButtonElement>('button[aria-label="Declare Maintenance Private heartbeat"]')!.click();
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
  doc.querySelector<HTMLButtonElement>('button[aria-label="Edit Website"]')!.click();
  const name = doc.querySelector<HTMLInputElement>('#name')!; name.value = 'Submitted Monitor';
  doc.querySelector('#configuration')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
  name.value = 'Next Monitor draft';
  resolve(new window.Response(JSON.stringify(snapshot({ monitors: [{ ...monitor, name: 'Submitted Monitor' }] })))); await settle();
  expect(doc.querySelector('#configuration')!.hasAttribute('hidden')).toBe(false);
  expect(name.value).toBe('Next Monitor draft');
});

it('reconciles creation order and publication changes and binds actions to the latest snapshot', async () => {
  const { window, doc, set, refresh } = await mount();
  const oldRow = doc.querySelector('#monitor-rows tr');
  set(snapshot({ paused: true, monitors: [{ ...monitor, id: 'two', name: 'New' }, { ...monitor, name: 'Renamed', published: false, maintenance: { endsAt: 2000000000000 } }] }));
  await refresh();
  expect(doc.querySelectorAll('#monitor-rows tr')[2]).toBe(oldRow);
  expect(oldRow!.textContent).toContain('Private');
  expect(doc.querySelector('#paused')!.hasAttribute('hidden')).toBe(false);
  doc.querySelector<HTMLButtonElement>('button[aria-label="Edit Renamed"]')!.click();
  expect(doc.querySelector<HTMLInputElement>('#name')!.value).toBe('Renamed');
  let request: { path: string; body: string } | undefined;
  window.fetch = (async (path, options) => { request = { path: String(path), body: String(options!.body) }; return new window.Response(JSON.stringify(snapshot())); }) as typeof window.fetch;
  doc.querySelector<HTMLButtonElement>('button[aria-label="Publish Renamed"]')!.click(); await settle();
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
  doc.querySelector<HTMLButtonElement>('button[aria-label="End Maintenance Website"]')!.click();
  doc.querySelector<HTMLButtonElement>('button[aria-label="Declare Maintenance Other"]')!.click();
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
  doc.querySelector<HTMLButtonElement>('button[aria-label="Edit Website"]')!.click();
  const name = doc.querySelector<HTMLInputElement>('#name')!; name.value = 'New draft'; name.focus();
  resolve(new window.Response('{}', { status: 401 })); await settle();
  expect(doc.activeElement).toBe(name);
  expect(name.value).toBe('New draft');
});
