import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ADMIN_PASSWORD, gotoLoginHydrated } from './helpers';
import { configureMockOpenAi, startMockAiServer } from './mock-ai-server';

/** 在临时目录造一个「期中」文件夹：每个学生一个子文件夹，外加应被忽略的系统/非图片文件 */
function makeScanFolder(): string {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xueji-folder-import-'));
    const root = path.join(base, '期中扫描');
    const fixture = path.join(__dirname, './fixtures/math_test.png');
    for (const [student, pages] of [['01 张小明', 2], ['李小红', 1]] as const) {
        fs.mkdirSync(path.join(root, student), { recursive: true });
        for (let page = 1; page <= pages; page += 1) fs.copyFileSync(fixture, path.join(root, student, `第${page}页.png`));
    }
    fs.writeFileSync(path.join(root, '.DS_Store'), 'x');
    fs.writeFileSync(path.join(root, '说明.txt'), '说明');
    return root;
}

test('教师端文件夹导入：按子文件夹分份、按名字匹配学生、排队上传判分，重复导入不重复建卷', async ({ browser }) => {
    test.setTimeout(150000);

    const mockAi = await startMockAiServer();
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    let restoreSettings: (() => Promise<void>) | null = null;
    const folder = makeScanFolder();

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const teacherEmail = `teacher-folder-${suffix}@example.com`;
    const teacherPass = 'teacher123456';
    const teacherCtx = await browser.newContext();
    const page = await teacherCtx.newPage();

    try {
        await gotoLoginHydrated(adminPage);
        await adminPage.locator('input[name="email"]').fill('admin@localhost');
        await adminPage.locator('input[name="password"]').fill(ADMIN_PASSWORD);
        await adminPage.locator('button[type="submit"]').click();
        await adminPage.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 });
        restoreSettings = await configureMockOpenAi(adminPage.request, mockAi.baseUrl);

        const regRes = await page.request.post('/api/register', {
            data: { email: teacherEmail, password: teacherPass, name: '导入教师', educationStage: 'junior_high', enrollmentYear: 2024, personas: ['teacher'] },
        });
        expect(regRes.ok()).toBeTruthy();
        await gotoLoginHydrated(page);
        await page.locator('input[name="email"]').fill(teacherEmail);
        await page.locator('input[name="password"]').fill(teacherPass);
        await page.locator('button[type="submit"]').click();
        await page.waitForURL('**/teacher*', { timeout: 15000 });

        await page.goto('/grading');
        await page.locator('textarea').first().fill('初二(3)班\t01\t张小明\n初二(3)班\t02\t李小红');
        await page.getByRole('button', { name: /^(预览|Preview)$/ }).click();
        await page.getByRole('button', { name: /导入 2 名学生|Import 2/ }).click();
        // 等名册真正写入后再建任务，否则任务页拿到的名册可能是空的
        await expect(page.getByText(/2 名学生|2 students/).first()).toBeVisible({ timeout: 10000 });

        await page.getByRole('button', { name: /新建改卷任务|New Grading Task/ }).click();
        await page.locator('#grading-title').fill('文件夹导入测验');
        await page.locator('textarea').first().fill('1 A 5分\n2 主观 5分 写出关键步骤');
        await page.getByRole('button', { name: /创建并继续|Create & Continue/ }).click();
        await page.waitForURL(/\/grading\/[^/]+/, { timeout: 15000 });

        // 收卷页的「批量导入扫描卷」：选整个文件夹
        const panel = page.getByTestId('folder-import');
        await expect(panel.getByRole('button', { name: /导入文件夹|Import folder/ })).toBeVisible();
        await panel.getByTestId('folder-import-dir').setInputFiles(folder);
        await expect(panel.getByTestId('folder-import-summary')).toHaveText(/2 份 · 3 页 · 按名字匹配 2 份|2 papers · 3 pages · 2 matched/);
        await expect(panel.getByText(/已忽略 2 个文件|2 files ignored/)).toBeVisible();
        const rows = panel.getByTestId('folder-import-paper');
        await expect(rows).toHaveCount(2);
        for (const index of [0, 1]) {
            await expect(rows.nth(index).getByText(/按名字匹配|Matched by name/)).toBeVisible();
            await expect(rows.nth(index).locator('select')).not.toHaveValue('');
        }

        await panel.getByRole('button', { name: /开始上传（2 份）|Upload \(2 papers\)/ }).click();
        await expect(panel.getByText(/已完成 2\/2 份|2\/2 papers done/)).toBeVisible({ timeout: 60000 });
        await expect(panel.getByTestId('folder-import-status').filter({ hasText: /已上传$|Uploaded$/ })).toHaveCount(2);

        // 再导入同一个文件夹：服务端按幂等键复用，不重复建卷
        await panel.getByRole('button', { name: /^(清空|Clear)$/ }).click();
        await panel.getByTestId('folder-import-dir').setInputFiles(folder);
        await panel.getByRole('button', { name: /开始上传（2 份）|Upload \(2 papers\)/ }).click();
        await expect(panel.getByTestId('folder-import-status').filter({ hasText: /已上传过|Already uploaded/ })).toHaveCount(2, { timeout: 60000 });

        await page.getByRole('tab', { name: /^(答卷|Papers)$/ }).click();
        await expect(page.locator('a[href*="/submissions/"]')).toHaveCount(2, { timeout: 30000 });
        await expect(page.getByText('张小明').first()).toBeVisible();
        await expect(page.getByText('李小红').first()).toBeVisible();
    } finally {
        if (restoreSettings) await restoreSettings().catch(() => undefined);
        await teacherCtx.close();
        await adminCtx.close();
        await mockAi.close();
        fs.rmSync(path.dirname(folder), { recursive: true, force: true });
    }
});
