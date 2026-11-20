import { test, expect } from '@playwright/test';
import path from 'path';
import { ADMIN_PASSWORD, gotoLoginHydrated } from './helpers';
import { configureMockOpenAi, startMockAiServer } from './mock-ai-server';

test('家长端闭环：新建孩子 → 上传试卷 → Mock AI 识别 → 改判确认入库 → 错题本与学习路径可见（390px 移动视口）', async ({ browser }) => {
    test.setTimeout(120000);

    const mockAi = await startMockAiServer();
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    let restoreSettings: (() => Promise<void>) | null = null;

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const parentEmail = `parent-e2e-${suffix}@example.com`;
    const parentPass = 'parent123456';

    const parentCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await parentCtx.newPage();

    try {
        // 1. 管理员登录并临时切换全局 AI 到本地 OpenAI Mock Server
        await gotoLoginHydrated(adminPage);
        await adminPage.locator('input[name="email"]').fill('admin@localhost');
        await adminPage.locator('input[name="password"]').fill(ADMIN_PASSWORD);
        await adminPage.locator('button[type="submit"]').click();
        await adminPage.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 });
        restoreSettings = await configureMockOpenAi(adminPage.request, mockAi.baseUrl);

        // 2. 注册并登录纯家长身份账户
        const regRes = await page.request.post('/api/register', {
            data: {
                email: parentEmail,
                password: parentPass,
                name: '测试家长',
                educationStage: 'junior_high',
                enrollmentYear: 2024,
                personas: ['parent'],
            },
        });
        expect(regRes.ok()).toBeTruthy();

        await gotoLoginHydrated(page);
        await page.locator('input[name="email"]').fill(parentEmail);
        await page.locator('input[name="password"]').fill(parentPass);
        await page.locator('button[type="submit"]').click();
        await page.waitForURL('**/parent*', { timeout: 15000 });

        // 3. 添加孩子「小宝」
        const childInput = page.getByPlaceholder(/例如：大宝|Child|孩子/i);
        await childInput.fill('小宝');
        await page.getByRole('button', { name: /添加|Add/ }).click();
        await expect(page.getByText('小宝').first()).toBeVisible({ timeout: 10000 });

        // 4. 前往上传卷子页面并上传测试试卷
        await page.getByRole('link', { name: /上传卷子|Upload paper/ }).click();
        await page.waitForURL('**/parent/papers/new*', { timeout: 15000 });

        const fixturePath = path.join(__dirname, './fixtures/math_test.png');
        await page.locator('input[type="file"]').first().setInputFiles(fixturePath);
        await expect(page.getByText(/第 1 页|Page 1/)).toBeVisible({ timeout: 15000 });

        await page.getByRole('button', { name: /开始识别|Start recognition/ }).click();
        await page.waitForURL(/\/parent\/papers\/[^/]+/, { timeout: 20000 });

        // 5. 等待 Mock AI 完成后台识别，展示 2 道题目卡片
        const cards = page.getByTestId('parent-paper-question-card');
        await expect(cards).toHaveCount(2, { timeout: 30000 });
        await expect(page.getByText('已知')).toBeVisible();

        // 题框只外扩一次：Mock AI 的第 1 题框是 (0.08, 0.12, 0.84, 0.28)，左右各加 0.012、上下各加 0.01
        const paperId = page.url().match(/\/parent\/papers\/([^/?#]+)/)?.[1];
        expect(paperId).toBeTruthy();
        const paperDetail = (await (await page.request.get(`/api/parent/papers/${paperId}`)).json()) as {
            questions: Array<{ bbox: { pageIndex: number; x: number; y: number; width: number; height: number } | null }>;
        };
        const firstBox = paperDetail.questions[0].bbox;
        expect(firstBox?.pageIndex).toBe(0);
        expect(firstBox?.x).toBeCloseTo(0.068, 4);
        expect(firstBox?.y).toBeCloseTo(0.11, 4);
        expect(firstBox?.width).toBeCloseTo(0.864, 4);
        expect(firstBox?.height).toBeCloseTo(0.3, 4);

        // 6. 将第 2 题（原判定「正确」）改判为「错误」并勾选加入错题本，确认入库计数从 1 变成 2
        const secondCard = cards.nth(1);
        await secondCard.getByRole('button', { name: /^(错误|Wrong)$/ }).click();
        await expect(secondCard.getByRole('button', { name: /^(错误|Wrong)$/ })).toHaveAttribute('aria-pressed', 'true');
        const selectImportCheckbox = secondCard.getByRole('checkbox', { name: /加入错题本|Add to notebook/ });
        await expect(selectImportCheckbox).toBeVisible({ timeout: 5000 });
        const patchSelected = page.waitForResponse(
            (res) => res.url().includes('/api/parent/papers/') && res.request().method() === 'PATCH' && res.ok(),
        );
        await selectImportCheckbox.click();
        await patchSelected;
        await expect(selectImportCheckbox).toBeChecked({ timeout: 5000 });

        const confirmBtn = page.getByRole('button', { name: /确认并入库 2 题|Add 2 items/ });
        await expect(confirmBtn).toBeVisible({ timeout: 10000 });
        await confirmBtn.click();

        // 7. 等待入库成功状态并进入错题本与学习路径校验可见性
        await expect(page.getByText(/已入库 \d+\s*题|Added \d+ items/)).toBeVisible({ timeout: 15000 });

        await page.goto('/notebooks');
        await expect(page.locator('main').getByText('数学').first()).toBeVisible({ timeout: 15000 });
        await page.locator('main').getByText('数学').first().click();
        await expect(page.locator('main').getByText('计算').first()).toBeVisible({ timeout: 15000 });
        await expect(page.locator('main').getByText('已知').first()).toBeVisible({ timeout: 15000 });

        const learnersData = (await (await page.request.get('/api/learners')).json()) as { children: Array<{ id: string }> };
        await page.goto(`/learn?studentKey=${encodeURIComponent(learnersData.children[0].id)}`);
        await expect(page.locator('main').getByText(/一元二次方程|有理数加法/).first()).toBeVisible({ timeout: 15000 });
    } finally {
        if (restoreSettings) await restoreSettings().catch(() => undefined);
        await parentCtx.close();
        await adminCtx.close();
        await mockAi.close();
    }
});
