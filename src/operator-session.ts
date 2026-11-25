// SPDX-License-Identifier: AGPL-3.0-only
import type { mergeScopes, ViewHint, ViewScope } from './view-changes';

type OperatorPartial = { scope: ViewScope; data: { html: string } };
type PartialData = { html: string; revision: number; permission: 'reader' | 'editor' };
type PartialBatch = { revision: number; permission: 'reader' | 'editor'; partials: OperatorPartial[] };

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type OperatorSnapshot = { partials: OperatorPartial[]; permission: 'reader' | 'editor'; hosted: boolean };
type MutationAck = Pick<ViewHint, 'revision' | 'scopes'>;
type ReadHint = ViewHint & { history?: true };
export type SchedulePreview = { explanation: string; timezone: string; occurrences: number[] };
export type ScheduleInput = { cron: string; timezone: string; graceSeconds?: number | null; outbound?: true };
export type LiveSnapshots = (
  path: string,
  read: (current: () => boolean, hint?: ReadHint) => Promise<boolean | void>,
  authorize: () => Promise<string>,
  viewPermission: () => OperatorSnapshot['permission'],
) => { sync(hint?: ReadHint): void; stop(): void };
export interface OperatorSessionCallbacks {
  partials(data: OperatorPartial[]): void;
  snapshot(data: OperatorSnapshot): void;
  pageNameSaved(): void;
  credential(secret: string): void;
  reading?(state: 'pending' | 'success' | 'idle'): void;
  signedOut(): void;
  failed(message: string, reading: boolean): void;
  writing(): () => void;
  saved(path: string, method: Method): void;
  previewed(data: SchedulePreview): void;
  previewFailed(message: string): void;
}

// Self-contained: ui.tsx embeds this factory into the classic Operator script.
export function createOperatorSession(liveSnapshots: LiveSnapshots, mergeViewScopes: typeof mergeScopes, ui: OperatorSessionCallbacks) {
  let secret = '';
  let permission: 'reader' | 'editor' = 'editor';
  let generation = 0;
  let requestVersion = 0;
  let activeRead: { version: number; hint?: ReadHint } | undefined;
  let writeDone: Promise<void> | undefined;
  let pendingRefresh = false;
  let updates: ReturnType<LiveSnapshots> | undefined;
  let previewSequence = 0;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  const applied = new Map<ViewScope, number>();
  // Object methods avoid bundler name helpers outside the stringified factory.
  const lifecycle = {
    latest(started: number, version: number) { return started === generation && version === requestVersion; },
    async readPartials(scopes: ViewScope[], minimum: number, signal: AbortSignal, started: number) {
      const query = new URLSearchParams({ revision: String(minimum) });
      let path = '/api/operator/partials';
      if (scopes.length === 1) path += '/' + scopes[0];
      else for (const scope of scopes) query.append('scope', scope);
      const response = await fetch(path + '?' + query, { headers: { Authorization: 'Bearer ' + secret }, signal });
      if (started === generation && response.status === 401) lifecycle.unauthorized();
      if (!response.ok) throw new Error('Request failed');
      const data = await response.json() as PartialBatch | PartialData;
      if (data.permission !== permission || !Number.isSafeInteger(data.revision) || data.revision < minimum) {
        throw new Error('Revision or permission changed');
      }
      const partials = 'partials' in data ? data.partials : [{ scope: scopes[0], data }];
      if (partials.length !== scopes.length || partials.some(({ scope, data }, index) =>
        scope !== scopes[index] || typeof data.html !== 'string')) throw new Error('Sections unavailable');
      return { revision: data.revision, partials };
    },
    appliedRevision(scope: ViewScope) {
      return Math.max(applied.get(scope) ?? -1, scope.startsWith('monitor/') ? applied.get('monitors') ?? -1 : -1);
    },
    applyPartials({ revision, partials }: Pick<PartialBatch, 'revision' | 'partials'>) {
      ui.partials(partials);
      for (const { scope } of partials) {
        applied.set(scope, revision);
        if (scope === 'monitors') {
          for (const [row, rowRevision] of applied) {
            if (row.startsWith('monitor/') && rowRevision <= revision) applied.delete(row);
          }
        }
      }
    },
    startUpdates() {
      if (updates) return;
      const started = generation;
      updates = liveSnapshots('/api/operator/events/v2', (current, hint) => session.run('/api/operator', 'GET', undefined, undefined, current, hint), async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch('/api/operator/events/ticket', { method: 'POST', headers: { Authorization: 'Bearer ' + secret }, signal: controller.signal });
          if (started !== generation) throw new Error('Session ended');
          if (response.status === 401 || response.status === 403) { lifecycle.unauthorized(); throw new Error('Unauthorized'); }
          if (!response.ok) throw new Error('Subscription unavailable');
          const grant = await response.json() as { ticket: string };
          if (started !== generation) throw new Error('Session ended');
          return grant.ticket;
        } finally { clearTimeout(timeout); }
      }, () => permission);
    },
    unauthorized() { session.signOut(); ui.failed('Unauthorized', false); },
  };
  const session = {
    signIn(credential: string) { ++generation; applied.clear(); secret = credential; return session.run(); },
    signOut() {
      ++generation; ++requestVersion; secret = ''; writeDone = undefined; pendingRefresh = false; activeRead = undefined;
      applied.clear();
      updates?.stop(); updates = undefined;
      session.cancelPreview();
      ui.signedOut();
    },
    async run(path = '/api/operator', method: Method = 'GET', body?: unknown, after?: () => void, current = () => true, hint?: ReadHint): Promise<boolean | void> {
      const reading = method === 'GET';
      const started = generation;
      if (writeDone) {
        if (!reading || hint?.history) return;
        await writeDone;
        if (started === generation && current()) return session.run(path, method, body, after, current, hint);
        return;
      }
      const superseded = !reading && activeRead?.version === requestVersion ? activeRead : undefined;
      const version = ++requestVersion;
      let finish: (() => void) | undefined;
      if (!reading) writeDone = new Promise<void>(resolve => { finish = resolve; });
      else { activeRead = { version, hint }; if (!hint?.history) ui.reading?.('pending'); }
      const finishWriting = reading ? undefined : ui.writing();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let refreshingWrite = false;
      try {
        if (hint) {
          const scopes = mergeViewScopes([], hint.scopes).filter(scope => hint.history || lifecycle.appliedRevision(scope) < hint.revision);
          const batch = scopes.length ? await lifecycle.readPartials(scopes, hint.revision, controller.signal, started) : undefined;
          if (lifecycle.latest(started, version) && current()) {
            if (batch) {
              lifecycle.applyPartials(batch);
              if (!hint.history) ui.reading?.('success');
            }
          }
          return;
        }
        const response = await fetch(path, {
          signal: controller.signal,
          method, headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json', Accept: 'application/vnd.irisbeat.view+json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (started !== generation) return;
        if (response.status === 401 || (reading && response.status === 403)) { lifecycle.unauthorized(); return; }
        if (!lifecycle.latest(started, version)) return;
        const data = await response.json() as (OperatorSnapshot | MutationAck | { secret: string }) & { error?: string };
        if (!lifecycle.latest(started, version)) return;
        if (!response.ok) {
          if (response.status === 403) pendingRefresh = true;
          throw new Error(data.error || 'Request failed');
        }
        if (reading) {
          if (!current()) return;
          if (!('partials' in data)) throw new Error('Snapshot unavailable');
          permission = data.permission;
          applied.clear();
          ui.snapshot(data);
          ui.reading?.('success');
          lifecycle.startUpdates();
        } else {
          if ('secret' in data) ui.credential(data.secret);
          else if ('scopes' in data) {
            refreshingWrite = true;
            if (method === 'PUT' && path === '/api/operator') ui.pageNameSaved();
            try {
              const scopes = mergeViewScopes([], data.scopes);
              if (scopes.length) {
                const batch = await lifecycle.readPartials(scopes, data.revision, controller.signal, started);
                if (!lifecycle.latest(started, version)) return;
                lifecycle.applyPartials(batch);
              }
            } catch {
              if (!lifecycle.latest(started, version)) return;
              ui.failed('Updates unavailable', true);
              pendingRefresh = true;
            }
          } else if ('partials' in data) {
            permission = data.permission;
            applied.clear();
            if (method === 'PUT' && path === '/api/operator') ui.pageNameSaved();
            ui.snapshot(data);
          }
          after?.();
          ui.saved(path, method);
        }
      } catch (error) {
        if (!hint?.history && lifecycle.latest(started, version) && (!reading || current())) {
          ui.failed((error as Error).message, reading);
          return false;
        }
      } finally {
        clearTimeout(timeout);
        if (hint || refreshingWrite) controller.abort();
        if (reading && started === generation && version === activeRead?.version) {
          activeRead = undefined;
          if (!hint?.history) ui.reading?.('idle');
        }
        if (finish) {
          if (started === generation) {
            writeDone = undefined;
            finishWriting?.();
            if (pendingRefresh || (superseded && !superseded.hint?.history)) {
              updates?.sync(pendingRefresh ? undefined : superseded?.hint);
              pendingRefresh = false;
            }
          }
          finish();
        }
      }
    },
    async requestApiKeys<T>(method: 'GET' | 'POST' | 'DELETE', signal: AbortSignal, body?: unknown, id?: string): Promise<T | null | undefined> {
      if (!secret || signal.aborted) return;
      const started = generation;
      const path = '/api/operator/api-keys' + (id ? '/' + encodeURIComponent(id) : '');
      const response = await fetch(path, {
        method,
        headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (started !== generation || signal.aborted) return;
      if (response.status === 401 || response.status === 403) { lifecycle.unauthorized(); return; }
      if (response.status === 204) return null;
      const data = await response.json() as T & { error?: string };
      if (started !== generation || signal.aborted) return;
      if (!response.ok) throw new Error(data.error || 'Request failed');
      return data;
    },
    cancelPreview() {
      ++previewSequence;
      if (previewTimer !== undefined) clearTimeout(previewTimer);
    },
    preview(input: (() => ScheduleInput) | null) {
      session.cancelPreview();
      if (!input || !secret) return;
      const sequence = previewSequence;
      const started = generation;
      previewTimer = setTimeout(async () => {
        try {
          const response = await fetch('/api/operator/schedule-preview', {
            method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' }, body: JSON.stringify(input()),
          });
          if (started !== generation) return;
          if (response.status === 401) { lifecycle.unauthorized(); return; }
          const data = await response.json() as SchedulePreview & { error?: string };
          if (started !== generation || sequence !== previewSequence) return;
          if (!response.ok) throw new Error(data.error || 'Preview unavailable');
          ui.previewed(data);
        } catch (error) {
          if (started === generation && sequence === previewSequence) ui.previewFailed((error as Error).message);
        }
      }, 200);
    },
  };
  return session;
}
