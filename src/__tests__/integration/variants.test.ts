// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    let sequence = 0;
    return {
        prisma: undefined as PrismaClient | undefined,
        session: { user: { id: 'user-1', email: 'variant-test@example.com', role: 'user' }, expires: '2099-01-01' },
        resetSequence() { sequence = 0; },
        nextQuestion() {
            sequence += 1;
            const coefficient = sequence + 2;
            const constant = sequence;
            const expected = '3';
            const right = coefficient * 3 - constant;
            return {
                questionText: `解方程 ${coefficient}x-${constant}=${right}`,
                answerText: expected,
                analysis: '移项后两边除以系数',
                knowledgePoints: ['方程'],
                computable: { type: 'equation' as const, expression: `${coefficient}*x-${constant}=${right}`, expected },
            };
        },
    };
});

vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/variant/ai-adapter', () => ({
    createVariantAi: () => ({
        plan: async ({ count, slots }: { count?: number; slots?: Array<{ difficulty?: string; knowledgePoint?: string }> }) => {
            const size = slots?.length || count || 1;
            return {
                data: {
                    analysis: '围绕解方程出变式',
                    variants: Array.from({ length: size }, (_, index) => ({
                        vary: '更换系数',
                        skill: '解一元一次方程',
                        knowledgePoints: [slots?.[index]?.knowledgePoint || '方程'],
                        difficulty: slots?.[index]?.difficulty || 'medium',
                    })),
                },
            };
        },
        generate: async () => ({ data: mocks.nextQuestion() }),
        resolve: async () => ({ data: { answer: '3' }, usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 } }),
        checkDifficulty: async ({ target }: { target: string }) => ({ data: { difficulty: target, reason: '一步移项', consistent: true } }),
    }),
    suggestTopic: async () => ({
        data: {
            title: '一元一次方程专项',
            reason: '方程相关错题集中且尚未掌握',
            knowledgePoints: ['方程'],
            outline: ['复习移项', '合并同类项', '列方程解应用题'],
        },
    }),
}));

import { GET as LIST_RUNS, POST as CREATE_RUN } from '@/app/api/variants/runs/route';
import { GET as GET_RUN } from '@/app/api/variants/runs/[id]/route';
import { PATCH as REVIEW_ITEM } from '@/app/api/variants/items/[id]/route';
import { POST as CREATE_EXAM } from '@/app/api/variants/runs/[id]/exam/route';
import { GET as WEAKNESS } from '@/app/api/variants/weakness/route';
import { GET as COMPARE } from '@/app/api/variants/compare/route';
import { POST as GENERATE } from '@/app/api/practice/generate/route';

let database: PrismaClient;
let directory: string;

async function waitForRun(id: string, timeoutMs = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const run = await database.variantRun.findUnique({ where: { id }, include: { items: { orderBy: { index: 'asc' } } } });
        if (run && run.status !== 'running') return run;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error(`run ${id} did not finish`);
}

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'wrong-notebook-variant-test-'));
    const url = `file:${join(directory, 'test.db')}`;
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
    });
    database = new PrismaClient({ datasources: { db: { url } } });
    mocks.prisma = database;
}, 120000);

beforeEach(async () => {
    mocks.resetSequence();
    await database.user.deleteMany();
    await database.user.create({ data: { id: 'user-1', email: mocks.session.user.email, password: 'test-only', variantPipelineEnabled: true } });
    await database.subject.createMany({ data: [
        { id: 'nb-li', name: '李四·数学', stage: 'junior_high', subjectKey: 'math', userId: 'user-1' },
        { id: 'nb-wang', name: '王五·数学', stage: 'junior_high', subjectKey: 'math', userId: 'user-1' },
    ] });
    await database.errorItem.createMany({ data: [
        { id: 'item-eq', shortId: 'Eq0001', userId: 'user-1', subjectId: 'nb-li', questionText: '解方程 2x+1=7', answerText: '3', analysis: '移项', errorType: '计算', knowledgePoints: '["方程"]', originalImageUrl: '' },
        { id: 'item-eq-2', shortId: 'Eq0002', userId: 'user-1', subjectId: 'nb-wang', questionText: '解方程 4x-2=10', answerText: '3', analysis: '移项', errorType: '计算', knowledgePoints: '["方程"]', originalImageUrl: '' },
    ] });
    await database.gradingClass.create({
        data: {
            id: 'class-1', userId: 'user-1', name: '初二1班',
            students: { create: [
                { id: 'stu-li', name: '李四', studentNo: '08', order: 1 },
                { id: 'stu-wang', name: '王五', studentNo: '09', order: 2 },
            ] },
        },
    });
});

afterAll(async () => {
    await database?.$disconnect();
    if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('变式审核与学情接口（真实 SQLite）', () => {
    it('按学生错题本生成弱点画像', async () => {
        const response = await WEAKNESS(new Request('http://localhost/api/variants/weakness?studentId=stu-li'));
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.studentName).toBe('李四');
        expect(data.profile.itemCount).toBe(1);
        expect(data.profile.weaknesses[0].knowledgePoint).toBe('方程');
    });

    it('班级共性薄弱点可用于建议专题', async () => {
        const response = await WEAKNESS(new Request('http://localhost/api/variants/weakness?classId=class-1'));
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.className).toBe('初二1班');
        expect(data.classWeaknesses[0].knowledgePoint).toBe('方程');
        expect(data.topicBrief.knowledgePoints).toContain('方程');
    });

    it('单题流水线进入待审核，批准后写入最近练习，未批准不能组卷', async () => {
        const created = await CREATE_RUN(new Request('http://localhost/api/variants/runs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'practice', errorItemId: 'item-eq', language: 'zh', difficulty: 'medium' }),
        }));
        expect(created.status).toBe(201);
        const payload = await created.json();
        const run = await waitForRun(payload.run.id);
        expect(run.items.length).toBe(1);
        expect(['verified', 'pending_review']).toContain(run.items[0].status);

        const examDenied = await CREATE_EXAM(new Request(`http://localhost/api/variants/runs/${run.id}/exam`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        }), { params: Promise.resolve({ id: run.id }) });
        expect(examDenied.status).toBe(400);

        const reviewed = await REVIEW_ITEM(new Request(`http://localhost/api/variants/items/${run.items[0].id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'approve' }),
        }), { params: Promise.resolve({ id: run.items[0].id }) });
        expect(reviewed.status).toBe(200);
        const item = await database.variantItem.findUniqueOrThrow({ where: { id: run.items[0].id } });
        expect(item.status).toBe('approved');
        const errorItem = await database.errorItem.findUniqueOrThrow({ where: { id: 'item-eq' } });
        expect(errorItem.lastPractice).toContain(item.questionText || '');

        const exam = await CREATE_EXAM(new Request(`http://localhost/api/variants/runs/${run.id}/exam`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: '个性化练习卷' }),
        }), { params: Promise.resolve({ id: run.id }) });
        expect(exam.status).toBe(201);
        const paper = await exam.json();
        expect(paper.questionCount).toBe(1);
        expect(await database.examPaper.count({ where: { id: paper.id, status: 'ready' } })).toBe(1);
    });

    it('个性化练习与专题建议走同一流水线，并出现在对比与 CSV 中', async () => {
        const started = await CREATE_RUN(new Request('http://localhost/api/variants/runs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'topic', studentId: 'stu-li', language: 'zh', count: 3 }),
        }));
        expect(started.status).toBe(202);
        const { runId } = await started.json();
        const run = await waitForRun(runId);
        expect(run.kind).toBe('topic');
        expect(run.items.length).toBeGreaterThanOrEqual(3);
        expect(run.topicSuggestion).toContain('一元一次方程专项');

        const detail = await GET_RUN(new Request(`http://localhost/api/variants/runs/${run.id}`), { params: Promise.resolve({ id: run.id }) });
        expect(detail.status).toBe(200);
        const listed = await LIST_RUNS(new Request('http://localhost/api/variants/runs?kind=topic'));
        expect((await listed.json()).runs.some((item: { id: string }) => item.id === run.id)).toBe(true);

        const compare = await COMPARE(new Request('http://localhost/api/variants/compare'));
        const summary = await compare.json();
        expect(summary.totals.pipeline.count).toBeGreaterThan(0);

        const csv = await COMPARE(new Request('http://localhost/api/variants/compare?format=csv'));
        expect(csv.headers.get('content-type')).toContain('text/csv');
        const text = await csv.text();
        expect(text).toContain(run.id);
        expect(text).toContain('pipeline');
    });

    it('练习生成默认走流水线且不重复扣额度', async () => {
        const response = await GENERATE(new Request('http://localhost/api/practice/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ errorItemId: 'item-eq', language: 'zh', difficulty: 'medium' }),
        }));
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.pipeline).toBe(true);
        const run = await waitForRun(data.run.id);
        expect(run.kind).toBe('practice');
        expect(await database.aiUsage.count({ where: { userId: 'user-1', kind: 'practice' } })).toBe(1);
    });
});
