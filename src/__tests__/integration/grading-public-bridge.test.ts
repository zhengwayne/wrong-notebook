// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    scheduleGrading: vi.fn(),
    session: {
        user: { id: 'teacher-1', email: 'teacher@example.com', role: 'user', authVersion: 0 },
        expires: '2099-01-01',
    },
}));

vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/grading-service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/grading-service')>()),
    scheduleGrading: mocks.scheduleGrading,
}));

import { POST as CREATE_SUBMIT_LINK } from '@/app/api/grading/tasks/[id]/submit-link/route';
import { GET as GET_PUBLIC_TASK, POST as SUBMIT_PUBLIC_PAPER } from '@/app/api/public/grading-submit/[token]/route';
import { POST as CREATE_SHARE_LINK } from '@/app/api/grading/submissions/[id]/share/route';
import { GET as GET_PUBLIC_SHARE } from '@/app/api/public/grading-share/[token]/route';
import { POST as IMPORT_SHARED_SUBMISSION } from '@/app/api/parent/import-shared-submission/route';
import { resetPublicTokenRateLimitForTests } from '@/lib/grading-share-tokens';

let database: PrismaClient;
let directory: string;
let validPngDataUrl: string;

beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'wrong-notebook-public-bridge-'));
    const url = `file:${join(directory, 'test.db')}`;
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
    });
    database = new PrismaClient({ datasources: { db: { url } } });
    mocks.prisma = database;

    const pngBuf = await sharp({
        create: { width: 20, height: 20, channels: 3, background: '#ffffff' },
    }).png().toBuffer();
    validPngDataUrl = `data:image/png;base64,${pngBuf.toString('base64')}`;
}, 120000);

beforeEach(async () => {
    resetPublicTokenRateLimitForTests();
    mocks.scheduleGrading.mockClear();
    mocks.session = {
        user: { id: 'teacher-1', email: 'teacher@example.com', role: 'user', authVersion: 0 },
        expires: '2099-01-01',
    };

    await database.sourceImport.deleteMany();
    await database.errorItem.deleteMany();
    await database.subject.deleteMany();
    await database.gradingResult.deleteMany();
    await database.gradingSubmission.deleteMany();
    await database.gradingKeyQuestion.deleteMany();
    await database.gradingTask.deleteMany();
    await database.gradingStudent.deleteMany();
    await database.gradingClass.deleteMany();
    await database.learner.deleteMany();
    await database.user.deleteMany();

    await database.user.create({
        data: { id: 'teacher-1', email: 'teacher@example.com', password: 'pw' },
    });
    await database.user.create({
        data: { id: 'parent-user', email: 'parent@example.com', password: 'pw' },
    });
    await database.learner.create({
        data: { id: 'parent-child-1', userId: 'parent-user', kind: 'child', name: '林小宇' },
    });

    await database.gradingClass.create({
        data: {
            id: 'cls-1',
            userId: 'teacher-1',
            name: '初一(2)班',
            students: {
                create: [
                    { id: 'stu-1', name: '林小宇', studentNo: '202601' },
                    { id: 'stu-2', name: '陈秘密', studentNo: '202602' },
                ],
            },
        },
    });
    await database.gradingTask.create({
        data: {
            id: 'task-1',
            userId: 'teacher-1',
            classId: 'cls-1',
            title: '有理数周测',
            subjectName: '数学',
            questions: {
                create: [
                    {
                        id: 'kq-1',
                        order: 0,
                        number: '1',
                        type: 'objective',
                        maxScore: 5,
                        answer: '-3',
                        questionText: '计算 2 - 5 的值',
                        knowledgePoints: JSON.stringify(['有理数加减']),
                    },
                ],
            },
        },
    });
});

afterAll(async () => {
    await database?.$disconnect();
    if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('扫码交作业短链与家长批改反馈卡免重拍导入闭环', () => {
    it('保护花名册隐私、校验学号姓名与图像魔数，并支持反馈卡一键幂等导入家庭孩子错题本', async () => {
        // 1. 老师生成扫码交卷链接（库内只存 SHA-256 哈希）
        const linkRes = await CREATE_SUBMIT_LINK(
            new Request('http://127.0.0.1/api/grading/tasks/task-1/submit-link', { method: 'POST' }),
            { params: Promise.resolve({ id: 'task-1' }) },
        );
        expect(linkRes.status).toBe(200);
        const { rawToken } = await linkRes.json();
        const dbTask = await database.gradingTask.findUniqueOrThrow({ where: { id: 'task-1' } });
        expect(dbTask.submitTokenHash).toBeTruthy();
        expect(dbTask.submitTokenHash).not.toBe(rawToken);

        // 2. 公开查询任务信息：绝不泄露任何学生姓名或学号
        const pubInfoRes = await GET_PUBLIC_TASK(
            new Request(`http://127.0.0.1/api/public/grading-submit/${rawToken}`),
            { params: Promise.resolve({ token: rawToken }) },
        );
        expect(pubInfoRes.status).toBe(200);
        const pubInfoText = await pubInfoRes.text();
        expect(pubInfoText).toContain('有理数周测');
        expect(pubInfoText).not.toContain('陈秘密');
        expect(pubInfoText).not.toContain('202602');

        // 3. 学号不匹配或缺少学号时拒绝交卷
        const badIdRes = await SUBMIT_PUBLIC_PAPER(
            new Request(`http://127.0.0.1/api/public/grading-submit/${rawToken}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    studentNo: '999999',
                    studentName: '林小宇',
                    images: [validPngDataUrl],
                }),
            }),
            { params: Promise.resolve({ token: rawToken }) },
        );
        expect(badIdRes.status).toBe(400);

        // 4. 伪造非真实图像内容被 sharp 魔数校验拦截
        const badImgRes = await SUBMIT_PUBLIC_PAPER(
            new Request(`http://127.0.0.1/api/public/grading-submit/${rawToken}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    studentNo: '202601',
                    studentName: '林小宇',
                    images: ['data:image/png;base64,bm90LWEtcmVhbC1pbWFnZQ=='],
                }),
            }),
            { params: Promise.resolve({ token: rawToken }) },
        );
        expect(badImgRes.status).toBe(400);

        // 5. 正确学号 + 姓名 + 合法图片成功交卷，重复提交返回 409
        const okSubmitRes = await SUBMIT_PUBLIC_PAPER(
            new Request(`http://127.0.0.1/api/public/grading-submit/${rawToken}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    studentNo: '202601',
                    studentName: '林小宇',
                    images: [validPngDataUrl],
                }),
            }),
            { params: Promise.resolve({ token: rawToken }) },
        );
        expect(okSubmitRes.status).toBe(202);
        const { submissionId } = await okSubmitRes.json();
        expect(mocks.scheduleGrading).toHaveBeenCalledWith([submissionId], 'zh');

        const dupSubmitRes = await SUBMIT_PUBLIC_PAPER(
            new Request(`http://127.0.0.1/api/public/grading-submit/${rawToken}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    studentNo: '202601',
                    studentName: '林小宇',
                    images: [validPngDataUrl],
                }),
            }),
            { params: Promise.resolve({ token: rawToken }) },
        );
        expect(dupSubmitRes.status).toBe(409);

        // 6. 模拟老师批改并留下三维评价与评语，生成家长反馈卡短链
        await database.gradingSubmission.update({
            where: { id: submissionId },
            data: {
                status: 'confirmed',
                totalScore: 0,
                handwritingLevel: 'good',
                neatnessLevel: 'excellent',
                attitudeLevel: 'excellent',
                teacherComment: '卷面非常整洁，注意有理数减法符号！',
                results: {
                    create: [
                        {
                            id: 'res-1',
                            keyQuestionId: 'kq-1',
                            studentAnswer: '3',
                            verdict: 'wrong',
                            score: 0,
                            reason: '正负号颠倒',
                        },
                    ],
                },
            },
        });

        const shareRes = await CREATE_SHARE_LINK(
            new Request(`http://127.0.0.1/api/grading/submissions/${submissionId}/share`, { method: 'POST' }),
            { params: Promise.resolve({ id: submissionId }) },
        );
        expect(shareRes.status).toBe(200);
        const { rawToken: shareToken } = await shareRes.json();

        const getShareRes = await GET_PUBLIC_SHARE(
            new Request(`http://127.0.0.1/api/public/grading-share/${shareToken}`),
            { params: Promise.resolve({ token: shareToken }) },
        );
        expect(getShareRes.status).toBe(200);
        const shareCard = await getShareRes.json();
        expect(shareCard).toMatchObject({
            taskTitle: '有理数周测',
            studentName: '林小宇',
            handwritingLevel: 'good',
            neatnessLevel: 'excellent',
            teacherComment: '卷面非常整洁，注意有理数减法符号！',
        });
        expect(shareCard.wrongQuestions).toHaveLength(1);

        // 7. 切换为家长登录态，一键将反馈卡错题免重拍导入自家孩子错题本（幂等去重）
        mocks.session = {
            user: { id: 'parent-user', email: 'parent@example.com', role: 'user', authVersion: 0 },
            expires: '2099-01-01',
        };
        const importRes1 = await IMPORT_SHARED_SUBMISSION(
            new Request('http://127.0.0.1/api/parent/import-shared-submission', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: shareToken, learnerId: 'parent-child-1' }),
            }),
        );
        expect(importRes1.status).toBe(200);
        expect(await importRes1.json()).toMatchObject({ importedCount: 1, skippedCount: 0 });

        const importRes2 = await IMPORT_SHARED_SUBMISSION(
            new Request('http://127.0.0.1/api/parent/import-shared-submission', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: shareToken, learnerId: 'parent-child-1' }),
            }),
        );
        expect(importRes2.status).toBe(200);
        expect(await importRes2.json()).toMatchObject({ importedCount: 0, skippedCount: 1 });

        const parentErrors = await database.errorItem.findMany({
            where: { userId: 'parent-user', learnerId: 'parent-child-1' },
            include: { tags: true },
        });
        expect(parentErrors).toHaveLength(1);
        expect(parentErrors[0].questionText).toBe('计算 2 - 5 的值');
        expect(parentErrors[0].wrongAnswerText).toBe('3');
    });

    it('随堂速批模式拒绝生成与提交公开短链、未批改答卷拒绝分享，且默认不信任伪造 XFF 绕过限流', async () => {
        await database.gradingTask.create({
            data: {
                id: 'quick-task-1',
                userId: 'teacher-1',
                classId: 'cls-1',
                title: '随堂速批测试',
                subjectName: '数学',
                taskMode: 'quick',
            },
        });
        const quickLinkRes = await CREATE_SUBMIT_LINK(
            new Request('http://127.0.0.1/api/grading/tasks/quick-task-1/submit-link', { method: 'POST' }),
            { params: Promise.resolve({ id: 'quick-task-1' }) },
        );
        expect(quickLinkRes.status).toBe(400);

        const pendingSub = await database.gradingSubmission.create({
            data: {
                id: 'sub-pending',
                taskId: 'task-1',
                studentId: 'stu-2',
                status: 'pending',
                images: JSON.stringify([validPngDataUrl]),
            },
        });
        const pendingShareRes = await CREATE_SHARE_LINK(
            new Request(`http://127.0.0.1/api/grading/submissions/${pendingSub.id}/share`, { method: 'POST' }),
            { params: Promise.resolve({ id: pendingSub.id }) },
        );
        expect(pendingShareRes.status).toBe(400);

        // 生成标准任务链接并连续以不同伪造 XFF 提交，在未设 TRUST_PROXY 时统一归入同 IP 限流桶并在第 11 次触发 429
        const linkRes = await CREATE_SUBMIT_LINK(
            new Request('http://127.0.0.1/api/grading/tasks/task-1/submit-link', { method: 'POST' }),
            { params: Promise.resolve({ id: 'task-1' }) },
        );
        const { rawToken } = await linkRes.json();
        const prevTrust = process.env.TRUST_PROXY;
        delete process.env.TRUST_PROXY;
        try {
            let throttled = 0;
            for (let i = 0; i < 12; i += 1) {
                const res = await SUBMIT_PUBLIC_PAPER(
                    new Request(`http://127.0.0.1/api/public/grading-submit/${rawToken}`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-forwarded-for': `198.51.100.${i + 1}`,
                        },
                        body: JSON.stringify({
                            studentNo: '999999',
                            studentName: '不存在',
                            images: [validPngDataUrl],
                        }),
                    }),
                    { params: Promise.resolve({ token: rawToken }) },
                );
                if (res.status === 429) throttled += 1;
            }
            expect(throttled).toBeGreaterThanOrEqual(2);
        } finally {
            if (prevTrust !== undefined) process.env.TRUST_PROXY = prevTrust;
        }
    });
});
