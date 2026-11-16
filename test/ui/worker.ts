// SPDX-License-Identifier: AGPL-3.0-only
import personal, { createHostedWorker } from '../../src/index';
export { MonitoringContext } from '../../src/index';

// Exercise the public hosted adapter through real HTTP in the same UI harness.
const hosted = createHostedWorker({
  contractVersion: '1',
  resolve(request) {
    const token = request.headers.get('authorization');
    return { id: 'ui-hosted', permission: token === 'Bearer ui-editor' ? 'editor' : token === 'Bearer ui-reader' ? 'reader' : null, monitorLimit: 10 };
  },
  contexts: () => ['ui-hosted'],
});
export default {
  fetch(request, env) {
    return (new URL(request.url).hostname === 'localhost' ? hosted : personal).fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
