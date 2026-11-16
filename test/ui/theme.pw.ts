// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

for (const path of ['/', '/operator']) {
  test(`${path} follows System and remembers explicit theme choices`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(path);
    const theme = page.getByRole('combobox', { name: 'Theme', exact: true });
    const scheme = () => page.locator('html').evaluate(node => getComputedStyle(node).colorScheme);
    await expect(theme).toHaveValue('system');
    await expect.poll(scheme).toBe('dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(scheme).toBe('light');
    await theme.selectOption('dark');
    await page.reload();
    await expect(theme).toHaveValue('dark');
    await expect.poll(scheme).toBe('dark');
    await theme.selectOption('light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await expect(theme).toHaveValue('light');
    await expect.poll(scheme).toBe('light');
    await theme.selectOption('system');
    await expect.poll(scheme).toBe('dark');
    await page.reload();
    await expect(theme).toHaveValue('system');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(scheme).toBe('light');
  });
}

for (const path of ['/', '/operator']) {
  for (const failure of ['access', 'write']) {
    test(`${path} themes work with blocked ${failure} storage and keyboard controls`, async ({ page }) => {
      await page.addInitScript(failure => {
        if (failure === 'access') {
          Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage blocked'); } });
        } else {
          Storage.prototype.setItem = Storage.prototype.removeItem = () => { throw new Error('Storage read-only'); };
        }
      }, failure);
      await page.goto(path);
      const theme = page.getByRole('combobox', { name: 'Theme', exact: true });
      await theme.focus();
      await theme.press('End');
      await theme.press('Enter');
      await expect(theme).toHaveValue('dark');
      await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
      await expect(theme).toHaveCSS('outline-style', 'solid');
      await theme.selectOption('light');
      await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
      await page.reload();
      await expect(theme).toHaveValue('system');
    });
  }
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const width of [390, 1280]) {
    for (const path of ['/', '/operator']) {
      test(`${path} compact ${colorScheme} layout at ${width}px preserves editor drafts`, async ({ page, request }, testInfo) => {
        const headers = { Authorization: 'Bearer ui-test-secret' };
        const response = await request.post('/api/operator/monitors', {
          headers, data: { name: 'Theme layout Monitor', url: 'https://example.invalid', kind: 'http' },
        });
        expect(response.ok()).toBeTruthy();
        const created = (await response.json()).monitors.at(-1).id;
        try {
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ colorScheme });
          await page.goto(path);
          if (path === '/operator') {
            await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
            await page.getByRole('button', { name: 'Sign in', exact: true }).click();
            await page.getByRole('button', { name: 'New Monitor', exact: true }).click();
            await page.getByLabel('Monitor name', { exact: true }).fill('Unsaved draft');
            await expect(page.locator('#configuration')).toHaveCSS('border-radius', '12px');
          }
          await expect(page.locator('h1')).toHaveCSS('font-size', width === 390 ? '24px' : '28px');
          await expect(page.locator('html')).toHaveCSS('color-scheme', colorScheme);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
          await page.screenshot({ path: testInfo.outputPath('layout.png'), fullPage: true });
          await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(colorScheme === 'dark' ? 'light' : 'dark');
          if (path === '/operator') {
            await expect(page.getByLabel('Monitor name', { exact: true })).toHaveValue('Unsaved draft');
            const stored = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
            expect(stored).toEqual({ local: { 'irisbeat-theme': colorScheme === 'dark' ? 'light' : 'dark' }, session: {} });
          }
        } finally {
          await request.delete('/api/operator/monitors/' + created, { headers });
        }
      });
    }
  }
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`empty input boundaries have readable contrast in ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto('/operator');
    const contrast = await page.getByLabel('Installation secret', { exact: true }).evaluate(input => {
      const luminance = (color: string) => {
        const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const style = getComputedStyle(input);
      const border = luminance(style.borderTopColor);
      return [style.backgroundColor, getComputedStyle(input.closest('form')!).backgroundColor].map(color => {
        const background = luminance(color);
        return (Math.max(border, background) + 0.05) / (Math.min(border, background) + 0.05);
      });
    });
    for (const ratio of contrast) expect(ratio).toBeGreaterThanOrEqual(3);
  });
}
