// SPDX-License-Identifier: AGPL-3.0-only
import worker, { type Status } from '../../src/index';
import { statusPage } from '../../src/ui';
export { MonitoringContext } from '../../src/index';

// Browser fixtures use the production renderer without fabricating persisted observations.
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/__ui/status' && request.method === 'POST') {
      return new Response(statusPage(await request.json() as Status), { headers: { 'Content-Type': 'text/html' } });
    }
    return worker.fetch!(request, env);
  },
  scheduled: worker.scheduled,
} satisfies ExportedHandler<Env>;
