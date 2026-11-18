// SPDX-License-Identifier: AGPL-3.0-only
// Deliberately a package import: this fixture must not resolve repository source.
import { createHostedWorker, MonitoringContext as EngineContext, type EngineEnv, type IncidentTransition, type ScheduledContext } from 'irisbeat';
export { NotificationDelivery } from 'irisbeat';

export class MonitoringContextWithoutQueue extends EngineContext {
  protected async onIncidentTransition(event: IncidentTransition) {
    // The real hosted consumer supplies its own transport/identity mapping here.
    const response = await fetch('https://delivery.example/transitions', { method: 'POST', body: JSON.stringify(event) });
    if (!response.ok) throw new Error('consumer transport failed');
  }
}

export class MonitoringContext extends MonitoringContextWithoutQueue {
  constructor(ctx: DurableObjectState, env: EngineEnv) {
    super(ctx, {
      ...env,
      NOTIFICATION_QUEUE: {
        async sendBatch(messages) {
          const response = await fetch('https://queue.example/accepted', {
            method: 'POST', body: JSON.stringify(Array.from(messages, message => message.body)),
          });
          if (!response.ok) throw new Error('Queue unavailable');
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        },
      },
    });
  }
}

type Policy = { paused: boolean; policyRevision: number };
const operatorPermissions = new Map<string, "editor" | "reader" | null>();
const requestPause = new Map<string, Policy>();
const schedulePause = new Map<string, Policy>();
let delayContexts = false;
let contextOverride: (string | ScheduledContext)[] | undefined;
const app = createHostedWorker({
  contractVersion: '1',
  async resolve(request) {
    const host = new URL(request.url).hostname;
    if (!['a.example', 'b.example', 'ordering.example'].includes(host)) return null;
    const token = request.headers.get('authorization');
    const identity = { id: host, permission: operatorPermissions.has(host) ? operatorPermissions.get(host)! : token === 'Bearer editor' ? 'editor' as const : token === 'Bearer reader' ? 'reader' as const : null, monitorLimit: 2 };
    // This test-only query substitutes trusted policy snapshots from an untyped consumer.
    const query = new URL(request.url).searchParams;
    const policy: Policy | undefined = query.has('test-policy') ? JSON.parse(query.get('test-policy')!) : requestPause.get(host);
    const snapshot = policy ? { ...identity, ...policy } : identity;
    if (new URL(request.url).searchParams.has('test-delay-resolve')) await fetch('https://policy-gate.example/request');
    return snapshot;
  },
  async contexts() {
    const snapshot = contextOverride ?? ['a.example', 'b.example', 'ordering.example'].map(id => {
      const policy = schedulePause.get(id);
      return policy ? { id, ...policy } : id;
    });
    if (delayContexts) {
      delayContexts = false;
      await fetch('https://policy-gate.example/schedule');
    }
    return snapshot;
  },
});
export default {
  async fetch(request: Request, env: Parameters<typeof app.fetch>[1]) {
    const previousNow = Date.now;
    Date.now = () => Number(request.headers.get('x-test-at'));
    try {
      const url = new URL(request.url);
      if (url.pathname === '/test-unsupported-version') {
        try { createHostedWorker({ contractVersion: '2', resolve: () => null, contexts: () => [] }); }
        catch { return new Response(null, { status: 409 }); }
        return new Response(null, { status: 200 });
      }
      if (url.pathname === '/test-operator-permission') {
        const value = url.searchParams.get('value');
        if (value === 'reset') operatorPermissions.delete(url.hostname);
        else operatorPermissions.set(url.hostname, value === 'reader' ? 'reader' : value === 'editor' ? 'editor' : null);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/test-contexts') {
        contextOverride = url.searchParams.has('value') ? JSON.parse(url.searchParams.get('value')!) : undefined;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/test-delay-contexts') {
        delayContexts = true;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/test-pause') {
        const source = url.searchParams.get('source');
        for (const [name, policy] of [['request', requestPause], ['schedule', schedulePause]] as const) {
          if (source && source !== name) continue;
          const value = url.searchParams.get('value');
          if (value === 'omit') policy.delete(url.hostname);
          else policy.set(url.hostname, { paused: value === 'true', policyRevision: Number(url.searchParams.get('policyRevision')) });
        }
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/test-tick') {
        try {
          await app.scheduled({ scheduledTime: Number(url.searchParams.get('at')) } as ScheduledController, env);
        } catch (error) {
          if (url.searchParams.has('expect-reject')) return new Response(null, { status: 409 });
          throw error;
        }
        return new Response('checked');
      }
      return await app.fetch(request, env);
    } finally { Date.now = previousNow; }
  },
};
