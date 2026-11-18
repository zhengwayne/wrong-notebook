import { expect, type Page } from '@playwright/test';

/**
 * 确认页面内的确认框（FeedbackHost 渲染，替代原生 confirm）。
 * 确认框可能叠在设置等对话框之上，按标题定位以免点到其他对话框的按钮。
 */
export async function acceptConfirmDialog(page: Page) {
    const confirmDialog = page.getByRole('dialog').filter({
        has: page.getByRole('heading', { name: /请确认|Please confirm/ }),
    });
    await expect(confirmDialog).toBeVisible({ timeout: 5000 });
    await confirmDialog.getByRole('button', { name: /^(确认|Confirm)$/ }).click();
    await expect(confirmDialog).not.toBeVisible({ timeout: 5000 });
}

/** 各用例登录用的管理员密码，需先运行 scripts/prepare-e2e.js 设置（默认管理员会被强制改密） */
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'e2e-admin-pass';

/** 访问登录页并等待水合与 NextAuth 初始会话请求完成，避免并发 CSRF cookie 覆盖或水合前提交 */
export async function gotoLoginHydrated(page: Page) {
    const statusDone = page.waitForResponse((response) => response.url().endsWith('/api/register/status'));
    const sessionDone = page.waitForResponse((response) => response.url().endsWith('/api/auth/session'));
    await page.goto('/login');
    await Promise.all([statusDone, sessionDone]);
    await page.waitForLoadState('networkidle');
}
