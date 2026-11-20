// @vitest-environment node
/**
 * 家长试卷与教师批改确认入库并发/乐观锁集成测试（真实 SQLite）
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_JPEG_DATA_URL } from "../helpers/sample-images";

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    currentUser: { id: "user-1", role: "user", personas: '["parent","teacher"]' },
    cropDelayHook: null as (() => Promise<void>) | null,
    replan: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ get prisma() { return mocks.prisma; } }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: vi.fn(async () => mocks.currentUser) }));
vi.mock("@/lib/logger", () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock("@/lib/learning-path/service", () => ({ scheduleLearningPathReplan: (...args: unknown[]) => mocks.replan(...args) }));
vi.mock("@/lib/parent-paper-crop", async () => {
    const actual = await vi.importActual<typeof import("@/lib/parent-paper-crop")>("@/lib/parent-paper-crop");
    return {
        ...actual,
        cropDataUrlRegion: async (...args: Parameters<typeof actual.cropDataUrlRegion>) => {
            if (mocks.cropDelayHook) await mocks.cropDelayHook();
            return actual.cropDataUrlRegion(...args);
        },
    };
});

import { POST as CONFIRM_PARENT_PAPER } from "@/app/api/parent/papers/[id]/confirm/route";
import { PATCH as PATCH_PARENT_QUESTION } from "@/app/api/parent/papers/[id]/questions/[questionId]/route";
import { POST as CONFIRM_GRADING_SUBMISSION } from "@/app/api/grading/submissions/[id]/confirm/route";
import { PATCH as PATCH_GRADING_SUBMISSION } from "@/app/api/grading/submissions/[id]/route";
import { PARENT_PAPER_STATUS } from "@/lib/parent-papers";

let directory: string;
let db: PrismaClient;

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "grading-confirm-cas-"));
    const url = `file:${join(directory, "test.db")}?connection_limit=1`;
    execFileSync(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: "pipe",
    });
    db = new PrismaClient({ datasources: { db: { url } } });
    mocks.prisma = db;
}, 120000);

afterAll(async () => {
    await db.$disconnect();
    rmSync(directory, { recursive: true, force: true });
});

beforeEach(async () => {
    mocks.cropDelayHook = null;
    mocks.replan.mockReset();
    mocks.currentUser = { id: "user-1", role: "user", personas: '["parent","teacher"]' };
    await db.sourceImport.deleteMany();
    await db.parentPaperQuestion.deleteMany();
    await db.parentPaperPage.deleteMany();
    await db.parentPaper.deleteMany();
    await db.gradingResult.deleteMany();
    await db.gradingSubmission.deleteMany();
    await db.gradingKeyQuestion.deleteMany();
    await db.gradingTask.deleteMany();
    await db.gradingStudent.deleteMany();
    await db.gradingClass.deleteMany();
    await db.errorItem.deleteMany();
    await db.subject.deleteMany();
    await db.learner.deleteMany();
    await db.user.deleteMany();

    await db.user.create({
        data: {
            id: "user-1",
            email: "cas-owner@example.com",
            password: "hash",
            personas: '["parent","teacher"]',
        },
    });
});

async function seedParentPaperWithWrongQuestions(count = 2) {
    await db.learner.create({
        data: { id: "child-1", userId: "user-1", kind: "child", name: "小星" },
    });
    const paper = await db.parentPaper.create({
        data: {
            id: "paper-1",
            userId: "user-1",
            learnerId: "child-1",
            title: "数学周测",
            status: PARENT_PAPER_STATUS.pendingConfirmation,
            pages: {
                create: [{ position: 0, imageUrl: SAMPLE_JPEG_DATA_URL }],
            },
            questions: {
                create: Array.from({ length: count }, (_, index) => ({
                    position: index,
                    number: String(index + 1),
                    type: "objective",
                    questionText: `第 ${index + 1} 题错题`,
                    studentAnswer: "9",
                    correctAnswer: "10",
                    verdict: "wrong",
                    confidence: 0.9,
                    errorCause: "计算粗心",
                    knowledgePoints: '["整数运算"]',
                    subjectHint: "数学",
                    bbox: JSON.stringify({ pageIndex: 0, x: 0.05, y: 0.05 + index * 0.2, width: 0.8, height: 0.15 }),
                    selected: true,
                })),
            },
        },
        include: { questions: { orderBy: { position: "asc" } } },
    });
    return paper;
}

async function seedGradedSubmissionWithWrongQuestions(count = 2) {
    const cls = await db.gradingClass.create({
        data: { id: "cls-1", userId: "user-1", name: "八年级1班" },
    });
    const student = await db.gradingStudent.create({
        data: { id: "stu-1", classId: cls.id, name: "林一", studentNo: "01" },
    });
    const task = await db.gradingTask.create({
        data: {
            id: "task-1",
            userId: "user-1",
            classId: cls.id,
            title: "期中测验",
            subjectName: "数学",
            questions: {
                create: Array.from({ length: count }, (_, index) => ({
                    id: `kq-${index + 1}`,
                    order: index,
                    number: String(index + 1),
                    type: "objective",
                    maxScore: 5,
                    answer: "42",
                    questionText: `测验第 ${index + 1} 题`,
                    knowledgePoints: '["代数"]',
                })),
            },
        },
    });
    const submission = await db.gradingSubmission.create({
        data: {
            id: "sub-1",
            taskId: task.id,
            studentId: student.id,
            images: JSON.stringify([SAMPLE_JPEG_DATA_URL]),
            status: "graded",
            totalScore: 0,
            results: {
                create: Array.from({ length: count }, (_, index) => ({
                    id: `res-${index + 1}`,
                    keyQuestionId: `kq-${index + 1}`,
                    studentAnswer: "0",
                    verdict: "wrong",
                    score: 0,
                    reason: "思路有误",
                })),
            },
        },
    });
    return submission;
}

describe("家长试卷确认 CAS 与 SourceImport 防重", () => {
    it("10 并发确认只允许 1 次入库并仅生成 1 套 ErrorItem 和 SourceImport", async () => {
        const paper = await seedParentPaperWithWrongQuestions(2);

        const responses = await Promise.all(
            Array.from({ length: 10 }, () =>
                CONFIRM_PARENT_PAPER(
                    new Request(`http://localhost/api/parent/papers/${paper.id}/confirm`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ language: "zh" }),
                    }),
                    { params: Promise.resolve({ id: paper.id }) },
                ),
            ),
        );

        const statuses = responses.map((res) => res.status);
        expect(statuses.filter((status) => status === 200)).toHaveLength(1);
        expect(statuses.filter((status) => status === 409)).toHaveLength(9);

        expect(await db.errorItem.count()).toBe(2);
        expect(await db.sourceImport.count({ where: { sourceKind: "parent_paper", sourceId: paper.id } })).toBe(2);
        const updatedPaper = await db.parentPaper.findUniqueOrThrow({ where: { id: paper.id } });
        expect(updatedPaper.status).toBe(PARENT_PAPER_STATUS.confirmed);
        expect(updatedPaper.version).toBe(1);
    });

    it("裁图等待期间若题目被编辑修改版本，确认提交返回 409 并阻止按旧快照入库", async () => {
        const paper = await seedParentPaperWithWrongQuestions(1);
        const questionId = paper.questions[0].id;

        let enteredCrop!: () => void;
        const waitForCrop = new Promise<void>((resolve) => { enteredCrop = resolve; });
        let releaseCrop!: () => void;
        const holdCrop = new Promise<void>((resolve) => { releaseCrop = resolve; });
        mocks.cropDelayHook = async () => {
            enteredCrop();
            await holdCrop;
        };

        const confirmPromise = CONFIRM_PARENT_PAPER(
            new Request(`http://localhost/api/parent/papers/${paper.id}/confirm`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ expectedVersion: 0 }),
            }),
            { params: Promise.resolve({ id: paper.id }) },
        );

        await waitForCrop;
        const patched = await PATCH_PARENT_QUESTION(
            new Request(`http://localhost/api/parent/papers/${paper.id}/questions/${questionId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ overrideVerdict: "correct" }),
            }),
            { params: Promise.resolve({ id: paper.id, questionId }) },
        );
        expect(patched.status).toBe(200);
        releaseCrop();

        const res = await confirmPromise;
        expect(res.status).toBe(409);
        expect(await db.errorItem.count()).toBe(0);
        expect(await db.sourceImport.count()).toBe(0);
        const latestPaper = await db.parentPaper.findUniqueOrThrow({ where: { id: paper.id } });
        expect(latestPaper.status).toBe(PARENT_PAPER_STATUS.pendingConfirmation);
        expect(latestPaper.version).toBe(1);
    });

    it("传入过期的 expectedVersion 时直接返回 409", async () => {
        const paper = await seedParentPaperWithWrongQuestions(1);
        await PATCH_PARENT_QUESTION(
            new Request(`http://localhost/api/parent/papers/${paper.id}/questions/${paper.questions[0].id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ selected: false }),
            }),
            { params: Promise.resolve({ id: paper.id, questionId: paper.questions[0].id }) },
        );

        const res = await CONFIRM_PARENT_PAPER(
            new Request(`http://localhost/api/parent/papers/${paper.id}/confirm`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ expectedVersion: 0 }),
            }),
            { params: Promise.resolve({ id: paper.id }) },
        );
        expect(res.status).toBe(409);
    });
});

describe("教师批改确认 CAS 与 SourceImport 防重", () => {
    it("10 并发确认只写入 1 套 ErrorItem、精确累计 importedCount 并生成 SourceImport", async () => {
        const submission = await seedGradedSubmissionWithWrongQuestions(2);

        const responses = await Promise.all(
            Array.from({ length: 10 }, () =>
                CONFIRM_GRADING_SUBMISSION(
                    new Request(`http://localhost/api/grading/submissions/${submission.id}/confirm`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({}),
                    }),
                    { params: Promise.resolve({ id: submission.id }) },
                ),
            ),
        );

        for (const res of responses) {
            expect(res.status).toBe(200);
        }
        const payloads = await Promise.all(responses.map((res) => res.json() as Promise<{ importedCount: number }>));
        const totalReported = payloads.reduce((sum, item) => sum + item.importedCount, 0);
        expect(totalReported).toBe(2);
        expect(payloads.filter((item) => item.importedCount === 2)).toHaveLength(1);
        expect(payloads.filter((item) => item.importedCount === 0)).toHaveLength(9);

        expect(await db.errorItem.count()).toBe(2);
        expect(await db.sourceImport.count({ where: { sourceKind: "grading_submission", sourceId: submission.id } })).toBe(2);
        const latest = await db.gradingSubmission.findUniqueOrThrow({ where: { id: submission.id } });
        expect(latest.status).toBe("confirmed");
        expect(latest.importedCount).toBe(2);
        expect(latest.version).toBe(1);
    });

    it("确认前过期的 expectedVersion 返 409；确认后禁止 PATCH 修改返 409", async () => {
        const submission = await seedGradedSubmissionWithWrongQuestions(1);

        const patched = await PATCH_GRADING_SUBMISSION(
            new Request(`http://localhost/api/grading/submissions/${submission.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ results: [{ id: "res-1", verdict: "partial", score: 2 }] }),
            }),
            { params: Promise.resolve({ id: submission.id }) },
        );
        expect(patched.status).toBe(200);

        const staleConfirm = await CONFIRM_GRADING_SUBMISSION(
            new Request(`http://localhost/api/grading/submissions/${submission.id}/confirm`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ expectedVersion: 0 }),
            }),
            { params: Promise.resolve({ id: submission.id }) },
        );
        expect(staleConfirm.status).toBe(409);
        expect(await db.errorItem.count()).toBe(0);

        const okConfirm = await CONFIRM_GRADING_SUBMISSION(
            new Request(`http://localhost/api/grading/submissions/${submission.id}/confirm`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ expectedVersion: 1 }),
            }),
            { params: Promise.resolve({ id: submission.id }) },
        );
        expect(okConfirm.status).toBe(200);

        const patchAfterConfirm = await PATCH_GRADING_SUBMISSION(
            new Request(`http://localhost/api/grading/submissions/${submission.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ studentId: null }),
            }),
            { params: Promise.resolve({ id: submission.id }) },
        );
        expect(patchAfterConfirm.status).toBe(409);
    });
});
