// SPDX-License-Identifier: AGPL-3.0-only
import type { Route } from '@playwright/test';

export async function fulfillView(route: Route, options: NonNullable<Parameters<Route['fulfill']>[0]>) {
  const data = options.json;
  if (typeof data?.pageName !== 'string' || !Array.isArray(data.monitors)) return route.fulfill(options);
  // Load the Worker-side renderer through Playwright's loader without adding Worker globals to the browser test types.
  const renderer = '../../src/ui.tsx';
  const { renderViewSnapshot } = await import(renderer);
  const snapshot = { incidents: [], ...data };
  if (new URL(route.request().url()).pathname === '/api/status') {
    return route.fulfill({ ...options, json: renderViewSnapshot(snapshot, 'public', false) });
  }
  const permission = data.permission === 'reader' ? 'reader' : 'editor';
  return route.fulfill({ ...options, json: {
    ...renderViewSnapshot(snapshot, permission, permission === 'editor' && data.emailConfigured === true),
    permission, hosted: !!data.hosted,
  } });
}
