// @vitest-environment node
/**
 * OPT-17 管理员运营诊断指标（GET /api/admin/metrics）真实 SQLite 集成测试
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
    resetConcurrencyTelemetryForTest,
    runWithModelConcurrency,
} from "@/lib/ai/concurrency";

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    sessionUser: {
        id: "admin-1",
        email: "admin@localhost",
        role: "admin",
        isActive: true,
        authVersion: 0,
    } as { id: string; email: string; role: string; isActive: boolean; authVersion: number } | null,
    config: { aiConcurrencyLimit: 1 },
}));

vi.mock("@/lib/prisma", () => ({ get prisma() { return mocks.prisma; } }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("next-auth", () => ({
    getServerSession: vi.fn(async () =>
        mocks.sessionUser ? { user: mocks.sessionUser, expires: "2099-01-01" } : null,
    ),
}));
vi.mock("@/lib/config", () => ({
    getAppConfig: () => mocks.config,
    getAppTimeZone: () => "Asia/Shanghai",
}));

import { GET } from "@/app/api/admin/metrics/route";

let directory: string;
let db: PrismaClient;

beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "wn-ops-metrics-"));
    const dbUrl = `file:${join(directory, "metrics.db")}?connection_limit=1`;
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
        cwd: resolve(__dirname, "../../.."),
        env: { ...process.env, DATABASE_URL: dbUrl },
        stdio: "pipe",
    });

    db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    await db.$connect();
    mocks.prisma = db;
});

beforeEach(async () => {
    resetConcurrencyTelemetryForTest();
    mocks.sessionUser = {
        id: "admin-1",
        email: "admin@localhost",
        role: "admin",
        isActive: true,
        authVersion: 0,
    };

    await db.$executeRawUnsafe("PRAGMA foreign_keys = OFF;");
    await db.asyncOperation.deleteMany();
    await db.parentPaperQuestion.deleteMany();
    await db.parentPaper.deleteMany();
    await db.gradingResult.deleteMany();
    await db.gradingSubmission.deleteMany();
    await db.gradingKeyQuestion.deleteMany();
    await db.gradingTask.deleteMany();
    await db.gradingClass.deleteMany();
    await db.variantRun.deleteMany();
    await db.aiProvenance.deleteMany();
    await db.learner.deleteMany();
    await db.user.deleteMany();
    await db.$executeRawUnsafe("PRAGMA foreign_keys = ON;");

    await db.user.create({
        data: {
            id: "admin-1",
            email: "admin@localhost",
            password: "hash",
            role: "admin",
            isActive: true,
        },
    });
    await db.user.create({
        data: {
            id: "user-1",
            email: "member@example.com",
            password: "hash",
            role: "user",
            isActive: true,
        },
    });
});

afterAll(async () => {
    await db?.$disconnect();
    if (directory) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe("GET /api/admin/metrics", () => {
    it("拒绝未登录和普通用户访问，仅管理员可获取", async () => {
        mocks.sessionUser = null;
        const anonRes = await GET(new Request("http://localhost/api/admin/metrics"));
        expect(anonRes.status).toBe(403);

        mocks.sessionUser = {
            id: "user-1",
            email: "member@example.com",
            role: "user",
            isActive: true,
            authVersion: 0,
        };
        const userRes = await GET(new Request("http://localhost/api/admin/metrics"));
        expect(userRes.status).toBe(403);
    });

    it("准确聚合任务成功/失败/未知分布、AI 并发 429 与队列饱和率、外键检查及溯源修改率", async () => {
        const learner = await db.learner.create({
            data: { userId: "user-1", kind: "child", name: "测试孩子" },
        });
        const gClass = await db.gradingClass.create({
            data: { userId: "user-1", name: "初一(1)班" },
        });
        const gTask = await db.gradingTask.create({
            data: { userId: "user-1", classId: gClass.id, title: "期中测验" },
        });
        const keyQuestion = await db.gradingKeyQuestion.create({
            data: { taskId: gTask.id, order: 1, number: "1", answer: "A" },
        });

        // 1. 业务表状态：家长试卷(2成+1败+1进行中)、批改提交(1成+1败)、变式(1成)、AsyncOperation(1中断未知)
        const paperConfirmed = await db.parentPaper.create({
            data: { userId: "user-1", learnerId: learner.id, status: "confirmed" },
        });
        await db.parentPaper.createMany({
            data: [
                { userId: "user-1", learnerId: learner.id, status: "pending_confirmation" },
                { userId: "user-1", learnerId: learner.id, status: "failed" },
                { userId: "user-1", learnerId: learner.id, status: "recognizing" },
            ],
        });

        const subGraded = await db.gradingSubmission.create({
            data: { taskId: gTask.id, images: "[]", status: "graded" },
        });
        await db.gradingSubmission.create({
            data: { taskId: gTask.id, images: "[]", status: "failed" },
        });
        await db.variantRun.create({
            data: { userId: "user-1", kind: "practice", mode: "pipeline", status: "completed" },
        });

        await db.asyncOperation.createMany({
            data: [
                { userId: "user-1", scopeKey: "user-1", category: "task", kind: "analyze", idempotencyKey: "k1", status: "succeeded" },
                { userId: "user-1", scopeKey: "user-1", category: "task", kind: "analyze", idempotencyKey: "k2", status: "failed" },
                { userId: "user-1", scopeKey: "user-1", category: "task", kind: "variant", idempotencyKey: "k3", status: "interrupted" },
            ],
        });

        // 2. AiProvenance 与人工修改信号（5 条中有 2 条被改判，rate = 0.4）
        const provPaper = await db.aiProvenance.create({
            data: {
                task: "exam-read",
                provider: "deepseek",
                model: "deepseek-chat",
                promptVersion: "pv1",
                parserVersion: "1.0.0",
            },
        });
        await db.parentPaperQuestion.createMany({
            data: [
                // 未覆盖：不计修改
                { paperId: paperConfirmed.id, position: 1, number: "1", verdict: "wrong", overrideVerdict: null, provenanceId: provPaper.id },
                // 覆盖值与原值一致：不计修改
                { paperId: paperConfirmed.id, position: 2, number: "2", verdict: "wrong", overrideVerdict: "wrong", provenanceId: provPaper.id },
                // 覆盖值与原值不同：计修改
                { paperId: paperConfirmed.id, position: 3, number: "3", verdict: "wrong", overrideVerdict: "correct", provenanceId: provPaper.id },
            ],
        });
        await db.gradingResult.createMany({
            data: [
                { submissionId: subGraded.id, keyQuestionId: keyQuestion.id, verdict: "wrong", source: "ai", provenanceId: provPaper.id },
            ],
        });
        const keyQuestion2 = await db.gradingKeyQuestion.create({
            data: { taskId: gTask.id, order: 2, number: "2", answer: "B" },
        });
        await db.gradingResult.create({
            data: { submissionId: subGraded.id, keyQuestionId: keyQuestion2.id, verdict: "correct", source: "teacher", provenanceId: provPaper.id },
        });

        // 3. AI 并发遥测：1 次成功 + 1 次上游 429 + 1 次队列饱和拒绝（共 3 次，确认不泄露 baseUrl）
        const secretBaseUrl = "https://secret-internal.example.invalid/v1";
        const modelKey = `openai|${secretBaseUrl}|gpt-4o-mini`;
        let releaseFirst!: () => void;
        const firstDone = new Promise<void>((r) => { releaseFirst = r; });

        const okCall = runWithModelConcurrency(modelKey, async () => {
            await firstDone;
            return "ok";
        });
        // 等待队列已满时立即拒绝，验证 baseUrl 不泄露且 queueRejectedCount 增加
        await expect(
            runWithModelConcurrency(modelKey, async () => "blocked", { maxWaiting: 0 }),
        ).rejects.toThrow("AI_QUEUE_FULL");
        releaseFirst();
        await okCall;

        await expect(
            runWithModelConcurrency(modelKey, async () => {
                throw new Error("AI_QUOTA_EXCEEDED");
            }),
        ).rejects.toThrow("AI_QUOTA_EXCEEDED");

        const res = await GET(new Request("http://localhost/api/admin/metrics"));
        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.tasks.parentPapers).toMatchObject({ total: 4, succeeded: 2, failed: 1, inFlight: 1, unknown: 0 });
        expect(body.tasks.gradingSubmissions).toMatchObject({ total: 2, succeeded: 1, failed: 1, inFlight: 0, unknown: 0 });
        expect(body.tasks.variantRuns).toMatchObject({ total: 1, succeeded: 1, failed: 0, inFlight: 0, unknown: 0 });
        expect(body.tasks.asyncOperations).toMatchObject({ total: 3, succeeded: 1, failed: 1, interrupted: 1, unknown: 1 });
        expect(body.tasks.summary).toMatchObject({
            total: 8, // 4 papers + 2 submissions + 1 variant + 1 interrupted async
            succeeded: 4,
            failed: 2,
            inFlight: 1,
            unknown: 1,
            successRate: 0.5,
            failureRate: 0.25,
            unknownRate: 0.125,
        });

        expect(body.aiConcurrency.totalCalls).toBe(3);
        expect(body.aiConcurrency.succeededCalls).toBe(1);
        expect(body.aiConcurrency.provider429Count).toBe(1);
        expect(body.aiConcurrency.queueRejectedCount).toBe(1);
        expect(body.aiConcurrency.provider429Rate).toBeCloseTo(1 / 3, 3);
        expect(body.aiConcurrency.queueSaturationRate).toBeCloseTo(1 / 3, 3);
        expect(JSON.stringify(body)).not.toContain(secretBaseUrl);

        expect(body.foreignKeyCheck).toEqual({
            ok: true,
            violationCount: 0,
            affectedTables: [],
        });

        expect(body.provenanceQuality).toEqual({
            totalReviewedItems: 5,
            manualModifiedCount: 2,
            manualModifiedRate: 0.4,
            byProvenance: [
                {
                    provenanceId: provPaper.id,
                    task: "exam-read",
                    provider: "deepseek",
                    model: "deepseek-chat",
                    promptVersion: "pv1",
                    parserVersion: "1.0.0",
                    totalCount: 5,
                    modifiedCount: 2,
                    manualModifiedRate: 0.4,
                    parentPaper: { totalCount: 3, modifiedCount: 1 },
                    grading: { totalCount: 2, modifiedCount: 1 },
                },
            ],
        });
    });

    it("PRAGMA foreign_key_check 异常时安全转换 BigInt 并返回受影响表名", async () => {
        await db.$executeRawUnsafe("PRAGMA foreign_keys = OFF;");
        await db.$executeRawUnsafe(
            `INSERT INTO "ParentPaper" ("id", "userId", "learnerId", "status", "updatedAt") VALUES ('orphan-paper', 'missing-user', 'missing-learner', 'failed', CURRENT_TIMESTAMP);`,
        );
        await db.$executeRawUnsafe("PRAGMA foreign_keys = ON;");

        const res = await GET(new Request("http://localhost/api/admin/metrics"));
        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.foreignKeyCheck.ok).toBe(false);
        expect(body.foreignKeyCheck.violationCount).toBeGreaterThanOrEqual(1);
        expect(body.foreignKeyCheck.affectedTables).toContain("ParentPaper");
    });
});
