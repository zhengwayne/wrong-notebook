// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_JPEG_DATA_URL, SAMPLE_PNG_BASE64, SAMPLE_PNG_DATA_URL } from '../helpers/sample-images';

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    session: { user: { id: 'user-1', email: 'prov-test@example.com', role: 'user' }, expires: '2099-01-01' },
    analyzeImage: vi.fn(),
    readExamPaper: vi.fn(),
    completeJson: vi.fn(),
    generateSimilarQuestion: vi.fn(),
    replan: vi.fn(),
    appConfig: {
        aiProvider: 'gemini',
        gemini: { apiKey: 'test', model: 'gemini-2.5-flash' },
    },
}));

vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/current-user', () => ({
    getCurrentUser: async () => mocks.prisma!.user.findUnique({ where: { email: mocks.session.user.email } }),
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/config', () => ({
    getAppConfig: () => mocks.appConfig,
    getAppTimeZone: () => 'Asia/Shanghai',
}));
vi.mock('@/lib/ai-quota', () => ({ consumeAiQuota: vi.fn(async () => null) }));
vi.mock('@/lib/learning-path/service', () => ({ scheduleLearningPathReplan: (...args: unknown[]) => mocks.replan(...args) }));
vi.mock('@/lib/mastery', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/mastery')>()),
    scheduleMasteryEvaluation: vi.fn(),
}));
vi.mock('@/lib/ai', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/ai')>()),
    getAIService: () => ({
        analyzeImage: mocks.analyzeImage,
        readExamPaper: mocks.readExamPaper,
        completeJson: mocks.completeJson,
        generateSimilarQuestion: mocks.generateSimilarQuestion,
    }),
}));

import { POST as ANALYZE_POST } from '@/app/api/analyze/route';
import { POST as ERROR_ITEM_POST } from '@/app/api/error-items/route';
import { POST as PARENT_PAPER_POST } from '@/app/api/parent/papers/route';
import { confirmParentPaper, startParentPaperRecognition, waitForParentPaperRecognition } from '@/lib/parent-paper-recognize';
import { confirmSubmission, gradeSubmission } from '@/lib/grading-service';
import { getPromptVersion, recordAiProvenance } from '@/lib/ai/provenance';
import { startLegacyRun } from '@/lib/variant/service';

let dir: string;
let db: PrismaClient;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-provenance-test-'));
    const url = `file:${join(dir, 'test.db')}`;
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
    });
    db = new PrismaClient({ datasources: { db: { url } } });
    mocks.prisma = db;
}, 120000);

afterAll(async () => {
    await db?.$disconnect();
    if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
    vi.clearAllMocks();
    await db.variantStageLog.deleteMany();
    await db.variantItem.deleteMany();
    await db.variantRun.deleteMany();
    await db.gradingResult.deleteMany();
    await db.gradingKeyQuestion.deleteMany();
    await db.gradingSubmission.deleteMany();
    await db.gradingTask.deleteMany();
    await db.gradingStudent.deleteMany();
    await db.gradingClass.deleteMany();
    await db.parentPaperQuestion.deleteMany();
    await db.parentPaperPage.deleteMany();
    await db.parentPaper.deleteMany();
    await db.practiceRecord.deleteMany();
    await db.errorItem.deleteMany();
    await db.knowledgeTag.deleteMany();
    await db.subject.deleteMany();
    await db.learner.deleteMany();
    await db.aiProvenance.deleteMany();
    await db.user.deleteMany();

    await db.user.create({
        data: {
            id: 'user-1',
            email: mocks.session.user.email,
            password: 'test-only',
            personas: '["student","parent","teacher"]',
            activePersona: 'parent',
            personasConfirmedAt: new Date(),
        },
    });
    await db.learner.create({ data: { id: 'child-1', userId: 'user-1', kind: 'child', name: '小明', order: 0 } });
    await db.subject.create({ data: { id: 'nb-math', userId: 'user-1', name: '数学', stage: 'junior_high', subjectKey: 'math' } });
});

describe('AI 产出溯源记录与复用（OPT-19）', () => {
    it('同一 task × provider × model × promptVersion × parserVersion 组合复用同一条 AiProvenance 行', async () => {
        const v1 = getPromptVersion('analyze');
        expect(v1).toMatch(/^[0-9a-f]{12}$/);

        const id1 = await recordAiProvenance(db, { task: 'analyze', role: 'vision' });
        const id2 = await recordAiProvenance(db, { task: 'analyze', role: 'vision' });
        const id3 = await recordAiProvenance(db, { task: 'analyze', role: 'vision', modelOverride: 'gemini-2.5-pro' });

        expect(id1).toBeTruthy();
        expect(id2).toBe(id1);
        expect(id3).not.toBe(id1);
        expect(await db.aiProvenance.count()).toBe(2);
    });

    it('错题识别 -> 入库传递并记录 ErrorItem.provenanceId', async () => {
        mocks.analyzeImage.mockResolvedValue({
            questionText: '解方程 $2x=8$',
            answerText: '4',
            analysis: '两边同除以 2',
            wrongAnswerText: '',
            mistakeAnalysis: '',
            mistakeStatus: 'unknown',
            subject: '数学',
            knowledgePoints: [],
            requiresImage: false,
            gradeSemester: '七年级上',
            difficultyStars: 2,
            hasFigure: false,
            figureSvg: null,
        });

        const analyzeRes = await ANALYZE_POST(new Request('http://localhost/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageBase64: SAMPLE_PNG_BASE64, language: 'zh', subjectId: 'nb-math' }),
        }));
        expect(analyzeRes.status).toBe(200);
        const analyzeBody = await analyzeRes.json() as { provenanceId?: string };
        expect(analyzeBody.provenanceId).toBeTruthy();

        const createRes = await ERROR_ITEM_POST(new Request('http://localhost/api/error-items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                questionText: '解方程 $2x=8$',
                answerText: '4',
                analysis: '两边同除以 2',
                originalImageUrl: SAMPLE_PNG_DATA_URL,
                subjectId: 'nb-math',
                provenanceId: analyzeBody.provenanceId,
            }),
        }));
        expect(createRes.status).toBe(201);
        const item = await db.errorItem.findFirstOrThrow({ where: { userId: 'user-1' } });
        expect(item.provenanceId).toBe(analyzeBody.provenanceId);
    });

    it('家长试卷题、教师批改结果及变式生成均记录 provenanceId 并继承至入库错题', async () => {
        // 1. 家长试卷识别 -> 确认入库
        const paperRes = await PARENT_PAPER_POST(new Request('http://localhost/api/parent/papers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ learnerId: 'child-1', title: '数学周测', pages: [{ imageUrl: SAMPLE_JPEG_DATA_URL }] }),
        }));
        const paper = await paperRes.json() as { id: string };
        mocks.readExamPaper.mockResolvedValueOnce({
            studentName: null,
            className: null,
            studentNo: null,
            questions: [],
            reviewQuestions: [{
                number: '1', type: 'objective', questionText: '1+2=?', studentAnswer: '4', correctAnswer: '3',
                verdict: 'wrong', confidence: 0.9, errorCause: '计算失误', knowledgePoints: [], subjectHint: '数学',
                bbox: null,
            }],
        });
        await startParentPaperRecognition(db, 'user-1', paper.id, { language: 'zh' });
        await waitForParentPaperRecognition(paper.id);
        const ppq = await db.parentPaperQuestion.findFirstOrThrow({ where: { paperId: paper.id } });
        expect(ppq.provenanceId).toBeTruthy();

        await confirmParentPaper(db, 'user-1', paper.id, { language: 'zh' });
        const parentImported = await db.errorItem.findUniqueOrThrow({ where: { id: (await db.parentPaperQuestion.findUniqueOrThrow({ where: { id: ppq.id } })).importedErrorItemId! } });
        expect(parentImported.provenanceId).toBe(ppq.provenanceId);

        // 2. 教师拍照判分 -> 确认入库
        const cls = await db.gradingClass.create({ data: { userId: 'user-1', name: '七年级1班' } });
        const student = await db.gradingStudent.create({ data: { classId: cls.id, name: '同学甲', order: 0 } });
        const gTask = await db.gradingTask.create({
            data: {
                userId: 'user-1',
                classId: cls.id,
                title: '课堂小测',
                subjectName: '数学',
                questions: { create: { order: 0, number: '1', type: 'objective', maxScore: 5, answer: '7', questionText: '3+4=?' } },
            },
        });
        const submission = await db.gradingSubmission.create({
            data: { taskId: gTask.id, studentId: student.id, images: JSON.stringify([SAMPLE_JPEG_DATA_URL]) },
        });
        mocks.readExamPaper.mockResolvedValueOnce({
            studentName: '同学甲',
            className: '七年级1班',
            studentNo: null,
            questions: [{ number: '1', type: 'objective', answer: '8' }],
        });
        await gradeSubmission(submission.id, 'zh');
        const gResult = await db.gradingResult.findFirstOrThrow({ where: { submissionId: submission.id } });
        expect(gResult.provenanceId).toBeTruthy();

        await confirmSubmission(submission.id, 'user-1');
        const updatedResult = await db.gradingResult.findUniqueOrThrow({ where: { id: gResult.id } });
        const teacherImported = await db.errorItem.findUniqueOrThrow({ where: { id: updatedResult.errorItemId! } });
        expect(teacherImported.provenanceId).toBe(gResult.provenanceId);

        // 3. 变式题生成记录 provenanceId
        mocks.generateSimilarQuestion.mockResolvedValueOnce({
            questionText: '解方程 $3x=12$',
            answerText: '4',
            analysis: 'x=4',
            knowledgePoints: ['方程'],
            figureSvg: null,
        });
        const runRes = await startLegacyRun({
            user: { id: 'user-1', role: 'user' },
            errorItemId: parentImported.id,
            question: '1+2=?',
            knowledgePoints: ['加法'],
            language: 'zh',
            difficulty: 'medium',
        });
        const vItem = await db.variantItem.findFirstOrThrow({ where: { runId: runRes.runId } });
        expect(vItem.provenanceId).toBeTruthy();
    });
});
