// SPDX-License-Identifier: AGPL-3.0-only
import personal, { createHostedWorker } from '../../src/index';
export { MonitoringContext } from '../../src/index';

// Test-only trusted host/token resolution; never shipped in the engine artifact.
const hosted = createHostedWorker({
  contractVersion: '1',
  resolve(request) {
    const token = request.headers.get('authorization');
    return {
      id: 'ui-hosted', monitorLimit: 10,
      permission: token === 'Bearer ui-editor' ? 'editor' : token === 'Bearer ui-reader' ? 'reader' : null,
    };
  },
  contexts: () => ['ui-hosted'],
});
export default {
  fetch(request, env) {
    return (new URL(request.url).hostname === 'localhost' ? hosted : personal).fetch(request, env);
  },
  scheduled: personal.scheduled,
} satisfies ExportedHandler<Env>;
