// @vitest-environment node
/**
 * 文件夹导入单份答卷 API 真实 SQLite 集成测试：幂等重试不重复建卷、学生/任务跨老师 404、
 * 专注做题模式 403、额度用完不留下半截记录、请求体与页数上限。
 */
import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { NextResponse } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_JPEG_DATA_URL } from "../helpers/sample-images";
import { createIsolatedTestDb, type IsolatedTestDb } from "../helpers/two-tenants";

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    session: { user: { id: "teacher-a", email: "ta@example.com" }, expires: "2099-01-01" } as { user: { id: string; email: string }; expires: string } | null,
    consumeAiQuota: vi.fn<() => Promise<Response | null>>(async () => null),
    scheduleGrading: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ get prisma() { return mocks.prisma; } }));
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock('@/lib/ai-quota', async () => (await import('../helpers/ai-quota-mock')).createAiQuotaMock((...args) => mocks.consumeAiQuota(...(args as []))));
vi.mock("@/lib/grading-service", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/grading-service")>()),
    scheduleGrading: mocks.scheduleGrading,
}));
vi.mock("@/lib/logger", () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST as FOLDER_IMPORT } from "@/app/api/grading/tasks/[id]/folder-import/route";
import { KID_MODE_COOKIE_NAME, signKidModeToken } from "@/lib/kid-mode-lock";

const key = (seed: string) => crypto.createHash("sha256").update(seed).digest("hex");

const post = (taskId: string, body: unknown, headers: Record<string, string> = {}) =>
    FOLDER_IMPORT(
        new Request(`http://127.0.0.1/api/grading/tasks/${taskId}/folder-import`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: typeof body === "string" ? body : JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: taskId }) },
    );

let testDb: IsolatedTestDb;
let db: PrismaClient;

beforeAll(() => {
    testDb = createIsolatedTestDb("grading-folder-import-");
    db = testDb.db;
    mocks.prisma = db;
}, 120000);

afterAll(async () => {
    await testDb.cleanup();
});

beforeEach(async () => {
    vi.clearAllMocks();
    mocks.session = { user: { id: "teacher-a", email: "ta@example.com" }, expires: "2099-01-01" };
    mocks.consumeAiQuota.mockResolvedValue(null);
    await db.$executeRawUnsafe("PRAGMA foreign_keys = OFF;");
    await db.asyncOperation.deleteMany();
    await db.gradingSubmission.deleteMany();
    await db.gradingKeyQuestion.deleteMany();
    await db.gradingTask.deleteMany();
    await db.gradingStudent.deleteMany();
    await db.gradingClass.deleteMany();
    await db.user.deleteMany();
    await db.$executeRawUnsafe("PRAGMA foreign_keys = ON;");

    await db.user.createMany({
        data: [
            { id: "teacher-a", email: "ta@example.com", password: "h", personas: '["teacher"]' },
            { id: "teacher-b", email: "tb@example.com", password: "h", personas: '["teacher"]' },
        ],
    });
    await db.gradingClass.create({
        data: {
            id: "class-a", userId: "teacher-a", name: "七年级1班",
            students: { create: [{ id: "stu-zhang", name: "张三", studentNo: "01" }, { id: "stu-li", name: "李四", studentNo: "02" }] },
        },
    });
    await db.gradingClass.create({
        data: { id: "class-b", userId: "teacher-b", name: "八年级2班", students: { create: [{ id: "stu-other", name: "王五", studentNo: "01" }] } },
    });
    await db.gradingTask.create({
        data: {
            id: "task-a", userId: "teacher-a", classId: "class-a", title: "期中",
            questions: { create: [{ order: 0, number: "1", type: "choice", maxScore: 5, answer: "A" }] },
        },
    });
    await db.gradingTask.create({
        data: { id: "task-empty", userId: "teacher-a", classId: "class-a", title: "无答案" },
    });
    await db.gradingTask.create({
        data: {
            id: "task-b", userId: "teacher-b", classId: "class-b", title: "别人的",
            questions: { create: [{ order: 0, number: "1", type: "choice", maxScore: 5, answer: "A" }] },
        },
    });
});

describe("POST /api/grading/tasks/:id/folder-import", () => {
    it("老师指定学生建一份答卷并排队判分；同一 importKey 重试复用同一份，不重复建卷、不重复扣额度", async () => {
        const body = { importKey: key("p1"), images: [SAMPLE_JPEG_DATA_URL, SAMPLE_JPEG_DATA_URL], studentId: "stu-li", language: "zh" };
        const first = await post("task-a", body);
        expect(first.status).toBe(202);
        const created = await first.json();
        expect(created).toMatchObject({ studentId: "stu-li", matchStatus: "manual", reused: false });

        // 重试时老师改了学生：仍复用已建的那份（不 409、不新建）
        const again = await post("task-a", { ...body, studentId: "stu-zhang" });
        expect(again.status).toBe(200);
        expect(await again.json()).toMatchObject({ id: created.id, reused: true });

        const rows = await db.gradingSubmission.findMany({ where: { taskId: "task-a" } });
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0].images)).toHaveLength(2);
        expect(mocks.consumeAiQuota).toHaveBeenCalledTimes(1);
        expect(mocks.scheduleGrading).toHaveBeenCalledTimes(1);
        expect(mocks.scheduleGrading).toHaveBeenCalledWith([created.id], "zh");
    });

    it("同一 importKey 并发提交只建一份；同键不同图片返回 409", async () => {
        const body = { importKey: key("p2"), images: [SAMPLE_JPEG_DATA_URL], language: "zh" };
        const results = await Promise.all(Array.from({ length: 5 }, () => post("task-a", body)));
        const ids = new Set(await Promise.all(results.map(async (res) => (await res.json()).id)));
        expect(ids.size).toBe(1);
        expect(await db.gradingSubmission.count({ where: { taskId: "task-a" } })).toBe(1);

        const conflictRes = await post("task-a", { ...body, images: [SAMPLE_JPEG_DATA_URL, SAMPLE_JPEG_DATA_URL] });
        expect(conflictRes.status).toBe(409);
    });

    it("按文件夹名得到的身份由服务端重新匹配名册；没有身份时留给 AI 读卷头", async () => {
        const matched = await post("task-a", { importKey: key("p3"), images: [SAMPLE_JPEG_DATA_URL], identity: { studentNo: "01", name: "张三" } });
        expect(await matched.json()).toMatchObject({ studentId: "stu-zhang", matchStatus: "auto" });

        // 张三已有一份：再按名字匹配到他时进入待确认，不静默覆盖
        const duplicate = await post("task-a", { importKey: key("p4"), images: [SAMPLE_JPEG_DATA_URL], identity: { name: "张三" } });
        expect(await duplicate.json()).toMatchObject({ studentId: null, matchStatus: "review" });

        const unknown = await post("task-a", { importKey: key("p5"), images: [SAMPLE_JPEG_DATA_URL] });
        expect(await unknown.json()).toMatchObject({ studentId: null, matchStatus: null });
    });

    it("其他老师的学生或任务一律 404；未登录 401", async () => {
        const otherStudent = await post("task-a", { importKey: key("x1"), images: [SAMPLE_JPEG_DATA_URL], studentId: "stu-other" });
        expect(otherStudent.status).toBe(404);
        const otherTask = await post("task-b", { importKey: key("x2"), images: [SAMPLE_JPEG_DATA_URL] });
        expect(otherTask.status).toBe(404);

        mocks.session = { user: { id: "teacher-b", email: "tb@example.com" }, expires: "2099-01-01" };
        const crossTeacher = await post("task-a", { importKey: key("x3"), images: [SAMPLE_JPEG_DATA_URL] });
        expect(crossTeacher.status).toBe(404);

        mocks.session = null;
        expect((await post("task-a", { importKey: key("x4"), images: [SAMPLE_JPEG_DATA_URL] })).status).toBe(401);
        expect(await db.gradingSubmission.count()).toBe(0);
        expect(mocks.consumeAiQuota).not.toHaveBeenCalled();
    });

    it("专注做题模式下 403", async () => {
        const token = signKidModeToken({ userId: "teacher-a", learnerId: "l1", learnerName: "孩子", authVersion: 0, exp: Math.floor(Date.now() / 1000) + 600 });
        const res = await post("task-a", { importKey: key("k1"), images: [SAMPLE_JPEG_DATA_URL] }, { cookie: `${KID_MODE_COOKIE_NAME}=${token}` });
        expect(res.status).toBe(403);
        expect(await db.gradingSubmission.count()).toBe(0);
    });

    it("额度用完返回 429 且不留下记录，额度恢复后同一 importKey 可以重试成功", async () => {
        mocks.consumeAiQuota.mockResolvedValueOnce(NextResponse.json({ message: "limit" }, { status: 429 }));
        const body = { importKey: key("q1"), images: [SAMPLE_JPEG_DATA_URL] };
        expect((await post("task-a", body)).status).toBe(429);
        expect(await db.gradingSubmission.count()).toBe(0);
        expect(await db.asyncOperation.count()).toBe(0);

        const retry = await post("task-a", body);
        expect(retry.status).toBe(202);
        expect(await db.gradingSubmission.count()).toBe(1);
    });

    it("校验：答案为空 400、页数超限/坏键 400、坏图 400、请求体超限 413", async () => {
        expect((await post("task-empty", { importKey: key("v1"), images: [SAMPLE_JPEG_DATA_URL] })).status).toBe(400);
        expect((await post("task-a", { importKey: key("v2"), images: Array(9).fill(SAMPLE_JPEG_DATA_URL) })).status).toBe(400);
        expect((await post("task-a", { importKey: "not-a-key", images: [SAMPLE_JPEG_DATA_URL] })).status).toBe(400);
        expect((await post("task-a", { importKey: key("v3"), images: ["data:image/jpeg;base64,AAAA"] })).status).toBe(400);
        const huge = JSON.stringify({ importKey: key("v4"), images: [`data:image/jpeg;base64,${"A".repeat(25 * 1024 * 1024)}`] });
        expect((await post("task-a", huge)).status).toBe(413);
        expect(await db.gradingSubmission.count()).toBe(0);
        expect(await db.asyncOperation.count()).toBe(0);
    });
});
