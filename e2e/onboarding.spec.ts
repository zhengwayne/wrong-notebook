import { test, expect, type Page } from '@playwright/test';
import { gotoLoginHydrated } from './helpers';

async function registerAndLogin(page: Page, personas: string[], landing: RegExp) {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const email = `onboarding-${personas.join('-')}-${suffix}@example.com`;
    const password = 'onboard123456';
    const reg = await page.request.post('/api/register', {
        data: { email, password, name: '引导测试', educationStage: 'junior_high', personas, ...(personas.includes('teacher') && personas.length === 1 ? {} : { enrollmentYear: 2024 }) },
    });
    expect(reg.ok()).toBeTruthy();
    await gotoLoginHydrated(page);
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(landing, { timeout: 15000 });
}

test('注册页：只选老师时不问入学年份，身份说明只出现一次', async ({ page }) => {
    await page.goto('/register');
    await expect(page.locator('input[name="enrollmentYear"]')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('可以同时选择多种身份，之后随时在顶栏切换。')).toHaveCount(0);
    const group = page.getByRole('group', { name: /如何使用学迹|How will you use/ });
    await group.getByRole('checkbox', { name: /自学/ }).click();
    await group.getByRole('checkbox', { name: /老师/ }).click();
    await expect(page.locator('input[name="enrollmentYear"]')).toHaveCount(0);
    await group.getByRole('checkbox', { name: /家长/ }).click();
    await expect(page.locator('input[name="enrollmentYear"]')).toBeVisible();
});

test('老师四步引导：按真实数据打勾、下一步提示、行内提示、收起与从帮助重新打开', async ({ page }) => {
    test.setTimeout(90000);
    await registerAndLogin(page, ['teacher'], /\/teacher/);

    // 首页：引导卡代替空状态，第 1 步高亮
    const card = page.getByTestId('onboarding-card-teacher');
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card).toContainText('四步开始改卷');
    await expect(card).toContainText('0/4');
    await card.getByRole('link', { name: /导入名册/ }).click();
    await page.waitForURL(/\/grading/);

    // 改卷页：步骤条 + 没有班级的提示
    await expect(page.getByTestId('onboarding-strip-teacher')).toBeVisible();
    await expect(page.getByTestId('grading-need-class')).toBeVisible();

    // 第 1 步：导入名册后弹出下一步
    await page.locator('#roster textarea').first().fill('初二(1)班\t01\t张小明\n初二(1)班\t02\t李小红');
    await page.getByRole('button', { name: /^(预览|Preview)$/ }).click();
    await page.getByRole('button', { name: /导入 2 名学生|Import 2/ }).click();
    const next = page.getByTestId('onboarding-next-step');
    await expect(next).toContainText('名册已导入：初二(1)班 · 2 人', { timeout: 15000 });
    await expect(next).toContainText('下一步：新建改卷任务');
    await expect(page.getByTestId('grading-need-class')).toHaveCount(0);

    // 空任务时的第 2 步说明；点下一步提示里的「去新建」展开表单
    await expect(page.getByText('第2步：新建一次改卷')).toBeVisible();
    await next.getByRole('link', { name: /去新建/ }).click();
    await expect(page.locator('#grading-title')).toBeVisible();
    await expect(page.getByTestId('inline-hint-grading-key')).toBeVisible();

    // 第 2 步：建任务，跳到拍照页，看到收卷提示
    await page.locator('#grading-title').fill('第三单元测验');
    await page.locator('form textarea').first().fill('1 A 5\n2 B 5');
    await page.getByRole('button', { name: /创建并继续|Create & Continue/ }).click();
    await page.waitForURL(/\/grading\/[^/?]+\?tab=capture/, { timeout: 15000 });
    await expect(page.getByTestId('onboarding-next-step')).toContainText('任务已创建：第三单元测验', { timeout: 15000 });
    const hint = page.getByTestId('inline-hint-grading-capture');
    await expect(hint).toContainText('收卷：点「拍照」逐份拍');
    await hint.getByRole('button', { name: '知道了' }).click();
    await expect(hint).toHaveCount(0);
    const strip = page.getByTestId('onboarding-strip-teacher');
    await expect(strip.locator('[aria-current="step"]')).toContainText('收卷');

    // 「按题批改」改名生效
    await expect(page.getByText('按题批改')).toBeVisible();

    // 进度接口：两步已完成
    const status = await (await page.request.get('/api/onboarding?persona=teacher')).json();
    expect(status.doneCount).toBe(2);
    expect(status.current).toBe('collect');

    // 收起后首页不再显示，帮助菜单可重新打开
    await page.goto('/teacher');
    await expect(card).toContainText('2/4');
    await card.getByRole('button', { name: '收起' }).click();
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(page.locator('main')).toContainText('初二(1)班', { timeout: 15000 });
    await expect(card).toHaveCount(0);

    await page.getByTestId('help-menu-trigger').click();
    await expect(page.getByRole('menuitem', { name: '名册格式示例' })).toBeVisible();
    await page.getByRole('menuitem', { name: '新手引导' }).click();
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card).toContainText('第3步 · 收卷');

    // 使用说明页
    await page.goto('/help');
    await expect(page.locator('#roster')).toContainText('名册格式示例');
});

test('家长与自学的引导卡', async ({ browser }) => {
    test.setTimeout(60000);
    const parentCtx = await browser.newContext();
    const parentPage = await parentCtx.newPage();
    try {
        await registerAndLogin(parentPage, ['parent'], /\/parent/);
        const card = parentPage.getByTestId('onboarding-card-parent');
        await expect(card).toBeVisible({ timeout: 15000 });
        await expect(card).toContainText('四步用好错题本');
        await expect(card.locator('li[data-step="child"] a')).toHaveAttribute('href', '/parent?manage=1');
    } finally {
        await parentCtx.close();
    }

    const selfCtx = await browser.newContext();
    const selfPage = await selfCtx.newPage();
    try {
        await registerAndLogin(selfPage, ['self'], /\/(\?.*)?$/);
        const card = selfPage.getByTestId('onboarding-card-self');
        await expect(card).toBeVisible({ timeout: 15000 });
        await expect(card).toContainText('三步开始用错题本');
        await expect(card).toContainText('0/3');
        await expect(card.locator('li[data-step="capture"] a')).toHaveAttribute('href', '/#capture');
    } finally {
        await selfCtx.close();
    }
});
