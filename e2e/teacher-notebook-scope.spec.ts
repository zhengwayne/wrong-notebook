import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { gotoLoginHydrated } from './helpers';

test('教师查看全班时，共用错题本的计数、详情和打印正文仅包含该班学生的题目', async ({ page }) => {
    test.setTimeout(90000);
    const email = `teacher-scope-${randomUUID()}@example.test`;
    const password = randomUUID();
    const register = await page.request.post('/api/register', {
        data: { email, password, name: '班级筛选测试教师', educationStage: 'junior_high', enrollmentYear: 2024, personas: ['teacher'] },
    });
    expect(register.ok()).toBe(true);
    await gotoLoginHydrated(page);
    await page.getByLabel(/邮箱|Email/).fill(email);
    await page.getByLabel(/^密码$|^Password$/).fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/teacher*');

    try {
        const firstClass = '七年级一班';
        const secondClass = '七年级二班';
        const roster = await page.request.post('/api/grading/roster/import', {
            data: { rows: [[firstClass, '01', '小云'], [firstClass, '02', '小雨'], [secondClass, '01', '小河']], commit: true },
        });
        expect(roster.ok()).toBe(true);
        const classes = await page.request.get('/api/grading/classes');
        expect(classes.ok()).toBe(true);
        const classList: { name: string; students: { name: string; learnerId: string }[] }[] = await classes.json();
        const learners = new Map(classList.flatMap(cls => cls.students.map(student => [student.name, student.learnerId] as const)));
        const sharedName = '跨班共用练习册';
        const otherName = '二班专用练习册';
        const createNotebook = async (name: string) => {
            const result = await page.request.post('/api/notebooks', { data: { name, stage: 'junior_high', subjectKey: 'biology' } });
            expect(result.status()).toBe(201);
            return (await result.json()).id as string;
        };
        const sharedId = await createNotebook(sharedName);
        const otherId = await createNotebook(otherName);
        const firstQuestion = '叶片上的气孔如何控制水分蒸发？';
        const secondQuestion = '人体骨骼肌收缩时需要什么能量？';
        const otherQuestion = '酵母菌在无氧条件下产生哪些物质？';
        for (const [student, subjectId, questionText] of [
            ['小云', sharedId, firstQuestion], ['小雨', sharedId, secondQuestion],
            ['小河', sharedId, otherQuestion], ['小河', otherId, '哪些动物属于脊椎动物？'],
        ]) {
            const learnerId = learners.get(student);
            expect(learnerId).toBeTruthy();
            const created = await page.request.post('/api/error-items', {
                data: { subjectId, learnerId, questionText, gradeSemester: null },
            });
            expect(created.status()).toBe(201);
        }

        await page.goto('/notebooks');
        const sharedCard = page.getByRole('link').filter({ hasText: sharedName });
        const otherCard = page.getByRole('link').filter({ hasText: otherName });
        await expect(sharedCard.getByText('3', { exact: true })).toBeVisible();
        await expect(otherCard).toBeVisible();
        await page.getByRole('combobox', { name: /班级与学生筛选|Class & Student Filter/ }).selectOption({ label: firstClass });
        await expect(page.getByRole('combobox', { name: /指定学生查看|Filter by Student/ })).toHaveValue('');
        await expect(sharedCard.getByText('2', { exact: true })).toBeVisible();
        await expect(otherCard).toHaveCount(0);

        await sharedCard.click();
        await expect(page.getByText(/共 2 道错题|Total 2 wrong answers/)).toBeVisible();
        for (const question of [firstQuestion, secondQuestion]) {
            await expect(page.getByText(question, { exact: true })).toBeVisible();
        }
        await expect(page.getByText(otherQuestion, { exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: /导出打印|Export for Print/ }).click();
        await expect(page).toHaveURL(/\/print-preview\?/);
        await page.emulateMedia({ media: 'print' });
        const printed = page.getByRole('main');
        for (const question of [firstQuestion, secondQuestion]) {
            await expect(printed.getByText(question, { exact: true })).toBeVisible();
        }
        await expect(printed.getByText(otherQuestion, { exact: true })).toHaveCount(0);
    } finally {
        const deleted = await page.request.delete('/api/user', { data: { password } });
        expect(deleted.ok()).toBe(true);
    }
});
