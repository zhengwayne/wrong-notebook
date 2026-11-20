import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const tx = {
        gradingResult: { update: vi.fn(), findMany: vi.fn() },
        gradingSubmission: { update: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    return {
        tx,
        user: { findUnique: vi.fn() },
        gradingTask: { findFirst: vi.fn() },
        gradingKeyQuestion: { findFirst: vi.fn() },
        gradingSubmission: { findMany: vi.fn() },
        gradingResult: { findMany: vi.fn() },
        confirmSubmission: vi.fn(),
        transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
        session: { user: { id: 'u-teacher', email: 't@example.com' }, expires: '2099-01-01' },
    };
});

vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: mocks.user,
        gradingTask: mocks.gradingTask,
        gradingKeyQuestion: mocks.gradingKeyQuestion,
        gradingSubmission: mocks.gradingSubmission,
        gradingResult: mocks.gradingResult,
        $transaction: mocks.transaction,
    },
}));
vi.mock('@/lib/grading-service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/grading-service')>()),
    confirmSubmission: mocks.confirmSubmission,
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(() => Promise.resolve(mocks.session)) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

import { POST as CONFIRM_BATCH } from '@/app/api/grading/tasks/[id]/confirm-batch/route';
import { GET as GET_STRIPS, PATCH as PATCH_STRIPS } from '@/app/api/grading/tasks/[id]/questions/[questionId]/strips/route';

describe('Task 2.3: 绿灯一键批量确认与按题号横向切题流 API', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.findUnique.mockResolvedValue({
            id: 'u-teacher',
            email: 't@example.com',
            role: 'user',
            isActive: true,
            authVersion: 0,
            personas: '["teacher"]',
        });
    });

    it('confirm-batch 仅确认属于当前教师任务的绿灯答卷并汇总导入题数', async () => {
        mocks.gradingTask.findFirst.mockResolvedValue({ id: 'task-1' });
        mocks.gradingSubmission.findMany.mockResolvedValue([{ id: 'sub-g1' }, { id: 'sub-g2' }]);
        mocks.confirmSubmission
            .mockResolvedValueOnce({ importedCount: 2 })
            .mockResolvedValueOnce({ importedCount: 0, alreadyConfirmed: true });

        const res = await CONFIRM_BATCH(
            new Request('http://127.0.0.1/api/grading/tasks/task-1/confirm-batch', {
                method: 'POST',
                body: JSON.stringify({}),
                headers: { 'Content-Type': 'application/json' },
            }),
            { params: Promise.resolve({ id: 'task-1' }) },
        );

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ confirmedCount: 1, importedCount: 2, skippedCount: 1 });
        expect(mocks.gradingSubmission.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ taskId: 'task-1', status: 'graded', reviewBucket: 'green' }),
        }));
    });

    it('横向切题流 GET 返回单题全班作答切片，PATCH 改分后同步重算答卷总分与递增乐观锁', async () => {
        mocks.gradingKeyQuestion.findFirst.mockResolvedValue({
            id: 'kq-12',
            order: 11,
            number: '12',
            type: 'subjective',
            maxScore: 10,
            answer: '证全等',
            acceptedAnswers: null,
            questionText: '求证 AB=CD',
            knowledgePoints: '["全等三角形"]',
        });
        mocks.gradingResult.findMany.mockResolvedValueOnce([
            {
                id: 'res-1',
                studentAnswer: '∵ SAS ∴ AB=CD',
                verdict: 'partial',
                score: 7,
                aiScore: 7,
                reason: '缺夹角说明',
                comment: null,
                bbox: JSON.stringify({ pageIndex: 0, x: 0.1, y: 0.4, width: 0.8, height: 0.3 }),
                submission: {
                    id: 'sub-1',
                    status: 'graded',
                    images: JSON.stringify(['data:image/jpeg;base64,P0']),
                    detectedName: '张三',
                    student: { id: 's1', name: '张三', studentNo: '01' },
                },
            },
        ]);

        const getRes = await GET_STRIPS(
            new Request('http://127.0.0.1/api/grading/tasks/task-1/questions/kq-12/strips'),
            { params: Promise.resolve({ id: 'task-1', questionId: 'kq-12' }) },
        );
        expect(getRes.status).toBe(200);
        const payload = await getRes.json();
        expect(payload.strips).toHaveLength(1);
        expect(payload.strips[0]).toMatchObject({ studentName: '张三', score: 7, pageImageUrl: 'data:image/jpeg;base64,P0' });

        mocks.gradingResult.findMany.mockResolvedValueOnce([
            { id: 'res-1', submissionId: 'sub-1', score: 7, verdict: 'partial', source: 'ai' },
        ]);
        mocks.tx.gradingResult.findMany.mockResolvedValueOnce([{ score: 10 }, { score: 4 }]);

        const patchRes = await PATCH_STRIPS(
            new Request('http://127.0.0.1/api/grading/tasks/task-1/questions/kq-12/strips', {
                method: 'PATCH',
                body: JSON.stringify({ updates: [{ resultId: 'res-1', score: 10, comment: '补充口述通过' }] }),
                headers: { 'Content-Type': 'application/json' },
            }),
            { params: Promise.resolve({ id: 'task-1', questionId: 'kq-12' }) },
        );
        expect(patchRes.status).toBe(200);
        expect(mocks.tx.gradingSubmission.updateMany).toHaveBeenCalledWith({
            where: { id: 'sub-1', taskId: 'task-1', status: 'graded' },
            data: { version: { increment: 1 } },
        });
        expect(mocks.tx.gradingSubmission.update).toHaveBeenCalledWith({
            where: { id: 'sub-1' },
            data: { totalScore: 14 },
        });
    });

    it('横向切题流 PATCH 在并发 confirm 抢占失败时跳过修改已确认答卷', async () => {
        mocks.gradingKeyQuestion.findFirst.mockResolvedValue({ id: 'kq-12', maxScore: 10 });
        mocks.gradingResult.findMany.mockResolvedValueOnce([
            { id: 'res-1', submissionId: 'sub-confirmed', score: 7, verdict: 'partial', source: 'ai' },
        ]);
        mocks.tx.gradingSubmission.updateMany.mockResolvedValueOnce({ count: 0 });

        const patchRes = await PATCH_STRIPS(
            new Request('http://127.0.0.1/api/grading/tasks/task-1/questions/kq-12/strips', {
                method: 'PATCH',
                body: JSON.stringify({ updates: [{ resultId: 'res-1', score: 10 }] }),
                headers: { 'Content-Type': 'application/json' },
            }),
            { params: Promise.resolve({ id: 'task-1', questionId: 'kq-12' }) },
        );
        expect(patchRes.status).toBe(200);
        expect(await patchRes.json()).toEqual({ updatedCount: 0 });
        expect(mocks.tx.gradingResult.update).not.toHaveBeenCalled();
    });
});
