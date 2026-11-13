// SPDX-License-Identifier: AGPL-3.0-only
// Deliberately a package import: this fixture must not resolve repository source.
import { createHostedWorker, MonitoringContext as EngineContext, type IncidentTransition } from 'irisbeat';
export class MonitoringContext extends EngineContext {
  protected async onIncidentTransition(event: IncidentTransition) {
    // The real hosted consumer supplies its own transport/identity mapping here.
    const response = await fetch('https://delivery.example/transitions', { method: 'POST', body: JSON.stringify(event) });
    if (!response.ok) throw new Error('consumer transport failed');
  }
}
const app = createHostedWorker({
  contractVersion: '1',
  resolve(request) {
    const host = new URL(request.url).hostname;
    if (!['a.example', 'b.example'].includes(host)) return null;
    const token = request.headers.get('authorization');
    return { id: host, permission: token === 'Bearer editor' ? 'editor' : token === 'Bearer reader' ? 'reader' : null, monitorLimit: 2 };
  },
  contexts: () => ['a.example', 'b.example'],
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
      if (url.pathname === '/test-tick') {
        await app.scheduled({ scheduledTime: Number(url.searchParams.get('at')) } as ScheduledController, env);
        return new Response('checked');
      }
      return await app.fetch(request, env);
    } finally { Date.now = previousNow; }
  },
};
