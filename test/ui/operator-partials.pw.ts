// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { monitorAction } from './actions';

test('one section read applies a Monitor deletion and acknowledges its live hint while keeping a draft', async ({ page, request }) => {
  const headers = { Authorization: 'Bearer ui-test-secret', Accept: 'application/vnd.irisbeat.view+json' };
  const draftMonitor = 'Batched draft ' + Date.now();
  const deletedMonitor = 'Batched deletion ' + Date.now();
  const ids: string[] = [];
  try {
    for (const name of [draftMonitor, deletedMonitor]) {
      const created = await request.post('/api/operator/monitors', {
        headers: { Authorization: headers.Authorization }, data: { name, kind: 'heartbeat', published: false },
      });
      expect(created.status()).toBe(201);
      ids.push((await created.json()).monitors.at(-1).id);
    }
    let live!: WebSocketRoute;
    let acknowledgments = 0;
    await page.routeWebSocket('**/api/operator/events/v2', socket => {
      live = socket;
      socket.onMessage(message => {
        if (message === 'ack') acknowledgments++;
        else socket.send('authorized');
      });
    });
    let snapshots = 0;
    page.on('response', response => {
      if (response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/operator') snapshots++;
    });
    await page.goto('/operator');
    await page.getByLabel('Installation secret').fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(() => snapshots).toBe(2);
    await monitorAction(page, 'Edit ' + draftMonitor);
    const draft = page.getByLabel('Monitor name', { exact: true });
    await draft.fill(draftMonitor + ' unsaved');
    await draft.evaluate(input => input.setAttribute('data-test-draft', 'retained'));

    const reads: URL[] = [];
    page.on('request', req => {
      const url = new URL(req.url());
      if (req.method() === 'GET' && url.pathname.startsWith('/api/operator')) reads.push(url);
    });
    const path = '/api/operator/monitors/' + ids[1];
    await page.route('**' + path, async route => {
      const response = await route.fetch();
      const { revision } = await response.json();
      // Deliver the hint before the write acknowledgment reaches the page.
      live.send(JSON.stringify({ type: 'changed', revision, scopes: ['monitor/' + ids[0], 'incidents'] }));
      await route.fulfill({ response });
    });
    page.once('dialog', dialog => dialog.accept());
    await monitorAction(page, 'Delete ' + deletedMonitor);

    await expect(page.getByRole('cell', { name: deletedMonitor, exact: true })).toHaveCount(0);
    await expect(page.getByRole('cell', { name: draftMonitor, exact: true })).toBeVisible();
    await expect(draft).toHaveValue(draftMonitor + ' unsaved');
    await expect(draft).toHaveAttribute('data-test-draft', 'retained');
    await expect.poll(() => acknowledgments).toBe(1);
    expect(reads.map(url => url.pathname)).toEqual(['/api/operator/partials']);
    expect(reads[0].searchParams.getAll('scope')).toEqual(['monitors', 'incidents']);
  } finally {
    for (const id of ids) await request.delete('/api/operator/monitors/' + id, { headers });
  }
});
