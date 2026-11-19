/**
 * 举一反三记录、掌握概率历史与短 ID 定位 API 集成测试
 */
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIsolatedTestDb, type IsolatedTestDb } from '../helpers/two-tenants';

const mocks = vi.hoisted(() => {
    const user = { findUnique: vi.fn() };
    const errorItem = { findUnique: vi.fn() };
    const practiceRecord = { create: vi.fn() };
    return {
        user,
        errorItem,
        practiceRecord,
        mockPrisma: { user, errorItem, practiceRecord },
        activePrisma: undefined as PrismaClient | undefined,
        scheduleMasteryEvaluation: vi.fn(),
        scheduleLearningPathReplan: vi.fn(),
        session: { user: { id: 'user-1', email: 'user@example.com' }, expires: '2099-01-01' },
    };
});

vi.mock('@/lib/prisma', () => ({
    get prisma() {
        return mocks.activePrisma ?? mocks.mockPrisma;
    },
}));
vi.mock('@/lib/ai', () => ({ getAIService: vi.fn() }));
vi.mock('@/lib/mastery', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/mastery')>()),
    scheduleMasteryEvaluation: mocks.scheduleMasteryEvaluation,
}));
vi.mock('@/lib/learning-path/service', () => ({
    scheduleLearningPathReplan: mocks.scheduleLearningPathReplan,
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(() => Promise.resolve(mocks.session)) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

import { DELETE as CLEAR_PRACTICE } from '@/app/api/stats/practice/clear/route';
import { POST as RECORD_POST } from '@/app/api/practice/record/route';
import { GET as HISTORY_GET } from '@/app/api/error-items/[id]/practice-records/route';
import { GET as SHORT_GET } from '@/app/api/error-items/short/[shortId]/route';

const postRecord = (body: object) => RECORD_POST(new Request('http://localhost/api/practice/record', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
}));

describe('POST /api/practice/record（关联原题）', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'user@example.com', role: 'user', isActive: true, authVersion: 0 });
        mocks.practiceRecord.create.mockImplementation(async (args: { data: object }) => ({ id: 'r1', ...args.data }));
    });

    it('保存结果、题目内容并触发掌握概率评估', async () => {
        mocks.errorItem.findUnique.mockResolvedValue({ userId: 'user-1' });

        const response = await postRecord({
            errorItemId: 'item-1',
            result: 'not_attempted',
            difficulty: 'hard',
            questionText: '新题',
            answerText: '答案',
            analysis: '解析',
        });

        expect(response.status).toBe(200);
        expect(mocks.practiceRecord.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: 'user-1',
                errorItemId: 'item-1',
                result: 'not_attempted',
                isCorrect: false,
                source: 'practice',
                questionText: '新题',
            }),
        });
        expect(mocks.scheduleMasteryEvaluation).toHaveBeenCalledWith(['item-1']);
    });

    it('不能为他人的错题写入记录', async () => {
        mocks.errorItem.findUnique.mockResolvedValue({ userId: 'someone-else' });

        const response = await postRecord({ errorItemId: 'item-1', result: 'correct' });

        expect(response.status).toBe(404);
        expect(mocks.practiceRecord.create).not.toHaveBeenCalled();
    });

    it('拒绝非法结果值', async () => {
        const response = await postRecord({ errorItemId: 'item-1', result: 'maybe' });
        expect(response.status).toBe(400);
    });

    it('旧客户端只传 isCorrect 时换算结果', async () => {
        mocks.errorItem.findUnique.mockResolvedValue({ userId: 'user-1' });

        await postRecord({ errorItemId: 'item-1', isCorrect: true, difficulty: 'easy' });

        expect(mocks.practiceRecord.create.mock.calls[0][0].data).toMatchObject({ result: 'correct', isCorrect: true });
    });
});

describe('GET /api/error-items/:id/practice-records', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.findUnique.mockResolvedValue({ id: 'user-1' });
    });

    it('返回掌握概率与记录，并展开试卷来源', async () => {
        mocks.errorItem.findUnique.mockResolvedValue({
            userId: 'user-1',
            masteryLevel: 1,
            masteryProbability: 0.85,
            masteryReason: '连续做对',
            masterySource: 'ai',
            masteryEvaluatedAt: new Date('2026-10-02'),
            practiceRecords: [
                { id: 'r2', result: 'correct', source: 'exam', createdAt: new Date('2026-10-02'), examQuestion: { paperId: 'p1', order: 2, paper: { title: '数学测试', _count: { questions: 1 } } } },
                { id: 'r1', result: 'wrong', source: 'practice', createdAt: new Date('2026-10-01'), examQuestion: null },
            ],
        });

        const response = await HISTORY_GET(new Request('http://localhost'), { params: Promise.resolve({ id: 'item-1' }) });
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.masteryProbability).toBe(0.85);
        expect(data).not.toHaveProperty('userId');
        expect(data.records[0].exam).toEqual({ paperId: 'p1', order: 3, title: '数学测试' });
        expect(data.records[1].exam).toBeNull();
    });

    it('他人的错题返回 403', async () => {
        mocks.errorItem.findUnique.mockResolvedValue({ userId: 'other', practiceRecords: [] });

        const response = await HISTORY_GET(new Request('http://localhost'), { params: Promise.resolve({ id: 'item-1' }) });

        expect(response.status).toBe(403);
    });
});

describe('GET /api/error-items/short/:shortId', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.findUnique.mockResolvedValue({ id: 'user-1' });
    });

    it('按短 ID 定位自己的题目', async () => {
        mocks.errorItem.findUnique.mockResolvedValue({ id: 'item-1', userId: 'user-1', subjectId: 's1', shortId: 'aB3xYz' });

        const response = await SHORT_GET(new Request('http://localhost'), { params: Promise.resolve({ shortId: 'aB3xYz' }) });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: 'item-1', subjectId: 's1', shortId: 'aB3xYz' });
    });

    it('他人的题目与非法格式都返回 404', async () => {
        mocks.errorItem.findUnique.mockResolvedValue({ id: 'item-1', userId: 'other', subjectId: null, shortId: 'aB3xYz' });
        const foreign = await SHORT_GET(new Request('http://localhost'), { params: Promise.resolve({ shortId: 'aB3xYz' }) });
        const invalid = await SHORT_GET(new Request('http://localhost'), { params: Promise.resolve({ shortId: 'O0Il00' }) });

        expect(foreign.status).toBe(404);
        expect(invalid.status).toBe(404);
    });
});

describe('DELETE /api/stats/practice/clear（真实 SQLite 派生状态清理）', () => {
    let testDb: IsolatedTestDb;
    let db: PrismaClient;

    beforeAll(() => {
        testDb = createIsolatedTestDb('practice-clear-test-');
        db = testDb.db;
        mocks.activePrisma = db;
    }, 120000);

    afterAll(async () => {
        mocks.activePrisma = undefined;
        await testDb?.cleanup();
    });

    beforeEach(async () => {
        vi.clearAllMocks();
        await db.practiceRecord.deleteMany();
        await db.itemMemory.deleteMany();
        await db.errorItem.deleteMany();
        await db.subject.deleteMany();
        await db.learner.deleteMany();
        await db.user.deleteMany();

        await db.user.create({
            data: {
                id: 'user-1',
                email: 'user@example.com',
                password: 'hashed-test-password',
                isActive: true,
            },
        });
        await db.learner.createMany({
            data: [
                { id: 'child-1', userId: 'user-1', kind: 'child', name: '大宝' },
                { id: 'child-2', userId: 'user-1', kind: 'child', name: '二宝' },
            ],
        });

        const evaluatedAt = new Date('2026-10-10T00:00:00Z');
        const dueAt = new Date('2026-10-20T00:00:00Z');

        await db.errorItem.createMany({
            data: [
                {
                    id: 'item-self',
                    userId: 'user-1',
                    learnerId: null,
                    questionText: '本人错题',
                    originalImageUrl: '',
                    masteryLevel: 2,
                    masteryProbability: 0.9,
                    masteryReason: '本人已掌握',
                    masterySource: 'ai',
                    masteryEvaluatedAt: evaluatedAt,
                },
                {
                    id: 'item-child-1',
                    userId: 'user-1',
                    learnerId: 'child-1',
                    questionText: '大宝错题',
                    originalImageUrl: '',
                    masteryLevel: 2,
                    masteryProbability: 0.92,
                    masteryReason: '连续答对',
                    masterySource: 'ai',
                    masteryEvaluatedAt: evaluatedAt,
                },
                {
                    id: 'item-child-2',
                    userId: 'user-1',
                    learnerId: 'child-2',
                    questionText: '二宝错题',
                    originalImageUrl: '',
                    masteryLevel: 1,
                    masteryProbability: 0.65,
                    masteryReason: '复练中',
                    masterySource: 'rule',
                    masteryEvaluatedAt: evaluatedAt,
                },
            ],
        });

        await db.practiceRecord.createMany({
            data: [
                { id: 'pr-self', userId: 'user-1', learnerId: null, errorItemId: 'item-self', result: 'correct', isCorrect: true },
                { id: 'pr-child-1', userId: 'user-1', learnerId: 'child-1', errorItemId: 'item-child-1', result: 'correct', isCorrect: true },
                { id: 'pr-child-2', userId: 'user-1', learnerId: 'child-2', errorItemId: 'item-child-2', result: 'wrong', isCorrect: false },
            ],
        });

        await db.itemMemory.createMany({
            data: [
                { id: 'mem-self', userId: 'user-1', learnerId: null, scopeKey: 'self', errorItemId: 'item-self', dueAt, reps: 2, lapses: 0 },
                { id: 'mem-child-1', userId: 'user-1', learnerId: 'child-1', scopeKey: 'child-1', errorItemId: 'item-child-1', dueAt, reps: 3, lapses: 0 },
                { id: 'mem-child-2', userId: 'user-1', learnerId: 'child-2', scopeKey: 'child-2', errorItemId: 'item-child-2', dueAt, reps: 1, lapses: 1 },
            ],
        });
    });

    it('清空指定孩子的练习记录后原子清空其 ItemMemory 并重置 ErrorItem 掌握度，且不影响其他孩子与本人', async () => {
        const response = await CLEAR_PRACTICE(
            new Request('http://localhost/api/stats/practice/clear?learnerId=child-1', { method: 'DELETE' }),
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.count).toBe(1);

        // 目标学习者大宝的练习记录与记忆状态已清空，错题掌握度已重置
        expect(await db.practiceRecord.count({ where: { userId: 'user-1', learnerId: 'child-1' } })).toBe(0);
        expect(await db.itemMemory.count({ where: { userId: 'user-1', scopeKey: 'child-1' } })).toBe(0);
        const resetItem = await db.errorItem.findUniqueOrThrow({ where: { id: 'item-child-1' } });
        expect(resetItem.masteryLevel).toBe(0);
        expect(resetItem.masteryProbability).toBeNull();
        expect(resetItem.masteryReason).toBeNull();
        expect(resetItem.masterySource).toBeNull();
        expect(resetItem.masteryEvaluatedAt).toBeNull();

        // 同账户二宝与本人的练习记录、ItemMemory 和 ErrorItem 掌握度保持不受影响
        expect(await db.practiceRecord.count({ where: { userId: 'user-1', learnerId: 'child-2' } })).toBe(1);
        expect(await db.itemMemory.count({ where: { userId: 'user-1', scopeKey: 'child-2' } })).toBe(1);
        const child2Item = await db.errorItem.findUniqueOrThrow({ where: { id: 'item-child-2' } });
        expect(child2Item.masteryLevel).toBe(1);
        expect(child2Item.masteryProbability).toBe(0.65);
        expect(child2Item.masteryReason).toBe('复练中');
        expect(child2Item.masterySource).toBe('rule');
        expect(child2Item.masteryEvaluatedAt).not.toBeNull();

        expect(await db.practiceRecord.count({ where: { userId: 'user-1', learnerId: null } })).toBe(1);
        expect(await db.itemMemory.count({ where: { userId: 'user-1', scopeKey: 'self' } })).toBe(1);
        const selfItem = await db.errorItem.findUniqueOrThrow({ where: { id: 'item-self' } });
        expect(selfItem.masteryLevel).toBe(2);
        expect(selfItem.masteryProbability).toBe(0.9);

        expect(mocks.scheduleLearningPathReplan).toHaveBeenCalledWith('user-1', 'zh', 'child-1');
    });

    it('清空本人练习记录时仅清理 scopeKey=self 与本人错题掌握度，不影响孩子数据', async () => {
        const response = await CLEAR_PRACTICE(
            new Request('http://localhost/api/stats/practice/clear', { method: 'DELETE' }),
        );
        expect(response.status).toBe(200);
        expect((await response.json()).count).toBe(1);

        expect(await db.practiceRecord.count({ where: { userId: 'user-1', learnerId: null } })).toBe(0);
        expect(await db.itemMemory.count({ where: { userId: 'user-1', scopeKey: 'self' } })).toBe(0);
        const selfItem = await db.errorItem.findUniqueOrThrow({ where: { id: 'item-self' } });
        expect(selfItem.masteryLevel).toBe(0);
        expect(selfItem.masteryProbability).toBeNull();

        expect(await db.itemMemory.count({ where: { userId: 'user-1', scopeKey: 'child-1' } })).toBe(1);
        expect(await db.itemMemory.count({ where: { userId: 'user-1', scopeKey: 'child-2' } })).toBe(1);
        expect((await db.errorItem.findUniqueOrThrow({ where: { id: 'item-child-1' } })).masteryLevel).toBe(2);
        expect(mocks.scheduleLearningPathReplan).toHaveBeenCalledWith('user-1', 'zh', null);
    });
});
