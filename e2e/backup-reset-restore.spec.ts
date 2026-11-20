import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptConfirmDialog, ADMIN_PASSWORD, gotoLoginHydrated } from './helpers';

async function openDangerSettingsTab(page: Page) {
    await page.getByRole('button', { name: /^(设置|Settings)$/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
    await page.getByRole('tab', { name: /^(危险|Danger)$/ }).click();
    await expect(page.getByRole('button', { name: /导出全部|Export All/ })).toBeVisible({ timeout: 10000 });
}

test('管理员全量导出 → 系统初始化清空 → 导入归档完整恢复', async ({ page }) => {
    test.setTimeout(120000);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-e2e-backup-'));

    try {
        // 1. 管理员登录并准备具有标识的测试错题本、孩子档案与错题
        await gotoLoginHydrated(page);
        await page.locator('input[name="email"]').fill('admin@localhost');
        await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
        await page.locator('button[type="submit"]').click();
        await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 });

        const personaRes = await page.request.post('/api/persona', {
            data: { personas: ['self', 'parent'], activePersona: 'self' },
        });
        expect(personaRes.ok()).toBeTruthy();

        const marker = `E2E-RESTORE-${Date.now()}`;
        const nbRes = await page.request.post('/api/notebooks', { data: { name: `备份测试本-${marker}`, stage: 'junior_high', subjectKey: 'math' } });
        expect(nbRes.ok()).toBeTruthy();
        const nb = (await nbRes.json()) as { id: string };

        const childRes = await page.request.post('/api/learners', { data: { name: `备份孩子-${marker}` } });
        expect(childRes.ok()).toBeTruthy();
        const child = (await childRes.json()) as { id: string };

        const itemRes = await page.request.post('/api/error-items', {
            data: {
                subjectId: nb.id,
                learnerId: child.id,
                questionText: `待恢复验真题干 ${marker}`,
                answerText: '42',
                analysis: '标准推导步骤',
                knowledgePoints: ['函数单调性'],
            },
        });
        expect(itemRes.ok()).toBeTruthy();

        // 2. 打开设置 -> 危险标签页 -> 点击「导出全部」下载 v3 ZIP
        await openDangerSettingsTab(page);

        const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
        await page.getByRole('button', { name: /导出全部|Export All/ }).click();
        await acceptConfirmDialog(page);
        const download = await downloadPromise;
        const archivePath = path.join(tmpDir, download.suggestedFilename() || 'backup-all.zip');
        await download.saveAs(archivePath);
        expect(fs.statSync(archivePath).size).toBeGreaterThan(500);

        // 3. 触发系统初始化（两步确认：Radix confirmDialog + window.prompt('RESET')）
        page.once('dialog', async (dialog) => {
            expect(dialog.type()).toBe('prompt');
            await dialog.accept('RESET');
        });
        const resetDone = page.waitForResponse(
            (res) => res.url().includes('/api/admin/system-reset') && res.request().method() === 'POST',
        );
        const resetCardButton = page
            .locator('div.p-4.border')
            .filter({ hasText: /系统初始化|System Initialization/ })
            .getByRole('button');
        await resetCardButton.click();
        await acceptConfirmDialog(page);
        expect((await resetDone).status()).toBe(200);

        // 等待页面重载完成并校验全部业务数据已清空
        await page.waitForLoadState('networkidle');
        await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10000 });

        const afterResetItems = (await (await page.request.get('/api/error-items/list')).json()) as { total: number };
        expect(afterResetItems.total).toBe(0);
        const afterResetLearners = (await (await page.request.get('/api/learners')).json()) as { children: Array<{ name: string }> };
        expect(afterResetLearners.children).toHaveLength(0);

        // 4. 在设置 -> 危险标签页选中刚才导出的 ZIP，点击「导入全部」完整恢复
        await openDangerSettingsTab(page);
        await page.setInputFiles('#import-file-input', archivePath);
        const importAllBtn = page.getByRole('button', { name: /导入全部|Import All/ });
        await expect(importAllBtn).toBeVisible({ timeout: 5000 });

        const importDone = page.waitForResponse((res) => res.url().includes('/api/import') && res.request().method() === 'POST');
        await importAllBtn.click();
        await acceptConfirmDialog(page);
        expect((await importDone).status()).toBe(200);

        await page.waitForTimeout(1000);
        await page.waitForLoadState('networkidle');

        // 5. 检验错题、孩子与错题本完整还原并在界面可见
        const restoredLearners = (await (await page.request.get('/api/learners')).json()) as { children: Array<{ name: string }> };
        expect(restoredLearners.children.some((c) => c.name === `备份孩子-${marker}`)).toBeTruthy();

        await page.goto('/notebooks');
        await expect(page.locator('main').getByText(`备份测试本-${marker}`).first()).toBeVisible({ timeout: 15000 });
        await page.locator('main').getByText(`备份测试本-${marker}`).first().click();
        await expect(page.locator('main').getByText(`待恢复验真题干 ${marker}`).first()).toBeVisible({ timeout: 15000 });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
