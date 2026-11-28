import { test, expect, type Page } from '@playwright/test';
import { gotoLoginHydrated } from './helpers';

async function registerUser(
    page: Page,
    user: { email: string; password: string; name: string; personas: string[] },
) {
    const res = await page.request.post('/api/register', {
        data: {
            email: user.email,
            password: user.password,
            name: user.name,
            educationStage: 'junior_high',
            enrollmentYear: 2024,
            personas: user.personas,
        },
    });
    expect(res.ok()).toBeTruthy();
}

async function loginUser(page: Page, email: string, password: string) {
    await gotoLoginHydrated(page);
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 });
}

test('多租户同名孩子与同名班级/学生全链路数据及直连 API 严格隔离（390px 移动视口）', async ({ browser }) => {
    test.setTimeout(90000);
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const userA = {
        email: `tenant-a-${suffix}@example.com`,
        password: 'pass123456',
        name: '租户家长A',
        personas: ['parent', 'teacher', 'self'],
    };
    const userB = {
        email: `tenant-b-${suffix}@example.com`,
        password: 'pass123456',
        name: '租户家长B',
        personas: ['parent', 'teacher', 'self'],
    };

    const ctxA = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
        await registerUser(pageA, userA);
        await loginUser(pageA, userA.email, userA.password);

        // 租户 A 创建同名孩子「小明」、自定义错题本「高阶数学测试」、专属错题以及同名班级「高一(1)班」
        const childARes = await pageA.request.post('/api/learners', { data: { name: '小明' } });
        expect(childARes.ok()).toBeTruthy();
        const childA = (await childARes.json()) as { id: string; name: string };

        const nbARes = await pageA.request.post('/api/notebooks', { data: { name: '高阶数学测试', stage: 'junior_high', subjectKey: 'math' } });
        expect(nbARes.ok()).toBeTruthy();
        const nbA = (await nbARes.json()) as { id: string };

        const questionA = `租户A独占几何题 ${suffix}`;
        const itemARes = await pageA.request.post('/api/error-items', {
            data: {
                subjectId: nbA.id,
                learnerId: childA.id,
                questionText: questionA,
                answerText: '10',
                analysis: '勾股定理推导',
                knowledgePoints: [`专属考点A-${suffix}`],
            },
        });
        expect(itemARes.ok()).toBeTruthy();
        const itemA = (await itemARes.json()) as { id: string };

        const classARes = await pageA.request.post('/api/grading/classes', {
            data: { name: '高一(1)班', roster: '张小明' },
        });
        expect(classARes.ok()).toBeTruthy();
        const classA = (await classARes.json()) as { id: string; students: Array<{ id: string }> };

        await registerUser(pageB, userB);
        await loginUser(pageB, userB.email, userB.password);

        // 租户 B 创建完全同名的孩子「小明」、自定义错题本「高阶数学测试」与班级「高一(1)班」/「张小明」
        const childBRes = await pageB.request.post('/api/learners', { data: { name: '小明' } });
        expect(childBRes.ok()).toBeTruthy();
        const childB = (await childBRes.json()) as { id: string };

        const nbBRes = await pageB.request.post('/api/notebooks', { data: { name: '高阶数学测试', stage: 'junior_high', subjectKey: 'math' } });
        expect(nbBRes.ok()).toBeTruthy();
        const nbB = (await nbBRes.json()) as { id: string };

        const questionB = `租户B独占代数题 ${suffix}`;
        const itemBRes = await pageB.request.post('/api/error-items', {
            data: {
                subjectId: nbB.id,
                learnerId: childB.id,
                questionText: questionB,
                answerText: '42',
                analysis: '一元二次方程配方法',
                knowledgePoints: [`专属考点B-${suffix}`],
            },
        });
        expect(itemBRes.ok()).toBeTruthy();

        const classBRes = await pageB.request.post('/api/grading/classes', {
            data: { name: '高一(1)班', roster: '张小明' },
        });
        expect(classBRes.ok()).toBeTruthy();

        // 页面验证：B 打开自己的错题本只能看到自己的题目，绝不出现 A 的内容，且移动端视口无溢出
        await pageB.goto(`/notebooks/${nbB.id}?learnerId=${encodeURIComponent(childB.id)}`);
        await expect(pageB.getByText(questionB)).toBeVisible({ timeout: 15000 });
        await expect(pageB.getByText(questionA)).toHaveCount(0);
        const overflow = await pageB.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
        expect(overflow).toBeFalsy();

        // 标签统计与学习路径只返回租户 B 的知识点
        const tagsStatsRes = await pageB.request.get(`/api/tags/stats?learnerId=${encodeURIComponent(childB.id)}`);
        expect(tagsStatsRes.ok()).toBeTruthy();
        const tagsStatsText = await tagsStatsRes.text();
        expect(tagsStatsText).toContain(`专属考点B-${suffix}`);
        expect(tagsStatsText).not.toContain(`专属考点A-${suffix}`);

        await pageB.goto(`/learn?studentKey=${encodeURIComponent(childB.id)}`);
        await expect(pageB.locator('body')).not.toContainText(questionA);

        // 跨租户直连隔离：B 访问 A 的错题、孩子、班级、学生档案、学习路径全部拒绝
        const crossItem = await pageB.request.get(`/api/error-items/${itemA.id}`);
        expect([403, 404]).toContain(crossItem.status());

        const crossLearner = await pageB.request.delete(`/api/learners/${childA.id}`);
        expect(crossLearner.status()).toBe(404);

        const crossClass = await pageB.request.delete(`/api/grading/classes/${classA.id}`);
        expect(crossClass.status()).toBe(404);

        const crossStudent = await pageB.request.get(`/api/teacher/students/${classA.students[0].id}`);
        expect(crossStudent.status()).toBe(404);

        const crossPath = await pageB.request.get(`/api/learning-path?studentKey=${encodeURIComponent(childA.id)}`);
        expect(crossPath.status()).toBe(404);
    } finally {
        await ctxA.close();
        await ctxB.close();
    }
});
