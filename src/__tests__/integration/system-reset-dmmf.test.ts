// @vitest-environment node
/**
 * OPT-21 system-reset DMMF 全模型覆盖护栏测试：
 * - 通过 Prisma.dmmf.datamodel.models 枚举全库全部模型，确保不存在“遗漏清理的业务表”
 * - 同时验证磁盘 TTS 缓存、background-tasks.json 与断线响应缓存一并清理
 */
import fs from 'node:fs';
import path from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIsolatedTestDb, type IsolatedTestDb } from '../helpers/two-tenants';

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    session: null as null | { user: { id: string; email: string; role: string }; expires: string },
}));

vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { POST as SYSTEM_RESET } from '@/app/api/admin/system-reset/route';
import {
    flushBackgroundTasksForTest,
    resetBackgroundTasksForTest,
    startBackgroundTask,
} from '@/lib/background-tasks';
import {
    getStoredResponse,
    REQUEST_ID_HEADER,
    resetRecoverableResponsesForTest,
    withRecoverableResponse,
} from '@/lib/recoverable-response';

let testDb: IsolatedTestDb;
let db: PrismaClient;
let prevConfigDir: string | undefined;

function countModel(client: PrismaClient, modelName: string): Promise<number> {
    const key = modelName[0].toLowerCase() + modelName.slice(1);
    const delegate = (client as unknown as Record<string, { count: () => Promise<number> } | undefined>)[key];
    if (!delegate || typeof delegate.count !== 'function') {
        throw new Error(`未找到模型代理 ${modelName} (${key})`);
    }
    return delegate.count();
}

beforeAll(() => {
    prevConfigDir = process.env.CONFIG_DIR;
    testDb = createIsolatedTestDb('system-reset-dmmf-');
    db = testDb.db;
    mocks.prisma = db;
    process.env.CONFIG_DIR = path.join(testDb.directory, 'config');
}, 120000);

afterAll(async () => {
    resetBackgroundTasksForTest();
    resetRecoverableResponsesForTest();
    if (prevConfigDir === undefined) delete process.env.CONFIG_DIR;
    else process.env.CONFIG_DIR = prevConfigDir;
    await testDb.cleanup();
});

beforeEach(async () => {
    await db.$executeRawUnsafe('PRAGMA foreign_keys = ON;');
});

describe('POST /api/admin/system-reset 全模型与缓存清理 DMMF 护栏', () => {
    it('动态遍历 Prisma DMMF 全部模型：清空所有业务/审计表与磁盘缓存，只保留当前管理员与系统知识点树', async () => {
        const admin = await db.user.create({
            data: { id: 'admin-1', email: 'admin-reset@example.com', password: 'hash', name: '管理员', role: 'admin' },
        });
        const other = await db.user.create({
            data: { id: 'user-other', email: 'other-reset@example.com', password: 'hash', name: '普通用户', role: 'user' },
        });

        await db.knowledgeTag.create({
            data: { id: 'sys-tag', name: '系统知识点', subject: 'math', isSystem: true },
        });
        await db.knowledgeTag.create({
            data: { id: 'custom-tag', name: '自定义标签', subject: 'math', isSystem: false, userId: admin.id },
        });

        const subject = await db.subject.create({
            data: { id: 'sub-admin', name: '数学', stage: 'junior_high', subjectKey: 'math', userId: admin.id },
        });
        const cls = await db.gradingClass.create({
            data: { id: 'cls-1', userId: admin.id, name: '一班' },
        });
        const stu = await db.gradingStudent.create({
            data: { id: 'stu-1', classId: cls.id, name: '张三', studentNo: '01' },
        });
        const learner = await db.learner.create({
            data: { id: 'ln-1', userId: admin.id, kind: 'child', name: '小明' },
        });
        await db.learnerBackfillAudit.create({
            data: { id: 'audit-1', batchId: 'b1', userId: admin.id, entityType: 'learner', entityId: learner.id, action: 'create' },
        });

        const prov = await db.aiProvenance.create({
            data: { id: 'prov-1', task: 'analyze', provider: 'gemini', model: 'gemini-2.5-flash', promptVersion: 'p1', parserVersion: 'v1' },
        });
        const errItem = await db.errorItem.create({
            data: {
                id: 'ei-admin',
                shortId: 'Rst001',
                userId: admin.id,
                subjectId: subject.id,
                learnerId: learner.id,
                provenanceId: prov.id,
                originalImageUrl: 'data:image/png;base64,AA==',
                questionText: '管理员自己的错题也应清空',
            },
        });
        await db.reviewSchedule.create({
            data: { id: 'rs-1', errorItemId: errItem.id, scheduledFor: new Date() },
        });
        const exam = await db.examPaper.create({
            data: { id: 'ep-1', userId: admin.id, title: '试卷', scope: 'all', difficulty: 'medium', requestedCount: 1, subjectIds: '["sub-admin"]' },
        });
        const examQ = await db.examQuestion.create({
            data: { id: 'eq-1', paperId: exam.id, order: 0, errorItemId: errItem.id, sourceShortId: 'Rst001' },
        });
        const pr = await db.practiceRecord.create({
            data: { id: 'pr-1', userId: other.id, errorItemId: errItem.id, examQuestionId: examQ.id, learnerId: learner.id, result: 'wrong' },
        });
        await db.aiUsage.create({
            data: { id: 'usage-1', userId: admin.id, kind: 'analyze' },
        });

        const task = await db.gradingTask.create({
            data: { id: 'gt-1', userId: admin.id, classId: cls.id, title: '改卷' },
        });
        const kq = await db.gradingKeyQuestion.create({
            data: { id: 'kq-1', taskId: task.id, order: 0, number: '1' },
        });
        const sub = await db.gradingSubmission.create({
            data: { id: 'gs-1', taskId: task.id, studentId: stu.id, images: '[]' },
        });
        await db.gradingResult.create({
            data: { id: 'gr-1', submissionId: sub.id, keyQuestionId: kq.id, verdict: 'wrong', provenanceId: prov.id },
        });

        const run = await db.variantRun.create({
            data: { id: 'vr-1', userId: admin.id, kind: 'practice', mode: 'pipeline', errorItemId: errItem.id, classId: cls.id, studentId: stu.id, examPaperId: exam.id },
        });
        const vItem = await db.variantItem.create({
            data: { id: 'vi-1', runId: run.id, index: 0, practiceRecordId: pr.id, examQuestionId: examQ.id, provenanceId: prov.id },
        });
        await db.variantStageLog.create({
            data: { id: 'vs-1', runId: run.id, itemId: vItem.id, stage: 'generate', status: 'ok' },
        });

        const pp = await db.parentPaper.create({
            data: { id: 'pp-1', userId: admin.id, learnerId: learner.id, title: '家长试卷' },
        });
        await db.parentPaperPage.create({
            data: { id: 'ppp-1', paperId: pp.id, position: 0, imageUrl: 'data:image/png;base64,AA==' },
        });
        await db.parentPaperQuestion.create({
            data: { id: 'ppq-1', paperId: pp.id, position: 0, number: '1', verdict: 'wrong', provenanceId: prov.id },
        });
        await db.sourceImport.create({
            data: { id: 'si-1', userId: admin.id, sourceKind: 'parent_paper', sourceId: pp.id, sourceQuestionId: 'ppq-1', errorItemId: errItem.id },
        });

        await db.knowledgeMastery.create({
            data: { id: 'km-1', userId: admin.id, studentKey: learner.id, knowledgePoint: '方程' },
        });
        await db.itemMemory.create({
            data: { id: 'im-1', userId: admin.id, learnerId: learner.id, scopeKey: learner.id, errorItemId: errItem.id, dueAt: new Date() },
        });
        const lp = await db.learningPath.create({
            data: { id: 'lp-1', userId: admin.id, studentKey: learner.id, studentName: '小明', evidenceHash: 'h1' },
        });
        await db.learningPathStep.create({
            data: { id: 'lps-1', pathId: lp.id, position: 0, type: 'review_explanation', title: '步骤1', reason: '错题', knowledgePoints: '["方程"]' },
        });

        // 准备磁盘 TTS 缓存、background-tasks.json 与 recoverable-response 内存缓存
        const configDir = process.env.CONFIG_DIR!;
        const ttsDir = path.join(configDir, 'tts-cache');
        fs.mkdirSync(ttsDir, { recursive: true });
        fs.writeFileSync(path.join(ttsDir, 'dummy.mp3'), 'mp3');
        fs.writeFileSync(path.join(ttsDir, 'dummy.json'), '{}');

        const bgFile = path.join(configDir, 'background-tasks.json');
        resetBackgroundTasksForTest({ file: bgFile });
        startBackgroundTask({ userId: admin.id, kind: 'analyze', subject: '待清理任务' });
        flushBackgroundTasksForTest();
        expect(fs.existsSync(bgFile)).toBe(true);

        const reqId = '0123456789abcdef0123456789abcdef';
        const wrapped = withRecoverableResponse(async () => new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        await wrapped(new Request('http://localhost/test', { headers: { [REQUEST_ID_HEADER]: reqId } }));
        expect(getStoredResponse(reqId)).not.toBeNull();

        // 重置前：DMMF 枚举的每个模型均至少有 1 条记录，防止测试漏覆盖新表
        for (const model of Prisma.dmmf.datamodel.models) {
            expect(await countModel(db, model.name), `重置前模型 ${model.name} 应已准备好测试记录`).toBeGreaterThanOrEqual(1);
        }

        // 执行系统重置
        mocks.session = { user: { id: admin.id, email: admin.email, role: 'admin' }, expires: '2099-01-01' };
        const res = await SYSTEM_RESET();
        expect(res.status).toBe(200);

        // 重置后：按 DMMF 验证全表状态
        for (const model of Prisma.dmmf.datamodel.models) {
            const remaining = await countModel(db, model.name);
            if (model.name === 'User') {
                expect(remaining).toBe(1);
            } else if (model.name === 'KnowledgeTag') {
                expect(remaining).toBe(1);
                expect(await db.knowledgeTag.count({ where: { isSystem: false } })).toBe(0);
                expect(await db.knowledgeTag.count({ where: { isSystem: true } })).toBe(1);
            } else {
                expect(remaining, `重置后模型 ${model.name} 必须已清空`).toBe(0);
            }
        }

        const preservedUser = await db.user.findUnique({ where: { id: admin.id } });
        expect(preservedUser?.email).toBe(admin.email);
        expect(fs.existsSync(ttsDir)).toBe(false);
        expect(fs.existsSync(bgFile)).toBe(false);
        expect(getStoredResponse(reqId)).toBeNull();
    });
});
