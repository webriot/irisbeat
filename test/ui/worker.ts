// SPDX-License-Identifier: AGPL-3.0-only
import { renderViewSnapshot, statusPage, type StatusProjection } from '../../src/ui';
import personal, { createHostedWorker, MonitoringContext as EngineContext } from '../../src/index';
import { availabilityFixture } from '../availability-fixture';

const analytics = availabilityFixture();
export class MonitoringContext extends EngineContext {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, { ...env, ...analytics.bindings });
  }
}

// Test-only trusted host/token resolution; never shipped in the engine artifact.
const hosted = createHostedWorker({
  contractVersion: '1',
  resolve(request) {
    const token = request.headers.get('authorization');
    if (token === 'Bearer ui-partials-editor') return { id: 'ui-operator-partials', monitorLimit: 10, permission: 'editor' };
    return {
      id: 'ui-hosted', monitorLimit: 10,
      permission: token === 'Bearer ui-editor' ? 'editor' : token === 'Bearer ui-reader' ? 'reader' : null,
    };
  },
  contexts: () => ['ui-hosted'],
});
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/__ui/operator' && request.method === 'POST') {
      return Response.json({ ...renderViewSnapshot(await request.json<StatusProjection>(), 'editor', false), permission: 'editor', hosted: false });
    }
    if (path === '/__ui/status' && request.method === 'POST') {
      return new Response(statusPage(await request.json<StatusProjection>()), { headers: { 'Content-Type': 'text/html' } });
    }
    return (new URL(request.url).hostname === 'localhost' ? hosted : personal).fetch(request, env);
  },
  scheduled: personal.scheduled,
} satisfies ExportedHandler<Env>;
