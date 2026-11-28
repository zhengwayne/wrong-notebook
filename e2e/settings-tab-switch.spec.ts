import { expect, test } from '@playwright/test';
import { ADMIN_PASSWORD, gotoLoginHydrated } from './helpers';

test('切换任一设置标签到账户时对话框矩形保持不变', async ({ page, context }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 200,
        downloadThroughput: (1.5 * 1024 * 1024) / 8,
        uploadThroughput: (750 * 1024) / 8,
    });

    await gotoLoginHydrated(page);
    await page.locator('input[name="email"]').fill('admin@localhost');
    await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/', { timeout: 15000 });

    await page.getByRole('button', { name: /^(设置|Settings)$/ }).click();
    const dialog = page.getByTestId('settings-dialog').or(page.getByRole('dialog'));
    await expect(dialog).toBeVisible({ timeout: 5000 });

    const handle = await dialog.elementHandle();
    expect(handle).not.toBeNull();

    const tabLabels = await dialog.getByRole('tab').allTextContents();
    const names = (await Promise.all(
        (await dialog.getByRole('tab').all()).map(async (tab) => (await tab.getAttribute('aria-label')) || (await tab.innerText())),
    )).map((n) => n.trim()).filter(Boolean);
    expect(names.length).toBeGreaterThanOrEqual(4);

    const accountTab = dialog.getByRole('tab', { name: /账户|Account/ });

    for (const name of names) {
        if (/账户|Account/.test(name)) continue;
        await dialog.getByRole('tab', { name }).click();
        await page.waitForTimeout(200);

        await page.evaluate(() => {
            const el = document.querySelector('[data-testid="settings-dialog"], [role="dialog"]') as HTMLElement | null;
            const frames: Array<{ top: number; width: number; height: number }> = [];
            const t0 = performance.now();
            const poll = () => {
                const r = el?.getBoundingClientRect();
                if (r) frames.push({ top: r.top, width: r.width, height: r.height });
                if (performance.now() - t0 < 2000) requestAnimationFrame(poll);
            };
            (window as unknown as { __rectFrames: typeof frames }).__rectFrames = frames;
            requestAnimationFrame(poll);
        });

        await accountTab.click();
        await expect(dialog.getByText(/更新个人信息|Update Profile/)).toBeVisible({ timeout: 8000 });
        await page.waitForTimeout(400);

        const same = await page.evaluate((el) => el === document.querySelector('[data-testid="settings-dialog"], [role="dialog"]'), handle);
        expect(same, `dialog remounted when switching from ${name}`).toBe(true);

        const frames = await page.evaluate(() => (window as unknown as { __rectFrames: Array<{ top: number; width: number; height: number }> }).__rectFrames || []);
        expect(frames.length).toBeGreaterThan(5);
        const dTop = Math.max(...frames.map((f) => f.top)) - Math.min(...frames.map((f) => f.top));
        const dH = Math.max(...frames.map((f) => f.height)) - Math.min(...frames.map((f) => f.height));
        const dW = Math.max(...frames.map((f) => f.width)) - Math.min(...frames.map((f) => f.width));
        expect(dTop, `top moved ${dTop}px from ${name}`).toBeLessThanOrEqual(0.5);
        expect(dH, `height moved ${dH}px from ${name}`).toBeLessThanOrEqual(0.5);
        expect(dW, `width moved ${dW}px from ${name}`).toBeLessThanOrEqual(0.5);
    }

    await expect(dialog.getByRole('tablist')).toBeVisible();
    await expect(dialog.getByTestId('settings-tab-panel')).toBeVisible();
    void tabLabels;
});
