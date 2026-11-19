// SPDX-License-Identifier: AGPL-3.0-only
import worker, { MonitoringContext as EngineContext, type NotificationQueueJob } from '../src/index';
import { availabilityFixture } from './availability-fixture';

// Test-only series fault injection; production exports no control endpoint.
const analytics = availabilityFixture();
let backend = 'managed';
let interruptObservation = false;
let queued: NotificationQueueJob[] = [];
let queueUnavailable = false;
let checkFloor: string | undefined;
let useWallClock = false;
export class MonitoringContext extends EngineContext {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, {
      ...env,
      get AVAILABILITY_HISTORY() { return backend === 'unconfigured' ? undefined : analytics.bindings.AVAILABILITY_HISTORY; },
      get AVAILABILITY_QUERY() { return backend === 'managed' ? analytics.bindings.AVAILABILITY_QUERY : undefined; },
      get AVAILABILITY_ACCOUNT_ID() { return backend === 'direct' ? 'a'.repeat(32) : undefined; },
      get AVAILABILITY_API_TOKEN() { return backend === 'direct' ? 'test-analytics-token' : undefined; },
      get MIN_CHECK_INTERVAL_SECONDS() { return checkFloor; },
      NOTIFICATION_QUEUE: {
        async sendBatch(messages) {
          if (queueUnavailable) throw new Error("substituted private Queue error");
          queued.push(...Array.from(messages, message => message.body));
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        },
      },
    });
  }

  protected override publishViewChanges(...args: Parameters<EngineContext['publishViewChanges']>) {
    if (interruptObservation) throw new Error('Interrupted before Analytics Engine handoff');
    super.publishViewChanges(...args);
  }

  protected outboundStartTime(scheduledAt: number) {
    // Most suites advance a synthetic cron clock and control the request clock separately.
    return useWallClock ? super.outboundStartTime(scheduledAt) : scheduledAt;
  }
}
export default {
  ...worker,
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === '/__test-check-floor' && request.method === 'PUT') {
      checkFloor = url.searchParams.get('seconds') ?? undefined;
      useWallClock = url.searchParams.has('wall-clock');
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/__test-notification-queue') {
      if (request.method === 'DELETE') {
        queued = [];
        queueUnavailable = url.searchParams.has('unavailable');
        return new Response(null, { status: 204 });
      }
      return Response.json(queued);
    }
    if (url.pathname === '/__test-history') {
      if (!url.searchParams.has('mode')) return Response.json({ points: analytics.points, queries: analytics.queries });
      const mode = url.searchParams.get('mode')!;
      backend = mode === 'unconfigured' || mode === 'direct' ? mode : 'managed';
      interruptObservation = mode === 'interrupt-observation';
      analytics.setMode(mode);
      return new Response(null, { status: 204 });
    }
    return worker.fetch(request, env);
  },
};
