// SPDX-License-Identifier: AGPL-3.0-only
import worker, { MonitoringContext as EngineContext, type NotificationQueueJob } from '../src/index';

// Test-only series fault injection; production exports no control endpoint.
let mode = 'available';
let historyReads = 0;
let queued: NotificationQueueJob[] = [];
let queueUnavailable = false;
export class MonitoringContext extends EngineContext {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, {
      ...env,
      NOTIFICATION_QUEUE: {
        async sendBatch(messages) {
          if (queueUnavailable) throw new Error("substituted private Queue error");
          queued.push(...Array.from(messages, message => message.body));
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        },
      },
    });
  }

  protected queryHistory(id: string, start: number, end: number) {
    historyReads++;
    if (mode === 'missing') return null;
    if (mode === 'failed') throw new Error('substituted series query failure');
    return super.queryHistory(id, start, end);
  }
}
export default {
  ...worker,
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === '/__test-notification-queue') {
      if (request.method === 'DELETE') {
        queued = [];
        queueUnavailable = url.searchParams.has('unavailable');
        return new Response(null, { status: 204 });
      }
      return Response.json(queued);
    }
    if (url.pathname === '/__test-history') {
      if (request.method === 'GET' && url.searchParams.has('reads')) return Response.json(historyReads);
      historyReads = 0;
      mode = url.searchParams.get('mode') ?? 'available';
      return new Response(null, { status: 204 });
    }
    return worker.fetch(request, env);
  },
};
