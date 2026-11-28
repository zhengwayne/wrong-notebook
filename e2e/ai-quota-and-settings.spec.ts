import { expect, test, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { ADMIN_PASSWORD, gotoLoginHydrated } from './helpers';
import { configureMockOpenAi, startMockAiServer } from './mock-ai-server';

async function login(page: Page, email: string, password: string) {
    await gotoLoginHydrated(page);
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 });
}

test('AI 次数只在成功时计入；模型列表刷新；设置标题与标签栏固定', async ({ browser }) => {
    test.setTimeout(180000);
    const mockAi = await startMockAiServer();
    const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const adminPage = await adminCtx.newPage();
    const userCtx = await browser.newContext();
    const userPage = await userCtx.newPage();
    let restoreSettings: (() => Promise<void>) | null = null;
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const email = `quota-e2e-${suffix}@example.com`;
    const password = 'quota123456';

    try {
        await login(adminPage, 'admin@localhost', ADMIN_PASSWORD);
        restoreSettings = await configureMockOpenAi(adminPage.request, mockAi.baseUrl);

        const reg = await userPage.request.post('/api/register', {
            data: { email, password, name: '额度测试', educationStage: 'primary', enrollmentYear: 2024, personas: ['self'] },
        });
        expect(reg.ok()).toBeTruthy();
        await login(userPage, email, password);

        const imageBase64 = fs.readFileSync(path.join(__dirname, 'fixtures/math_test.png')).toString('base64');
        const analyze = (requestId: string) => userPage.request.post('/api/analyze', {
            data: { imageBase64, mimeType: 'image/png', language: 'zh' },
            headers: { 'x-request-id': requestId },
        });
        const usedToday = async () => {
            const res = await adminPage.request.get('/api/admin/users');
            expect(res.ok()).toBeTruthy();
            const users = await res.json() as Array<{ email: string; aiUsageToday: number }>;
            return users.find((u) => u.email === email)?.aiUsageToday ?? -1;
        };

        expect(await usedToday()).toBe(0);

        // 成功识别出题目：计 1 次
        const ok1 = await analyze(`e2e-quota-ok-${suffix}`);
        expect(ok1.ok(), await ok1.text()).toBeTruthy();
        expect(await usedToday()).toBe(1);

        // 同一请求 ID 重发：不重复计数
        await analyze(`e2e-quota-ok-${suffix}`);
        expect(await usedToday()).toBe(1);

        // AI 报错：不计
        mockAi.setChatMode('error');
        const failed = await analyze(`e2e-quota-err-${suffix}`);
        expect(failed.ok()).toBeFalsy();
        expect(await usedToday()).toBe(1);

        // 没识别出题目：不计
        mockAi.setChatMode('empty');
        await analyze(`e2e-quota-empty-${suffix}`);
        expect(await usedToday()).toBe(1);

        // 恢复后再成功一次：计 2 次
        mockAi.setChatMode('ok');
        const ok2 = await analyze(`e2e-quota-ok2-${suffix}`);
        expect(ok2.ok()).toBeTruthy();
        expect(await usedToday()).toBe(2);

        // 设置 → AI 提供商 → 刷新模型列表
        mockAi.setModels(['gpt-4o-mini', 'qwen-vl-max', 'deepseek-chat']);
        await adminPage.goto('/');
        await adminPage.getByRole('button', { name: /^(设置|Settings)$/ }).click();
        const dialog = adminPage.getByTestId('settings-dialog');
        await expect(dialog).toBeVisible({ timeout: 8000 });
        await dialog.getByRole('tab', { name: /AI/ }).click();
        const refresh = dialog.getByTestId('model-refresh').first();
        await expect(refresh).toBeVisible({ timeout: 10000 });
        const modelsRes = adminPage.waitForResponse((r) => r.url().endsWith('/api/ai/models'));
        await refresh.click();
        const res = await modelsRes;
        const body = await res.text();
        expect(body).not.toContain('sk-e2e-mock-key');
        expect(res.request().postData() || '').not.toContain('sk-e2e-mock-key');
        expect(mockAi.lastModelsAuth()).toBe('Bearer sk-e2e-mock-key');
        const list = dialog.getByTestId('model-list').first();
        await expect(list.getByRole('option')).toHaveCount(3);
        const input = dialog.getByTestId('model-input').first();
        await input.fill('qwen');
        await expect(list.getByRole('option')).toHaveCount(1);
        await list.getByRole('option', { name: 'qwen-vl-max' }).dispatchEvent('mousedown');
        await expect(input).toHaveValue('qwen-vl-max');
        // 手动输入兜底
        await input.fill('my-custom-model');
        await expect(input).toHaveValue('my-custom-model');

        // 上游失败：错误提示
        mockAi.setModels(null);
        await refresh.click();
        await expect(adminPage.getByText(/获取模型列表失败|Failed to fetch models|mock models failure|500/).first()).toBeVisible({ timeout: 8000 });

        // 标题与标签栏固定，内容区滚动
        for (const name of [/提示词|Prompts/, /AI/, /通用|General/]) {
            await dialog.getByRole('tab', { name }).click();
            await adminPage.waitForTimeout(500);
            const tablist = dialog.getByTestId('settings-header').getByRole('tablist');
            const before = await tablist.boundingBox();
            const scrolled = await dialog.getByTestId('settings-tab-panel').evaluate((el) => {
                el.scrollTop = el.scrollHeight;
                return { top: el.scrollTop, overflow: el.scrollHeight > el.clientHeight };
            });
            await adminPage.waitForTimeout(150);
            const after = await tablist.boundingBox();
            expect(after?.y).toBe(before?.y);
            await expect(dialog.getByRole('heading').first()).toBeInViewport();
            if (scrolled.overflow) expect(scrolled.top).toBeGreaterThan(0);
        }
    } finally {
        if (restoreSettings) await restoreSettings().catch(() => undefined);
        await userCtx.close();
        await adminCtx.close();
        await mockAi.close();
    }
});
