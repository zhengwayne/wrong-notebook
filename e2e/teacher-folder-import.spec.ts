import { test, expect, type Browser, type Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ADMIN_PASSWORD, gotoLoginHydrated } from './helpers';
import { configureMockOpenAi, startMockAiServer } from './mock-ai-server';
import { makePdf } from '../src/__tests__/helpers/pdf-fixtures';

const fixtureImage = path.join(__dirname, './fixtures/math_test.png');

/** 在临时目录造一个「期中」文件夹：每个学生一个子文件夹，外加应被忽略的系统/非图片文件 */
function makeScanFolder(): string {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xueji-folder-import-'));
    const root = path.join(base, '期中扫描');
    for (const [student, pages] of [['01 张小明', 2], ['李小红', 1]] as const) {
        fs.mkdirSync(path.join(root, student), { recursive: true });
        for (let page = 1; page <= pages; page += 1) fs.copyFileSync(fixtureImage, path.join(root, student, `第${page}页.png`));
    }
    fs.writeFileSync(path.join(root, '.DS_Store'), 'x');
    fs.writeFileSync(path.join(root, '说明.txt'), '说明');
    return root;
}

/** 含 PDF 的文件夹：根目录一个两页 PDF；子文件夹里图片 + 两页 PDF 混排；一个加密 PDF */
function makePdfFolder(): string {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xueji-folder-import-pdf-'));
    const root = path.join(base, '期末PDF');
    fs.mkdirSync(path.join(root, '赵小丽'), { recursive: true });
    fs.writeFileSync(path.join(root, '03 王小刚.pdf'), makePdf(2));
    fs.copyFileSync(fixtureImage, path.join(root, '赵小丽', '1.png'));
    fs.writeFileSync(path.join(root, '赵小丽', '2.pdf'), makePdf(2));
    fs.writeFileSync(path.join(root, '加密卷.pdf'), makePdf(2, { encrypted: true }));
    return root;
}

/** 管理员把 AI 指向 Mock，注册教师、导入名册并新建一个改卷任务，停在任务页 */
async function setupTeacherTask(browser: Browser, roster: string, studentCount: number) {
    const mockAi = await startMockAiServer();
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    const teacherCtx = await browser.newContext();
    const page = await teacherCtx.newPage();
    let restoreSettings: (() => Promise<void>) | null = null;
    const cleanup = async () => {
        if (restoreSettings) await restoreSettings().catch(() => undefined);
        await teacherCtx.close();
        await adminCtx.close();
        await mockAi.close();
    };
    try {
        await gotoLoginHydrated(adminPage);
        await adminPage.locator('input[name="email"]').fill('admin@localhost');
        await adminPage.locator('input[name="password"]').fill(ADMIN_PASSWORD);
        await adminPage.locator('button[type="submit"]').click();
        await adminPage.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 });
        restoreSettings = await configureMockOpenAi(adminPage.request, mockAi.baseUrl);

        const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        const teacherEmail = `teacher-folder-${suffix}@example.com`;
        const teacherPass = 'teacher123456';
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
        await page.locator('textarea').first().fill(roster);
        await page.getByRole('button', { name: /^(预览|Preview)$/ }).click();
        const importButton = page.getByRole('button', { name: new RegExp(`导入 ${studentCount} 名学生|Import ${studentCount}`) });
        await importButton.click();
        // 等名册真正写入（导入按钮消失、班级列表显示人数）后再建任务，否则任务页拿到的名册可能是空的
        await expect(importButton).toBeHidden({ timeout: 10000 });
        await expect(page.getByText(new RegExp(`^(${studentCount} 名学生|${studentCount} students) · `)).first()).toBeVisible({ timeout: 10000 });

        await page.getByRole('button', { name: /新建改卷任务|New Grading Task/ }).click();
        await page.locator('#grading-title').fill('文件夹导入测验');
        await page.locator('textarea').first().fill('1 A 5分\n2 主观 5分 写出关键步骤');
        await page.getByRole('button', { name: /创建并继续|Create & Continue/ }).click();
        await page.waitForURL(/\/grading\/[^/]+/, { timeout: 15000 });
        return { page, cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
}

async function submissionPageCounts(page: Page): Promise<number[]> {
    const taskId = new URL(page.url()).pathname.split('/')[2];
    const task = await (await page.request.get(`/api/grading/tasks/${taskId}`)).json();
    const counts: number[] = [];
    for (const submission of task.submissions as Array<{ id: string }>) {
        const detail = await (await page.request.get(`/api/grading/submissions/${submission.id}`)).json();
        counts.push((detail.images as string[]).length);
    }
    return counts.sort();
}

test('教师端文件夹导入：按子文件夹分份、按名字匹配学生、排队上传判分，重复导入不重复建卷', async ({ browser }) => {
    test.setTimeout(150000);
    const folder = makeScanFolder();
    const { page, cleanup } = await setupTeacherTask(browser, '初二(3)班\t01\t张小明\n初二(3)班\t02\t李小红', 2);
    try {
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
        await cleanup();
        fs.rmSync(path.dirname(folder), { recursive: true, force: true });
    }
});

test('教师端文件夹导入 PDF：PDF 每页成一页、子文件夹里的 PDF 并入该份、加密 PDF 单独报错不影响其他份', async ({ browser }) => {
    test.setTimeout(150000);
    const folder = makePdfFolder();
    const { page, cleanup } = await setupTeacherTask(browser, '初二(4)班\t03\t王小刚\n初二(4)班\t04\t赵小丽', 2);
    try {
        // pdf.js 的 worker 由本站同源提供，未登录也能直接取到
        const anon = await browser.newContext();
        const version = JSON.parse(fs.readFileSync(path.join(__dirname, '../node_modules/pdfjs-dist/package.json'), 'utf8')).version;
        const workerRes = await anon.request.get(`/pdfjs/${version}/pdf.worker.min.mjs`, { maxRedirects: 0 });
        expect(workerRes.status()).toBe(200);
        expect(workerRes.headers()['content-type']).toMatch(/javascript/);
        await anon.close();

        const panel = page.getByTestId('folder-import');
        await panel.getByTestId('folder-import-dir').setInputFiles(folder);
        await expect(panel.getByTestId('folder-import-summary')).toHaveText(/2 份 · 5 页 · 按名字匹配 2 份|2 papers · 5 pages · 2 matched/, { timeout: 20000 });
        const rows = panel.getByTestId('folder-import-paper');
        await expect(rows).toHaveCount(3);
        const encrypted = rows.filter({ hasText: '加密卷' });
        await expect(encrypted.getByText(/PDF 有密码保护|password-protected/)).toBeVisible();
        await expect(encrypted.locator('select')).toBeDisabled();
        await expect(rows.filter({ hasText: '赵小丽' }).getByText(/1\.png、2\.pdf（2 页）|1\.png、2\.pdf \(2 pages\)/)).toBeVisible();

        await panel.getByRole('button', { name: /开始上传（2 份）|Upload \(2 papers\)/ }).click();
        await expect(panel.getByText(/已完成 2\/2 份|2\/2 papers done/)).toBeVisible({ timeout: 60000 });
        await expect(panel.getByTestId('folder-import-status').filter({ hasText: /已上传$|Uploaded$/ })).toHaveCount(2);

        // 王小刚 2 页（整份 PDF），赵小丽 3 页（1 张图 + 2 页 PDF）
        expect(await submissionPageCounts(page)).toEqual([2, 3]);
        await page.getByRole('tab', { name: /^(答卷|Papers)$/ }).click();
        await expect(page.locator('a[href*="/submissions/"]')).toHaveCount(2, { timeout: 30000 });
        await expect(page.getByText('王小刚').first()).toBeVisible();
        await expect(page.getByText('赵小丽').first()).toBeVisible();
    } finally {
        await cleanup();
        fs.rmSync(path.dirname(folder), { recursive: true, force: true });
    }
});
