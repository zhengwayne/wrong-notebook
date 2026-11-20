// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    session: { user: { id: 'teacher-1', email: 'teacher-home@example.com', role: 'user' }, expires: '2099-01-01' },
}));

vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/config', () => ({ getAppTimeZone: () => 'Asia/Taipei' }));
vi.mock('@/lib/learning-path/ai', () => ({
    suggestKnowledgeOrder: async (points: Array<{ knowledgePoint: string }>) => ({
        order: points.map((item) => item.knowledgePoint),
        usedAi: false,
    }),
}));

import { GET as GET_HOME } from '@/app/api/teacher/home/route';
import { GET as GET_STUDENT } from '@/app/api/teacher/students/[studentId]/route';

let directory: string;
let db: PrismaClient;

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'teacher-home-'));
    const url = `file:${join(directory, 'test.db')}`;
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
    });
    db = new PrismaClient({ datasources: { db: { url } } });
    mocks.prisma = db;
}, 120000);

beforeEach(async () => {
    await db.learningPath.deleteMany();
    await db.knowledgeMastery.deleteMany();
    await db.gradingResult.deleteMany();
    await db.gradingSubmission.deleteMany();
    await db.gradingKeyQuestion.deleteMany();
    await db.gradingTask.deleteMany();
    await db.errorItem.deleteMany();
    await db.learner.deleteMany();
    await db.knowledgeTag.deleteMany();
    await db.gradingStudent.deleteMany();
    await db.gradingClass.deleteMany();
    await db.subject.deleteMany();
    await db.user.deleteMany();

    await db.user.create({
        data: {
            id: 'teacher-1',
            email: mocks.session.user.email,
            password: 'test-only',
            personas: '["teacher","self"]',
            activePersona: 'teacher',
            personasConfirmedAt: new Date(),
        },
    });
    await db.subject.createMany({ data: [
        { id: 'nb-self', name: '数学', stage: 'junior_high', subjectKey: 'math', userId: 'teacher-1' },
        { id: 'nb-li', name: '李四·数学', stage: 'junior_high', subjectKey: 'math', userId: 'teacher-1' },
        { id: 'nb-wang', name: '王五·数学', stage: 'junior_high', subjectKey: 'math', userId: 'teacher-1' },
    ] });
    await db.knowledgeTag.createMany({ data: [
        { id: 'tag-eq', name: '方程', subject: 'math', isSystem: true, order: 1 },
        { id: 'tag-arith', name: '整数运算', subject: 'math', isSystem: true, order: 2 },
        { id: 'tag-teacher-only', name: '老师自己的弱点', subject: 'math', isSystem: true, order: 3 },
    ] });
    await db.gradingClass.create({
        data: {
            id: 'class-1',
            userId: 'teacher-1',
            name: '初二1班',
            students: {
                create: [
                    { id: 'stu-li', name: '李四', studentNo: '08', order: 1 },
                    { id: 'stu-wang', name: '王五', studentNo: '09', order: 2 },
                ],
            },
        },
    });
    await db.learner.createMany({ data: [
        { id: 'ln-li', userId: 'teacher-1', kind: 'student', name: '李四', gradingStudentId: 'stu-li' },
        { id: 'ln-wang', userId: 'teacher-1', kind: 'student', name: '王五', gradingStudentId: 'stu-wang' },
    ] });

    await db.errorItem.create({
        data: {
            id: 'item-teacher', shortId: 'Te0001', userId: 'teacher-1', subjectId: 'nb-self',
            questionText: '老师自己的题', originalImageUrl: '', errorType: '概念',
            knowledgePoints: '["老师自己的弱点"]',
            tags: { connect: [{ id: 'tag-teacher-only' }] },
        },
    });
    await db.errorItem.create({
        data: {
            id: 'item-li', shortId: 'Li0001', userId: 'teacher-1', subjectId: 'nb-li', learnerId: 'ln-li',
            questionText: '解方程 2x+1=7', originalImageUrl: '', errorType: '计算',
            knowledgePoints: '["方程"]',
            tags: { connect: [{ id: 'tag-eq' }] },
        },
    });
    await db.errorItem.create({
        data: {
            id: 'item-wang', shortId: 'Wa0001', userId: 'teacher-1', subjectId: 'nb-wang', learnerId: 'ln-wang',
            questionText: '解方程 x-3=1', originalImageUrl: '', errorType: '计算',
            knowledgePoints: '["方程"]',
            tags: { connect: [{ id: 'tag-eq' }] },
        },
    });

    const task = await db.gradingTask.create({
        data: {
            id: 'task-1',
            userId: 'teacher-1',
            classId: 'class-1',
            title: '期中测验',
            subjectName: '数学',
            questions: {
                create: [
                    { id: 'q-eq', order: 1, number: '1', knowledgePoints: '["方程"]', maxScore: 5, answer: '3' },
                    { id: 'q-arith', order: 2, number: '2', knowledgePoints: '["整数运算"]', maxScore: 5, answer: '7' },
                ],
            },
        },
    });
    const subLi = await db.gradingSubmission.create({
        data: { id: 'sub-li', taskId: task.id, studentId: 'stu-li', images: '[]', status: 'confirmed', confirmedAt: new Date() },
    });
    const subWang = await db.gradingSubmission.create({
        data: { id: 'sub-wang', taskId: task.id, studentId: 'stu-wang', images: '[]', status: 'confirmed', confirmedAt: new Date() },
    });
    await db.gradingResult.createMany({ data: [
        { submissionId: subLi.id, keyQuestionId: 'q-eq', verdict: 'wrong', score: 0 },
        { submissionId: subLi.id, keyQuestionId: 'q-arith', verdict: 'correct', score: 5 },
        { submissionId: subWang.id, keyQuestionId: 'q-eq', verdict: 'wrong', score: 0 },
        { submissionId: subWang.id, keyQuestionId: 'q-arith', verdict: 'correct', score: 5 },
    ] });
});

afterAll(async () => {
    await db?.$disconnect();
    if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('老师首页接口', () => {
    it('returns class collection status and class stats that exclude the teacher\'s own items', async () => {
        const response = await GET_HOME(new Request('http://localhost/api/teacher/home?classId=class-1'));
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.classes).toHaveLength(1);
        expect(data.classes[0]).toMatchObject({
            id: 'class-1',
            name: '初二1班',
            studentCount: 2,
            latestTask: { title: '期中测验', submissionCount: 2, confirmedCount: 2, studentCount: 2 },
        });
        expect(data.stats.className).toBe('初二1班');
        const points = data.stats.errorRates.map((item: { knowledgePoint: string }) => item.knowledgePoint);
        expect(points).toContain('方程');
        expect(points).not.toContain('老师自己的弱点');
        const eq = data.stats.errorRates.find((item: { knowledgePoint: string }) => item.knowledgePoint === '方程');
        expect(eq.errorRate).toBe(100);
        expect(eq.studentCount).toBe(2);
        const causes = data.stats.frequentCauses.map((item: { cause: string }) => item.cause);
        expect(causes).toContain('计算');
        expect(causes).not.toContain('概念');
        const weak = data.stats.classWeaknesses.map((item: { knowledgePoint: string }) => item.knowledgePoint);
        expect(weak).toContain('方程');
        expect(weak).not.toContain('老师自己的弱点');
        expect(data.stats.students.map((row: { name: string }) => row.name)).toEqual(['李四', '王五']);
    });

    it('student profile only includes that student\'s mistakes, mastery and today steps', async () => {
        const response = await GET_STUDENT(
            new Request('http://localhost/api/teacher/students/stu-li?language=zh'),
            { params: Promise.resolve({ studentId: 'stu-li' }) },
        );
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.name).toBe('李四');
        expect(data.className).toBe('初二1班');
        const recentIds = data.recentWrong.map((item: { id: string }) => item.id);
        expect(recentIds).toContain('item-li');
        expect(recentIds).not.toContain('item-teacher');
        expect(recentIds).not.toContain('item-wang');
        expect(data.today.length).toBeGreaterThan(0);
        expect(data.mastery.length).toBeGreaterThan(0);
        expect(data.weakPoints.some((item: { knowledgePoint: string }) => item.knowledgePoint === '方程')).toBe(true);
        expect(data.weakPoints.some((item: { knowledgePoint: string }) => item.knowledgePoint === '老师自己的弱点')).toBe(false);
    });
});
