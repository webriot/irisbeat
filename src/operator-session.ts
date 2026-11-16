// SPDX-License-Identifier: AGPL-3.0-only
import type { Status } from './index';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type OperatorResponse = Status | { secret: string };
export type SchedulePreview = { explanation: string; timezone: string; occurrences: number[] };
export type ScheduleInput = { cron: string; timezone: string; graceSeconds?: number | null };
export type LiveSnapshots = (
  path: string,
  read: (current: () => boolean) => Promise<boolean | void>,
  authorize: () => Promise<string>,
) => { sync(): void; stop(): void };
export interface OperatorSessionCallbacks {
  received(data: OperatorResponse, savedField?: 'pageName' | 'webhookUrl'): void;
  signedOut(): void;
  failed(message: string, reading: boolean): void;
  writing(): () => void;
  saved(path: string, method: Method): void;
  previewed(data: SchedulePreview): void;
  previewFailed(message: string): void;
}

// Self-contained: ui.tsx embeds this factory into the classic Operator script.
export function createOperatorSession(liveSnapshots: LiveSnapshots, ui: OperatorSessionCallbacks) {
  let secret = '';
  let generation = 0;
  let requestVersion = 0;
  let busy = false;
  let pendingRefresh = false;
  let updates: ReturnType<LiveSnapshots> | undefined;
  let previewSequence = 0;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  // Object methods avoid bundler name helpers outside the stringified factory.
  const lifecycle = {
    startUpdates() {
      if (updates) return;
      const started = generation;
      updates = liveSnapshots('/api/operator/events', current => session.run('/api/operator', 'GET', undefined, undefined, current), async () => {
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
      });
    },
    unauthorized() { session.signOut(); ui.failed('Unauthorized', false); },
  };
  const session = {
    signIn(credential: string) { ++generation; secret = credential; return session.run(); },
    signOut() {
      ++generation; ++requestVersion; secret = ''; busy = false; pendingRefresh = false;
      updates?.stop(); updates = undefined;
      session.cancelPreview();
      ui.signedOut();
    },
    async run(path = '/api/operator', method: Method = 'GET', body?: unknown, after?: (data: OperatorResponse) => void, current = () => true) {
      const reading = method === 'GET';
      if (busy) { if (reading) pendingRefresh = true; return; }
      const version = ++requestVersion;
      const started = generation;
      if (!reading) busy = true;
      const finishWriting = reading ? undefined : ui.writing();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(path, {
          signal: controller.signal,
          method, headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (started !== generation) return;
        if (response.status === 401 || (reading && response.status === 403)) { lifecycle.unauthorized(); return; }
        if (version !== requestVersion) return;
        const data = await response.json() as OperatorResponse & { error?: string };
        if (started !== generation || version !== requestVersion) return;
        if (!response.ok) throw new Error(data.error || 'Request failed');
        if (reading && !current()) return;
        ui.received(data, method === 'PUT' ? (path === '/api/operator' ? 'pageName' : path === '/api/operator/webhook' ? 'webhookUrl' : undefined) : undefined);
        lifecycle.startUpdates();
        if (after) after(data);
        if (!reading) ui.saved(path, method);
      } catch (error) {
        if (started === generation && version === requestVersion) ui.failed((error as Error).message, reading);
        return false;
      } finally {
        clearTimeout(timeout);
        if (!reading && started === generation) {
          busy = false; finishWriting?.();
          if (pendingRefresh) { pendingRefresh = false; updates?.sync(); }
        }
      }
    },
    cancelPreview() {
      ++previewSequence; clearTimeout(previewTimer);
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
