// @vitest-environment node
/**
 * 每日 AI 次数「成功才算」：预留 → 确认 / 退回（真实 SQLite）
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
    config: { aiDailyLimit: 3, aiConcurrencyLimit: 5 } as { aiDailyLimit?: number; aiConcurrencyLimit?: number },
    analyzeImage: vi.fn(),
    readExamPaper: vi.fn(),
    currentUser: { id: "user-a", role: "user", personas: '["parent"]' },
}));

vi.mock("@/lib/prisma", () => ({ get prisma() { return mocks.prisma; } }));
vi.mock("@/lib/config", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/config")>()),
    getAppConfig: () => mocks.config,
    getAppTimeZone: () => "Asia/Shanghai",
}));
vi.mock("@/lib/logger", () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: vi.fn(async () => mocks.currentUser) }));
vi.mock("@/lib/ai", () => ({
    getAIService: () => ({ analyzeImage: mocks.analyzeImage, readExamPaper: mocks.readExamPaper }),
}));
vi.mock("@/lib/parent-paper-verify", () => ({ verifyParentPaperQuestions: async (q: unknown) => q }));

import {
    AI_RESERVATION_TTL_MS,
    aiQuotaRefs,
    countTodayAiUsage,
    reserveAiQuota,
    settleAiReservationsByRef,
} from "@/lib/ai-quota";
import { analyzeImageForUser } from "@/lib/server/analyze-image";
import { POST as RECOGNIZE_PAPER } from "@/app/api/parent/papers/[id]/recognize/route";
import { waitForParentPaperRecognition } from "@/lib/parent-paper-recognize";
import { resetBackgroundTasksForTest } from "@/lib/background-tasks";

let directory: string;
let db: PrismaClient;
const user = { id: "user-a", role: "user" };

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "ai-quota-res-"));
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
    vi.clearAllMocks();
    resetBackgroundTasksForTest();
    mocks.config = { aiDailyLimit: 3, aiConcurrencyLimit: 5 };
    await db.aiDailyQuota.deleteMany();
    await db.aiUsage.deleteMany();
    await db.parentPaperQuestion.deleteMany();
    await db.parentPaperPage.deleteMany();
    await db.parentPaper.deleteMany();
    await db.learner.deleteMany();
    await db.user.deleteMany();
    await db.user.create({ data: { id: "user-a", email: "a@example.com", password: "h", personas: '["parent"]' } });
});

async function dayCount() {
    const rows = await db.aiDailyQuota.findMany({ where: { userId: "user-a" } });
    return rows.reduce((sum, row) => sum + row.count, 0);
}

const sampleBase64 = SAMPLE_JPEG_DATA_URL.split(",")[1];
const question = (text: string) => ({ questionText: text, answerText: "1", analysis: "a", subject: "数学", knowledgePoints: [], mistakeStatus: "wrong_attempt" });

describe("预留、确认与退回", () => {
    it("失败退回后不占名额，成功才计入；统计只算已确认", async () => {
        const failed = await reserveAiQuota(user, "analyze");
        await failed.release();
        const ok = await reserveAiQuota(user, "analyze");
        await ok.confirm();
        expect(await dayCount()).toBe(1);
        expect(await countTodayAiUsage("user-a")).toBe(1);
        expect(await db.aiUsage.count({ where: { status: "released" } })).toBe(1);
        // 重复结算无副作用
        await failed.release();
        await ok.release();
        expect(await dayCount()).toBe(1);
    });

    it("预留中的也占名额：剩 1 次时 15 个并发只放行 1 个", async () => {
        await (await reserveAiQuota(user, "analyze")).confirm();
        await (await reserveAiQuota(user, "analyze")).confirm();
        const results = await Promise.all(Array.from({ length: 15 }, () => reserveAiQuota(user, "grade")));
        expect(results.filter((r) => r.limited === null)).toHaveLength(1);
        expect(results.filter((r) => r.limited?.status === 429)).toHaveLength(14);
        expect(await dayCount()).toBe(3);
        // 那一个失败退回后，又能再用一次
        await results.find((r) => r.limited === null)!.release();
        expect((await reserveAiQuota(user, "grade")).limited).toBeNull();
    });

    it("同一请求编号只预留一次，重复请求失败不会退掉第一次", async () => {
        const req = () => new Request("http://x/api/analyze", { method: "POST", headers: { "x-request-id": "req-1" } });
        const first = await reserveAiQuota(user, "analyze", { request: req() });
        const again = await reserveAiQuota(user, "analyze", { request: req() });
        expect(again.reused).toBe(true);
        expect(again.id).toBe(first.id);
        await again.release();
        expect(await db.aiUsage.findUniqueOrThrow({ where: { id: first.id! } })).toMatchObject({ status: "reserved" });
        await first.confirm();
        expect(await dayCount()).toBe(1);
        expect(await db.aiUsage.count()).toBe(1);
        // 失败退回后同一编号重试会重新预留
        const other = await reserveAiQuota(user, "analyze", { requestKey: "req-2" });
        await other.release();
        const retry = await reserveAiQuota(user, "analyze", { requestKey: "req-2" });
        expect(retry.reused).toBe(false);
        expect(retry.id).toBe(other.id);
        expect(await dayCount()).toBe(2);
    });

    it("超过 15 分钟未结算的预留自动退回；之后任务确实成功则重新计入", async () => {
        const stale = await reserveAiQuota(user, "grade");
        await db.aiUsage.update({ where: { id: stale.id! }, data: { createdAt: new Date(Date.now() - AI_RESERVATION_TTL_MS - 1000) } });
        await reserveAiQuota(user, "analyze");
        expect(await db.aiUsage.findUniqueOrThrow({ where: { id: stale.id! } })).toMatchObject({ status: "expired" });
        expect(await dayCount()).toBe(1);
        await stale.confirm();
        expect(await db.aiUsage.findUniqueOrThrow({ where: { id: stale.id! } })).toMatchObject({ status: "confirmed" });
        expect(await dayCount()).toBe(2);
    });

    it("退回扣的是预留那一天，不是退回时的当天", async () => {
        const quota = await reserveAiQuota(user, "analyze");
        await db.aiUsage.update({ where: { id: quota.id! }, data: { dayKey: "2026-01-01" } });
        await db.aiDailyQuota.create({ data: { userId: "user-a", dayKey: "2026-01-01", count: 4 } });
        await quota.release();
        expect(await db.aiDailyQuota.findUniqueOrThrow({ where: { userId_dayKey: { userId: "user-a", dayKey: "2026-01-01" } } })).toMatchObject({ count: 3 });
        const today = await db.aiDailyQuota.findFirstOrThrow({ where: { userId: "user-a", dayKey: { not: "2026-01-01" } } });
        expect(today.count).toBe(1);
    });

    it("后台任务按关联结算：每份答卷判分成功才算", async () => {
        const a = await reserveAiQuota(user, "grade", { ref: aiQuotaRefs.gradingSubmission("s1") });
        const b = await reserveAiQuota(user, "grade");
        await b.attach(aiQuotaRefs.gradingSubmission("s2"));
        await settleAiReservationsByRef(aiQuotaRefs.gradingSubmission("s1"), true);
        await settleAiReservationsByRef(aiQuotaRefs.gradingSubmission("s2"), false);
        expect(await db.aiUsage.findUniqueOrThrow({ where: { id: a.id! } })).toMatchObject({ status: "confirmed" });
        expect(await db.aiUsage.findUniqueOrThrow({ where: { id: b.id! } })).toMatchObject({ status: "released" });
        expect(await dayCount()).toBe(1);
    });
});

describe("识别题目", () => {
    it("认出题目才算；0 道题、AI 报错都不算；跨页一组只算一次", async () => {
        mocks.analyzeImage.mockResolvedValueOnce({ ...question("1+1=?"), items: [question("1+1=?"), question("2+2=?")] });
        const ok = await analyzeImageForUser({ id: "user-a", role: "user" } as never, { imageBase64: sampleBase64, additionalImages: [sampleBase64] });
        expect(ok.status).toBe(200);
        expect(await countTodayAiUsage("user-a")).toBe(1);

        mocks.analyzeImage.mockResolvedValueOnce({ ...question(""), items: [] });
        const empty = await analyzeImageForUser({ id: "user-a", role: "user" } as never, { imageBase64: sampleBase64 });
        expect(empty.status).toBe(200);

        mocks.analyzeImage.mockRejectedValueOnce(new Error("AI_TIMEOUT_ERROR"));
        const failed = await analyzeImageForUser({ id: "user-a", role: "user" } as never, { imageBase64: sampleBase64 });
        expect(failed.status).toBe(500);

        const invalid = await analyzeImageForUser({ id: "user-a", role: "user" } as never, { imageBase64: "bm90LWFuLWltYWdl" });
        expect(invalid.status).toBe(400);

        expect(await countTodayAiUsage("user-a")).toBe(1);
        expect(await dayCount()).toBe(1);
        expect(await db.aiUsage.count({ where: { status: "released" } })).toBe(2);
    });
});

describe("家长整份卷子识别", () => {
    async function makePaper(id: string) {
        await db.learner.upsert({ where: { id: "child-1" }, update: {}, create: { id: "child-1", userId: "user-a", kind: "child", name: "小星" } });
        return db.parentPaper.create({ data: { id, userId: "user-a", learnerId: "child-1", pages: { create: [{ position: 0, imageUrl: SAMPLE_JPEG_DATA_URL }, { position: 1, imageUrl: SAMPLE_JPEG_DATA_URL }] } } });
    }
    const recognize = (id: string) => RECOGNIZE_PAPER(new Request(`http://localhost/api/parent/papers/${id}/recognize`, { method: "POST" }), { params: Promise.resolve({ id }) });

    it("整份卷子算一次，识别出题目才确认；一题都没有或失败则退回", async () => {
        mocks.readExamPaper.mockResolvedValueOnce({ questions: [], reviewQuestions: [{ number: "1", type: "objective", questionText: "3+4=", studentAnswer: "7", correctAnswer: "7", verdict: "correct", confidence: 0.9, errorCause: null, knowledgePoints: [], bbox: null, subjectHint: null }] });
        await makePaper("p1");
        expect((await recognize("p1")).status).toBe(202);
        await waitForParentPaperRecognition("p1");

        mocks.readExamPaper.mockResolvedValueOnce({ questions: [], reviewQuestions: [] });
        await makePaper("p2");
        expect((await recognize("p2")).status).toBe(202);
        await waitForParentPaperRecognition("p2");

        mocks.readExamPaper.mockRejectedValueOnce(new Error("AI_SERVICE_UNAVAILABLE"));
        await makePaper("p3");
        expect((await recognize("p3")).status).toBe(202);
        await waitForParentPaperRecognition("p3");

        expect(await countTodayAiUsage("user-a")).toBe(1);
        expect(await dayCount()).toBe(1);
        expect(await db.aiUsage.count({ where: { status: "reserved" } })).toBe(0);
    });
});
