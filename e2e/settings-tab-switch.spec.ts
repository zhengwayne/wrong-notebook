import { expect, test } from '@playwright/test';
import { ADMIN_PASSWORD, gotoLoginHydrated } from './helpers';

test('切换设置标签时对话框节点保持不变且高度不坍缩', async ({ page }) => {
    test.setTimeout(60000);
    await gotoLoginHydrated(page);
    await page.locator('input[name="email"]').fill('admin@localhost');
    await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/', { timeout: 15000 });

    await page.getByRole('button', { name: /^(设置|Settings)$/ }).click();
    const dialog = page.getByTestId('settings-dialog').or(page.getByRole('dialog'));
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.getByRole('tab', { name: /通用|General/ })).toBeVisible();

    const handle = await dialog.elementHandle();
    expect(handle).not.toBeNull();
    const startBox = await dialog.boundingBox();
    expect(startBox?.height).toBeGreaterThan(200);

    const heights: number[] = [];
    await page.evaluate(() => {
        const el = document.querySelector('[data-testid="settings-dialog"], [role="dialog"]');
        (window as unknown as { __heights: number[] }).__heights = [];
        const t0 = performance.now();
        const poll = () => {
            const r = el?.getBoundingClientRect();
            (window as unknown as { __heights: number[] }).__heights.push(r ? r.height : 0);
            if (performance.now() - t0 < 1500) requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
    });

    await dialog.getByRole('tab', { name: /账户|Account/ }).click();
    await expect(dialog.getByText(/更新个人信息|Update Profile/)).toBeVisible({ timeout: 8000 });
    await page.waitForTimeout(400);

    const same = await page.evaluate((el) => el === document.querySelector('[data-testid="settings-dialog"], [role="dialog"]'), handle);
    expect(same).toBe(true);
    heights.push(...await page.evaluate(() => (window as unknown as { __heights: number[] }).__heights || []));
    const minH = Math.min(...heights.filter((h) => h > 0));
    expect(minH, `dialog height dropped to ${minH}, start=${startBox?.height}`).toBeGreaterThan((startBox?.height ?? 0) * 0.8);
    await expect(dialog.getByRole('tablist')).toBeVisible();
    await expect(dialog.getByTestId('settings-tab-panel')).toBeVisible();
});
