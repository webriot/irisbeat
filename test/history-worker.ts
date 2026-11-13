// SPDX-License-Identifier: AGPL-3.0-only
import worker, { MonitoringContext as EngineContext } from '../src/index';

// Test-only series fault injection; production exports no control endpoint.
let mode = 'available';
export class MonitoringContext extends EngineContext {
  protected queryHistory(id: string, start: number, end: number) {
    if (mode === 'missing') return null;
    if (mode === 'failed') throw new Error('substituted series query failure');
    return super.queryHistory(id, start, end);
  }
}
export default {
  ...worker,
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname === '/__test-history') {
      mode = new URL(request.url).searchParams.get('mode') ?? 'available';
      return new Response(null, { status: 204 });
    }
    return worker.fetch(request, env);
  },
};
