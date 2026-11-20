import { test, expect } from '@playwright/test';
import path from 'path';
import { ADMIN_PASSWORD, gotoLoginHydrated } from './helpers';
import { configureMockOpenAi, startMockAiServer } from './mock-ai-server';

test('教师端闭环：建班导花名册 → 新建批改任务 → 收卷 Mock 判分 → 确认导入错题 → 学生档案与班级学习路径可见', async ({ browser }) => {
    test.setTimeout(120000);

    const mockAi = await startMockAiServer();
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    let restoreSettings: (() => Promise<void>) | null = null;

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const teacherEmail = `teacher-e2e-${suffix}@example.com`;
    const teacherPass = 'teacher123456';

    const teacherCtx = await browser.newContext();
    const page = await teacherCtx.newPage();

    try {
        // 1. 管理员将全局 AI 指向本地 OpenAI Mock Server
        await gotoLoginHydrated(adminPage);
        await adminPage.locator('input[name="email"]').fill('admin@localhost');
        await adminPage.locator('input[name="password"]').fill(ADMIN_PASSWORD);
        await adminPage.locator('button[type="submit"]').click();
        await adminPage.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 });
        restoreSettings = await configureMockOpenAi(adminPage.request, mockAi.baseUrl);

        // 2. 注册并登录纯教师身份账号
        const regRes = await page.request.post('/api/register', {
            data: {
                email: teacherEmail,
                password: teacherPass,
                name: '测试教师',
                educationStage: 'junior_high',
                enrollmentYear: 2024,
                personas: ['teacher'],
            },
        });
        expect(regRes.ok()).toBeTruthy();

        await gotoLoginHydrated(page);
        await page.locator('input[name="email"]').fill(teacherEmail);
        await page.locator('input[name="password"]').fill(teacherPass);
        await page.locator('button[type="submit"]').click();
        await page.waitForURL('**/teacher*', { timeout: 15000 });

        // 3. 前往 /grading 通过名册导入新建「初二(1)班」与学生「张小明 (学号 01)」
        await page.goto('/grading');
        const rosterBox = page.locator('textarea').first();
        await rosterBox.fill('初二(1)班\t01\t张小明');
        await page.getByRole('button', { name: /^(预览|Preview)$/ }).click();
        await expect(page.getByRole('button', { name: /导入 1 名学生|Import 1/ })).toBeVisible({ timeout: 10000 });
        await page.getByRole('button', { name: /导入 1 名学生|Import 1/ }).click();
        await expect(page.getByText('初二(1)班').first()).toBeVisible({ timeout: 10000 });

        // 4. 新建改卷任务（含客观题和主观题）
        await page.getByRole('button', { name: /新建改卷任务|New Grading Task/ }).click();
        await page.locator('#grading-title').fill('期中摸底测验');
        await page.locator('textarea').first().fill('1 A 5分\n2 主观 5分 写出关键步骤');
        await page.getByRole('button', { name: /创建并继续|Create & Continue/ }).click();
        await page.waitForURL(/\/grading\/[^/]+/, { timeout: 15000 });

        // 5. 收卷拍照上传学生答卷并触发 Mock 判分
        const fixturePath = path.join(__dirname, './fixtures/math_test.png');
        await page.locator('input[type="file"]').nth(1).setInputFiles(fixturePath);
        await expect(page.getByText('张小明').first()).toBeVisible({ timeout: 25000 });
        await page.getByRole('button', { name: /^(完成|Done)$/ }).click();
        await expect(page.getByText(/已上传 1 份判分|Uploaded 1/)).toBeVisible({ timeout: 15000 });

        // 6. 切到「答卷」标签页，等待判分完成并进入复核页确认导入错题
        await page.getByRole('tab', { name: /^(答卷|Papers)$/ }).click();
        await expect(page.getByText(/待复核|Graded/)).toBeVisible({ timeout: 30000 });

        await page.locator('a[href*="/submissions/"]').first().click();
        await page.waitForURL(/\/grading\/[^/]+\/submissions\/[^/]+/, { timeout: 15000 });
        await expect(page.getByRole('button', { name: /确认并导入错题本|Confirm & Import/ })).toBeVisible({ timeout: 15000 });
        await page.getByRole('button', { name: /确认并导入错题本|Confirm & Import/ }).click();

        // 等待确认完成提示（精确匹配 toast，避免命中页面上的「已确认」状态徽章）
        await expect(page.getByText(/已确认，\d+\s*道错题|Added \d+ mistakes/i)).toBeVisible({ timeout: 15000 });

        // 7. 验证教师首页学生档案页面与班级学习路径可见
        await page.goto('/teacher');
        await expect(page.getByText('张小明').first()).toBeVisible({ timeout: 15000 });
        await page.locator('a[href*="/teacher/students/"]').first().click();
        await page.waitForURL(/\/teacher\/students\/[^/]+/, { timeout: 15000 });
        await expect(page.locator('main').getByText('张小明').first()).toBeVisible({ timeout: 15000 });

        await page.goto('/learn?tab=class');
        await expect(page.getByText('张小明').first()).toBeVisible({ timeout: 15000 });
    } finally {
        if (restoreSettings) await restoreSettings().catch(() => undefined);
        await teacherCtx.close();
        await adminCtx.close();
        await mockAi.close();
    }
});
