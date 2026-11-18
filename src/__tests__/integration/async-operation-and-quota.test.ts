// @vitest-environment node
/**
 * 统一 AsyncOperation 作业表、断线可恢复请求隔离、冷启动恢复与原子 AiDailyQuota 并发集成测试（真实 SQLite）
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { NextResponse } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_JPEG_DATA_URL } from "../helpers/sample-images";

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    currentUser: { id: "user-a", role: "user", personas: '["parent"]' },
    sessionEmail: "user-a@example.com" as string | null,
    config: { aiDailyLimit: 5, aiConcurrencyLimit: 2 } as { aiDailyLimit?: number; aiConcurrencyLimit?: number },
}));

vi.mock("@/lib/prisma", () => ({ get prisma() { return mocks.prisma; } }));
vi.mock("@/lib/config", () => ({
    getAppConfig: () => mocks.config,
    getAppTimeZone: () => "Asia/Shanghai",
}));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("next-auth", () => ({
    getServerSession: vi.fn(async () => (
        mocks.sessionEmail ? { user: { email: mocks.sessionEmail }, expires: "2099-01-01" } : null
    )),
}));
vi.mock("@/lib/current-user", () => ({
    getCurrentUser: vi.fn(async () => mocks.currentUser),
}));
vi.mock("@/lib/logger", () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET as GET_REQUEST_RESULT } from "@/app/api/requests/[id]/route";
import { GET as GET_TASKS } from "@/app/api/tasks/route";
import { POST as RECOGNIZE_PAPER } from "@/app/api/parent/papers/[id]/recognize/route";
import { consumeAiQuota, releaseAiQuota } from "@/lib/ai-quota";
import {
    CrossTenantOperationError,
    findOwnedAsyncOperation,
    IdempotencyConflictError,
    recoverInterruptedAsyncOperations,
    runIdempotentOperation,
} from "@/lib/async-operations";
import {
    flushBackgroundTasksToDb,
    resetBackgroundTasksForTest,
    SERVER_RESTARTED,
    startBackgroundTask,
} from "@/lib/background-tasks";
import {
    resetRecoverableResponsesForTest,
    withRecoverableResponse,
} from "@/lib/recoverable-response";
import { defineApiRoute } from "@/lib/server/api-route";

let directory: string;
let db: PrismaClient;
let prevConfigDir: string | undefined;

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "async-op-quota-"));
    prevConfigDir = process.env.CONFIG_DIR;
    process.env.CONFIG_DIR = join(directory, "config");
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
    if (prevConfigDir === undefined) delete process.env.CONFIG_DIR;
    else process.env.CONFIG_DIR = prevConfigDir;
    rmSync(directory, { recursive: true, force: true });
});

beforeEach(async () => {
    resetBackgroundTasksForTest();
    resetRecoverableResponsesForTest();
    mocks.config = { aiDailyLimit: 5, aiConcurrencyLimit: 2 };
    mocks.currentUser = { id: "user-a", role: "user", personas: '["parent"]' };
    mocks.sessionEmail = "user-a@example.com";

    await db.asyncOperation.deleteMany();
    await db.aiDailyQuota.deleteMany();
    await db.aiUsage.deleteMany();
    await db.parentPaperPage.deleteMany();
    await db.parentPaper.deleteMany();
    await db.learner.deleteMany();
    await db.user.deleteMany();

    await db.user.createMany({
        data: [
            { id: "user-a", email: "user-a@example.com", password: "h", personas: '["parent"]' },
            { id: "user-b", email: "user-b@example.com", password: "h", personas: '["parent"]' },
        ],
    });
});

describe("AsyncOperation 统一作业表", () => {
    it("同一幂等键并发 20 次只执行 1 次副作用并共享结果，异载荷返回 409，跨用户不可见 (404)", async () => {
        const execute = vi.fn(async () => {
            await new Promise((r) => setTimeout(r, 20));
            return { createdId: "item-42", count: 1 };
        });

        const runs = await Promise.all(
            Array.from({ length: 20 }, () =>
                runIdempotentOperation(
                    {
                        db,
                        userId: "user-a",
                        kind: "import_batch",
                        idempotencyKey: "idem-key-1",
                        payload: { b: 2, a: 1 },
                    },
                    execute,
                ),
            ),
        );

        expect(execute).toHaveBeenCalledTimes(1);
        expect(runs.every((item) => item.result.createdId === "item-42")).toBe(true);
        expect(runs.filter((item) => !item.reused)).toHaveLength(1);
        expect(runs.filter((item) => item.reused)).toHaveLength(19);

        // 键序不同但语义相同应复用（reused: true），而非冲突
        const samePayloadDifferentKeyOrder = await runIdempotentOperation(
            {
                db,
                userId: "user-a",
                kind: "import_batch",
                idempotencyKey: "idem-key-1",
                payload: { a: 1, b: 2 },
            },
            execute,
        );
        expect(samePayloadDifferentKeyOrder.reused).toBe(true);
        expect(execute).toHaveBeenCalledTimes(1);

        // 同键不同载荷应抛 IdempotencyConflictError (409)
        await expect(
            runIdempotentOperation(
                {
                    db,
                    userId: "user-a",
                    kind: "import_batch",
                    idempotencyKey: "idem-key-1",
                    payload: { a: 1, b: 999 },
                },
                execute,
            ),
        ).rejects.toBeInstanceOf(IdempotencyConflictError);

        // 不同用户使用同一 idempotencyKey 互不冲突；跨用户查主记录返回 null (对应 404)
        const otherExecute = vi.fn(async () => ({ createdId: "item-b", count: 1 }));
        const otherResult = await runIdempotentOperation(
            {
                db,
                userId: "user-b",
                kind: "import_batch",
                idempotencyKey: "idem-key-1",
                payload: { differentForUserB: true },
            },
            otherExecute,
        );
        expect(otherResult.reused).toBe(false);
        expect(otherExecute).toHaveBeenCalledTimes(1);

        const rowA = await db.asyncOperation.findUniqueOrThrow({
            where: {
                scopeKey_category_kind_idempotencyKey: {
                    scopeKey: "user-a",
                    category: "idempotent",
                    kind: "import_batch",
                    idempotencyKey: "idem-key-1",
                },
            },
        });
        expect(await findOwnedAsyncOperation(db, rowA.id, "user-a")).not.toBeNull();
        expect(await findOwnedAsyncOperation(db, rowA.id, "user-b")).toBeNull();
        expect(new CrossTenantOperationError().status).toBe(404);
    });

    it("recoverable-response 跨用户返回 404，清空进程内存后仍可从 AsyncOperation 取回", async () => {
        const reqId = "1234567890abcdef1234567890abcdef";
        const postHandler = defineApiRoute(
            { auth: "user" },
            withRecoverableResponse(async () => NextResponse.json({ answer: "x = 3" }, { status: 201 })),
        );

        const res = await postHandler(
            new Request("http://localhost/api/analyze", {
                method: "POST",
                headers: { "X-Request-Id": reqId },
            }),
        );
        expect(res.status).toBe(201);

        // 用户 B 无权读取用户 A 的响应，返回 404
        mocks.currentUser = { id: "user-b", role: "user", personas: '["parent"]' };
        const forbiddenLookup = await GET_REQUEST_RESULT(
            new Request(`http://localhost/api/requests/${reqId}`),
            { params: Promise.resolve({ id: reqId }) },
        );
        expect(forbiddenLookup.status).toBe(404);
        mocks.sessionEmail = "user-b@example.com";

        const secondHandler = defineApiRoute(
            { auth: "user" },
            withRecoverableResponse(async () => NextResponse.json({ answer: "x = 7" })),
        );
        await secondHandler(new Request("http://localhost/api/analyze", {
            method: "POST", headers: { "X-Request-Id": reqId },
        }));

        // 模拟服务重启：清空内存缓存
        resetRecoverableResponsesForTest();

        const secondResult = await GET_REQUEST_RESULT(new Request(`http://localhost/api/requests/${reqId}`),
            { params: Promise.resolve({ id: reqId }) });
        expect(await secondResult.json()).toEqual({ state: "done", status: 200, body: { answer: "x = 7" } });

        // 用户 A 在进程重启后仍能从 AsyncOperation 表恢复响应
        mocks.sessionEmail = "user-a@example.com";
        mocks.currentUser = { id: "user-a", role: "user", personas: '["parent"]' };
        const recovered = await GET_REQUEST_RESULT(
            new Request(`http://localhost/api/requests/${reqId}`),
            { params: Promise.resolve({ id: reqId }) },
        );
        expect(recovered.status).toBe(200);
        expect(await recovered.json()).toEqual({
            state: "done",
            status: 201,
            body: { answer: "x = 3" },
        });
    });

    it("后台任务持久化到 AsyncOperation（不写 json 文件），重启恢复置为 interrupted 且界面可读出 SERVER_RESTARTED", async () => {
        const doneTask = startBackgroundTask({ userId: "user-a", kind: "reanswer", subject: "已完成任务" });
        doneTask.succeed();
        startBackgroundTask({ userId: "user-a", kind: "retag_notebook", subject: "进行中任务", total: 5 }).setProgress(2, 5, 0);
        await flushBackgroundTasksToDb();

        // 淘汰旧 config/background-tasks.json
        expect(existsSync(join(process.env.CONFIG_DIR!, "background-tasks.json"))).toBe(false);

        // 模拟进程重启并执行启动自愈
        resetBackgroundTasksForTest();
        const interruptedCount = await recoverInterruptedAsyncOperations(db);
        expect(interruptedCount).toBe(1);

        const dbRows = await db.asyncOperation.findMany({ where: { userId: "user-a", category: "task" } });
        expect(dbRows.find((r) => r.subject === "进行中任务")?.status).toBe("interrupted");

        const apiRes = await GET_TASKS();
        expect(apiRes.status).toBe(200);
        const body = await apiRes.json() as { tasks: Array<{ subject: string | null; status: string; error: string | null; progress: unknown }> };
        expect(body.tasks.find((t) => t.subject === "已完成任务")).toMatchObject({ status: "succeeded", error: null });
        expect(body.tasks.find((t) => t.subject === "进行中任务")).toMatchObject({
            status: "failed",
            error: SERVER_RESTARTED,
            progress: { done: 2, total: 5, failed: 0 },
        });
    });
});

describe("AiDailyQuota 原子配额预留与释放", () => {
    it("剩余 1 次额度时 20 并发调用严格只放行 1 次，其余 19 次返回 429", async () => {
        mocks.config = { aiDailyLimit: 5, aiConcurrencyLimit: 2 };
        await db.aiUsage.createMany({
            data: [
                { userId: "user-a", kind: "analyze" },
                { userId: "user-a", kind: "analyze" },
                { userId: "user-a", kind: "reanswer" },
                { userId: "user-a", kind: "practice" },
            ],
        });

        const results = await Promise.all(
            Array.from({ length: 20 }, () => consumeAiQuota({ id: "user-a", role: "user" }, "analyze")),
        );

        const allowed = results.filter((res) => res === null);
        const blocked = results.filter((res): res is NonNullable<typeof res> => res !== null);

        expect(allowed).toHaveLength(1);
        expect(blocked).toHaveLength(19);
        for (const res of blocked) {
            expect(res.status).toBe(429);
        }

        const quotaRows = await db.aiDailyQuota.findMany({ where: { userId: "user-a" } });
        expect(quotaRows).toHaveLength(1);
        expect(quotaRows[0].count).toBe(5);
        expect(await db.aiUsage.count({ where: { userId: "user-a" } })).toBe(5);
    });

    it("家长试卷识别路由接入额度拦截，404 失败时退回预留额度", async () => {
        mocks.config = { aiDailyLimit: 1, aiConcurrencyLimit: 2 };
        await db.learner.create({
            data: { id: "child-1", userId: "user-a", kind: "child", name: "小星" },
        });
        const paper = await db.parentPaper.create({
            data: {
                id: "paper-q",
                userId: "user-a",
                learnerId: "child-1",
                pages: { create: [{ position: 0, imageUrl: SAMPLE_JPEG_DATA_URL }] },
            },
        });

        // 不存在的试卷：扣完后释放
        const notFoundRes = await RECOGNIZE_PAPER(
            new Request("http://localhost/api/parent/papers/missing/recognize", { method: "POST" }),
            { params: Promise.resolve({ id: "missing" }) },
        );
        expect(notFoundRes.status).toBe(404);
        const quotaAfter404 = await db.aiDailyQuota.findFirstOrThrow({ where: { userId: "user-a" } });
        expect(quotaAfter404.count).toBe(0);

        // releaseAiQuota 也不会扣成负数
        await releaseAiQuota("user-a");
        const quotaNonNeg = await db.aiDailyQuota.findFirstOrThrow({ where: { userId: "user-a" } });
        expect(quotaNonNeg.count).toBe(0);

        // 真正占满 1 次后，下一次应直接返 429（此处模拟已达上限）
        await consumeAiQuota({ id: "user-a", role: "user" }, "grade");
        const blockedRes = await RECOGNIZE_PAPER(
            new Request(`http://localhost/api/parent/papers/${paper.id}/recognize`, { method: "POST" }),
            { params: Promise.resolve({ id: paper.id }) },
        );
        expect(blockedRes.status).toBe(429);
    });
});
