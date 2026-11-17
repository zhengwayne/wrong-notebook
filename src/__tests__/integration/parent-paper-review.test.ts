// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_JPEG_DATA_URL } from "../helpers/sample-images";

const IMAGE = SAMPLE_JPEG_DATA_URL;

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    session: { user: { id: "parent-1", email: "parent-review@example.com", role: "user" }, expires: "2099-01-01" },
    readExamPaper: vi.fn(),
    completeJson: vi.fn(),
    replan: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ get prisma() { return mocks.prisma; } }));
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/logger", () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock("@/lib/current-user", () => ({
    getCurrentUser: async () => mocks.prisma!.user.findUnique({ where: { email: mocks.session.user.email } }),
}));
vi.mock("@/lib/ai", () => ({ getAIService: () => ({ readExamPaper: mocks.readExamPaper, completeJson: mocks.completeJson }) }));
vi.mock("@/lib/learning-path/service", () => ({ scheduleLearningPathReplan: (...args: unknown[]) => mocks.replan(...args) }));

import { GET, POST } from "@/app/api/parent/papers/route";
import { GET as GET_PAPER } from "@/app/api/parent/papers/[id]/route";
import { POST as RECOGNIZE } from "@/app/api/parent/papers/[id]/recognize/route";
import { POST as CONFIRM } from "@/app/api/parent/papers/[id]/confirm/route";
import { PATCH as PATCH_QUESTION } from "@/app/api/parent/papers/[id]/questions/[questionId]/route";
import { failStaleRecognizingPapers, waitForParentPaperRecognition } from "@/lib/parent-paper-recognize";
import { PARENT_PAPER_STATUS } from "@/lib/parent-papers";

let directory: string;
let db: PrismaClient;

async function createPaper(body: Record<string, unknown> = {}) {
    const created = await POST(new Request("http://localhost/api/parent/papers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            learnerId: "child-a",
            title: "数学练习卷",
            pages: [{ imageUrl: IMAGE }],
            ...body,
        }),
    }));
    expect(created.status).toBe(201);
    return created.json();
}

async function recognize(paperId: string, body: Record<string, unknown> = {}) {
    const response = await RECOGNIZE(new Request(`http://localhost/api/parent/papers/${paperId}/recognize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: paperId }) });
    await waitForParentPaperRecognition(paperId);
    return response;
}

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "parent-paper-review-"));
    const url = `file:${join(directory, "test.db")}`;
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
    mocks.readExamPaper.mockReset();
    mocks.completeJson.mockReset();
    mocks.completeJson.mockResolvedValue({ data: null, text: "" });
    mocks.replan.mockReset();
    await db.sourceImport.deleteMany();
    await db.parentPaperQuestion.deleteMany();
    await db.parentPaperPage.deleteMany();
    await db.parentPaper.deleteMany();
    await db.errorItem.deleteMany();
    await db.knowledgeTag.deleteMany();
    await db.subject.deleteMany();
    await db.learner.deleteMany();
    await db.user.deleteMany();
    await db.user.create({
        data: {
            id: "parent-1",
            email: mocks.session.user.email,
            password: "test-only",
            personas: "[\"parent\"]",
            activePersona: "parent",
            personasConfirmedAt: new Date(),
        },
    });
    await db.learner.create({ data: { id: "child-a", userId: "parent-1", kind: "child", name: "小明", order: 0 } });
});

describe("parent paper recognition and confirm", () => {
    it("stores validated bboxes, drops malformed ones, and does not invent a score without an answer key", async () => {
        mocks.readExamPaper.mockResolvedValue({
            studentName: null, className: null, studentNo: null, questions: [],
            reviewQuestions: [
                {
                    number: "1", type: "objective", questionText: "1+1", studentAnswer: "3", correctAnswer: "2",
                    verdict: "wrong", confidence: 0.91, errorCause: "算错", knowledgePoints: ["加法"], subjectHint: "数学",
                    bbox: { pageIndex: 0, x: 0.1, y: 0.1, width: 0.8, height: 0.2 },
                },
                {
                    number: "2", type: "objective", questionText: "2+2", studentAnswer: "4", correctAnswer: "4",
                    verdict: "correct", confidence: 0.5, errorCause: null, knowledgePoints: [], subjectHint: "数学",
                    bbox: { pageIndex: 0, x: 12, y: 40, width: 300, height: 80 },
                },
            ],
        });
        const paper = await createPaper();
        const started = await recognize(paper.id);
        expect(started.status).toBe(202);

        const detail = await (await GET_PAPER(new Request(`http://localhost/api/parent/papers/${paper.id}`), { params: Promise.resolve({ id: paper.id }) })).json();
        expect(detail.status).toBe(PARENT_PAPER_STATUS.pendingConfirmation);
        expect(detail.hasAnswerKey).toBe(false);
        expect(detail.correctCount).toBeNull();
        expect(detail.questions[0].bbox).toMatchObject({ pageIndex: 0 });
        expect(detail.questions[0].bbox.x).toBeLessThanOrEqual(0.1);
        expect(detail.questions[0].bbox.x + detail.questions[0].bbox.width).toBeGreaterThanOrEqual(0.9);
        expect(detail.questions[1].bbox).toBeNull();
        expect(detail.questions[0].selected).toBe(true);
        expect(detail.questions[1].selected).toBe(false);
        expect(await db.errorItem.count()).toBe(0);
        expect(mocks.replan).not.toHaveBeenCalled();
    });

    it("accepts an empty question list from the model", async () => {
        mocks.readExamPaper.mockResolvedValue({
            studentName: null, className: null, studentNo: null, questions: [], reviewQuestions: [],
        });
        const paper = await createPaper();
        await recognize(paper.id);
        const detail = await (await GET_PAPER(new Request(`http://localhost/api/parent/papers/${paper.id}`), { params: Promise.resolve({ id: paper.id }) })).json();
        expect(detail.status).toBe(PARENT_PAPER_STATUS.pendingConfirmation);
        expect(detail.questions).toEqual([]);
    });

    it("compares objective questions with an optional answer key", async () => {
        mocks.readExamPaper.mockImplementation(async (input: { mode: string }) => {
            if (input.mode === "answer_key") {
                return {
                    studentName: null, className: null, studentNo: null,
                    questions: [{ number: "1", type: "objective", maxScore: 1, answer: "C", questionText: "选择题", knowledgePoints: ["选择"] }],
                    reviewQuestions: [],
                };
            }
            return {
                studentName: null, className: null, studentNo: null, questions: [],
                reviewQuestions: [{
                    number: "1", type: "objective", questionText: "选择题", studentAnswer: "A", correctAnswer: "B",
                    verdict: "wrong", confidence: 0.4, errorCause: "选项错了", knowledgePoints: [], subjectHint: "数学",
                    bbox: null,
                }],
            };
        });
        const paper = await createPaper({ answerKeyImages: [IMAGE] });
        await recognize(paper.id);
        const detail = await (await GET_PAPER(new Request(`http://localhost/api/parent/papers/${paper.id}`), { params: Promise.resolve({ id: paper.id }) })).json();
        expect(detail.hasAnswerKey).toBe(true);
        expect(detail.correctCount).toBe(0);
        expect(detail.questions[0]).toMatchObject({ verdict: "wrong", correctAnswer: "C", confidence: 0.9 });
        expect(mocks.readExamPaper).toHaveBeenCalledTimes(2);
        expect(mocks.readExamPaper.mock.calls[0][0].mode).toBe("answer_key");
        expect(mocks.readExamPaper.mock.calls[1][0].mode).toBe("parent_review");
    });

    it("lets the parent override a verdict and imports only selected wrong items with learnerId", async () => {
        mocks.readExamPaper.mockResolvedValue({
            studentName: null, className: null, studentNo: null, questions: [],
            reviewQuestions: [
                {
                    number: "1", type: "objective", questionText: "错题", studentAnswer: "3", correctAnswer: "2",
                    verdict: "wrong", confidence: 0.95, errorCause: "算错", knowledgePoints: ["加法"], subjectHint: "数学",
                    bbox: { pageIndex: 0, x: 0.1, y: 0.1, width: 0.5, height: 0.2 },
                },
                {
                    number: "2", type: "objective", questionText: "其实对了", studentAnswer: "4", correctAnswer: "5",
                    verdict: "wrong", confidence: 0.4, errorCause: "需确认", knowledgePoints: ["加法"], subjectHint: "数学",
                    bbox: null,
                },
            ],
        });
        const paper = await createPaper();
        await recognize(paper.id);
        const loaded = await (await GET_PAPER(new Request(`http://localhost/api/parent/papers/${paper.id}`), { params: Promise.resolve({ id: paper.id }) })).json();
        const [wrong, maybeRight] = loaded.questions;

        const patched = await PATCH_QUESTION(new Request(`http://localhost/api/parent/papers/${paper.id}/questions/${maybeRight.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ overrideVerdict: "correct" }),
        }), { params: Promise.resolve({ id: paper.id, questionId: maybeRight.id }) });
        expect(patched.status).toBe(200);
        const afterPatch = await patched.json();
        expect(afterPatch.questions[1].effectiveVerdict).toBe("correct");

        const confirmed = await CONFIRM(new Request(`http://localhost/api/parent/papers/${paper.id}/confirm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ language: "zh" }),
        }), { params: Promise.resolve({ id: paper.id }) });
        expect(confirmed.status).toBe(200);
        const result = await confirmed.json();
        expect(result.importedCount).toBe(1);
        expect(result.paper.status).toBe(PARENT_PAPER_STATUS.confirmed);

        const items = await db.errorItem.findMany();
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            learnerId: "child-a",
            userId: "parent-1",
            questionText: "错题",
            wrongAnswerText: "3",
            answerText: "2",
            originalImageUrl: expect.stringMatching(/^data:image\/jpeg;base64,/),
        });
        expect(items[0].userNotes).toBeNull();
        expect(mocks.replan).toHaveBeenCalledWith("parent-1", "zh", "child-a");
        expect(result.paper.questions.find((question: { id: string }) => question.id === wrong.id).importedErrorItemId).toBe(items[0].id);
    });

    it("marks a failed recognition so the parent can retry", async () => {
        mocks.readExamPaper.mockRejectedValueOnce(new Error("AI_TIMEOUT_ERROR"));
        const paper = await createPaper();
        await recognize(paper.id);
        const failed = await (await GET_PAPER(new Request(`http://localhost/api/parent/papers/${paper.id}`), { params: Promise.resolve({ id: paper.id }) })).json();
        expect(failed.status).toBe(PARENT_PAPER_STATUS.failed);
        expect(failed.errorMessage).toBe("AI_TIMEOUT_ERROR");

        mocks.readExamPaper.mockResolvedValueOnce({
            studentName: null, className: null, studentNo: null, questions: [],
            reviewQuestions: [{
                number: "1", type: "objective", questionText: "重试成功", studentAnswer: "1", correctAnswer: "1",
                verdict: "correct", confidence: 0.9, errorCause: null, knowledgePoints: [], subjectHint: null, bbox: null,
            }],
        });
        await recognize(paper.id);
        const retried = await (await GET_PAPER(new Request(`http://localhost/api/parent/papers/${paper.id}`), { params: Promise.resolve({ id: paper.id }) })).json();
        expect(retried.status).toBe(PARENT_PAPER_STATUS.pendingConfirmation);
        expect(retried.questions).toHaveLength(1);
    });

    it("marks interrupted recognizing papers as failed", async () => {
        const paper = await createPaper();
        await db.parentPaper.update({ where: { id: paper.id }, data: { status: PARENT_PAPER_STATUS.recognizing } });
        await expect(failStaleRecognizingPapers(db)).resolves.toBe(1);
        const row = await db.parentPaper.findUniqueOrThrow({ where: { id: paper.id } });
        expect(row.status).toBe(PARENT_PAPER_STATUS.failed);
        expect(row.errorMessage).toBe("SERVER_RESTARTED");
    });

    it("lets the parent persist a corrected question box", async () => {
        mocks.readExamPaper.mockResolvedValue({
            studentName: null, className: null, studentNo: null, questions: [],
            reviewQuestions: [{
                number: "1", type: "objective", questionText: "计算", studentAnswer: "3", correctAnswer: "2",
                verdict: "wrong", confidence: 0.9, errorCause: "算错", knowledgePoints: ["加法"], subjectHint: "数学",
                bbox: { pageIndex: 0, x: 0.06, y: 0.12, width: 0.15, height: 0.08 },
            }],
        });
        const paper = await createPaper();
        await recognize(paper.id);
        const loaded = await (await GET_PAPER(new Request(`http://localhost/api/parent/papers/${paper.id}`), { params: Promise.resolve({ id: paper.id }) })).json();
        const questionId = loaded.questions[0].id;
        const patched = await PATCH_QUESTION(new Request(`http://localhost/api/parent/papers/${paper.id}/questions/${questionId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bbox: { pageIndex: 0, x: 0.08, y: 0.1, width: 0.84, height: 0.22 } }),
        }), { params: Promise.resolve({ id: paper.id, questionId }) });
        expect(patched.status).toBe(200);
        const body = await patched.json();
        expect(body.questions[0].bbox).toEqual({ pageIndex: 0, x: 0.08, y: 0.1, width: 0.84, height: 0.22 });

        const invalid = await PATCH_QUESTION(new Request(`http://localhost/api/parent/papers/${paper.id}/questions/${questionId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bbox: { pageIndex: 3, x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }),
        }), { params: Promise.resolve({ id: paper.id, questionId }) });
        expect(invalid.status).toBe(400);
    });

    it("flags x+2=5 judged as correct when the student wrote x=2", async () => {
        mocks.readExamPaper.mockResolvedValue({
            studentName: null, className: null, studentNo: null, questions: [],
            reviewQuestions: [{
                number: "2", type: "objective", questionText: "解方程：$x + 2 = 5$",
                studentAnswer: "x = 2", correctAnswer: "x = 2",
                verdict: "correct", confidence: 0.99, errorCause: null, knowledgePoints: ["方程"], subjectHint: "数学",
                bbox: { pageIndex: 0, x: 0.1, y: 0.3, width: 0.8, height: 0.2 },
            }],
        });
        const paper = await createPaper();
        await recognize(paper.id);
        const detail = await (await GET_PAPER(new Request(`http://localhost/api/parent/papers/${paper.id}`), { params: Promise.resolve({ id: paper.id }) })).json();
        expect(detail.questions[0].verdict).toBe("correct");
        expect(detail.questions[0].confidence).toBeLessThan(0.7);
        expect(detail.questions[0].correctAnswer.replace(/\s/g, "")).toMatch(/x=3/);
        expect(mocks.completeJson).not.toHaveBeenCalled();
    });

    it("returns imported notebooks after confirm", async () => {
        mocks.readExamPaper.mockResolvedValue({
            studentName: null, className: null, studentNo: null, questions: [],
            reviewQuestions: [{
                number: "1", type: "objective", questionText: "计算 1+1", studentAnswer: "3", correctAnswer: "2",
                verdict: "wrong", confidence: 0.95, errorCause: "加法算错", knowledgePoints: ["加法"], subjectHint: "数学",
                bbox: null,
            }],
        });
        const paper = await createPaper();
        await recognize(paper.id);
        const confirmed = await CONFIRM(new Request(`http://localhost/api/parent/papers/${paper.id}/confirm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ language: "zh" }),
        }), { params: Promise.resolve({ id: paper.id }) });
        const result = await confirmed.json();
        expect(confirmed.status).toBe(200);
        expect(result.importedCount).toBe(1);
        expect(result.replanned).toBe(true);
        expect(result.importedNotebooks).toEqual([
            expect.objectContaining({ subjectName: "数学", count: 1 }),
        ]);
        expect(result.paper.importedNotebooks).toEqual(result.importedNotebooks);
    });

    it("lists status for the current child", async () => {
        const paper = await createPaper();
        await db.parentPaper.update({ where: { id: paper.id }, data: { status: PARENT_PAPER_STATUS.pendingConfirmation } });
        const listed = await GET(new Request("http://localhost/api/parent/papers?learnerId=child-a"));
        const body = await listed.json();
        expect(body.papers[0].status).toBe(PARENT_PAPER_STATUS.pendingConfirmation);
    });
});
