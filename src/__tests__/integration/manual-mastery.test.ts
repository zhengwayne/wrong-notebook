// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    session: { user: { id: "user-1", email: "mastery-api@example.com", role: "user" }, expires: "2099-01-01" },
    evaluateMastery: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ get prisma() { return mocks.prisma; } }));
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/logger", () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock("@/lib/ai", () => ({
    getAIService: vi.fn(() => ({ evaluateMastery: mocks.evaluateMastery })),
}));

import { POST as SAVE_ERROR_ITEM } from "@/app/api/error-items/route";
import { POST as MANUAL_MASTERY } from "@/app/api/error-items/[id]/mastery/route";

let directory: string;
let database: PrismaClient;

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "wrong-notebook-manual-mastery-"));
    const url = `file:${join(directory, "test.db")}`;
    execFileSync(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: "pipe",
    });
    database = new PrismaClient({ datasources: { db: { url } } });
    mocks.prisma = database;
}, 120000);

beforeEach(async () => {
    vi.clearAllMocks();
    await database.practiceRecord.deleteMany();
    await database.errorItem.deleteMany();
    await database.subject.deleteMany();
    await database.aiUsage.deleteMany();
    await database.user.deleteMany();
    mocks.session = { user: { id: "user-1", email: "mastery-api@example.com", role: "user" }, expires: "2099-01-01" };
    await database.user.create({
        data: { id: "user-1", email: mocks.session.user.email, password: "x", role: "user" },
    });
    await database.subject.create({
        data: { id: "sub-1", name: "数学", stage: "junior_high", subjectKey: "math", userId: "user-1" },
    });
});

afterAll(async () => {
    await database?.$disconnect();
    if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("掌握评估去隐式 AI 与手动触发端点 (OPT-12a)", () => {
    it("新录题不调用 AI evaluateMastery；有作答记录后可手动 POST /api/error-items/:id/mastery 触发 AI 评估", async () => {
        const createRes = await SAVE_ERROR_ITEM(new Request("http://localhost/api/error-items", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                subjectId: "sub-1",
                questionText: "求解一元一次方程 3x - 6 = 0",
                answerText: "x = 2",
                analysis: "移项并除以 3",
                knowledgePoints: ["方程"],
                originalImageUrl: "",
            }),
        }));
        expect(createRes.status).toBe(201);
        const created = await createRes.json();
        await new Promise((r) => setTimeout(r, 30));
        expect(mocks.evaluateMastery).not.toHaveBeenCalled();

        // 无练习历史时手动触发返回 400
        const emptyRes = await MANUAL_MASTERY(
            new Request(`http://localhost/api/error-items/${created.id}/mastery`, { method: "POST" }),
            { params: Promise.resolve({ id: created.id }) },
        );
        expect(emptyRes.status).toBe(400);

        await database.practiceRecord.create({
            data: { userId: "user-1", errorItemId: created.id, result: "correct", isCorrect: true, source: "practice" },
        });
        mocks.evaluateMastery.mockResolvedValue({ probability: 0.91, reason: "手动评估：解答准确且步骤完整" });

        const okRes = await MANUAL_MASTERY(
            new Request(`http://localhost/api/error-items/${created.id}/mastery`, { method: "POST" }),
            { params: Promise.resolve({ id: created.id }) },
        );
        expect(okRes.status).toBe(200);
        const payload = await okRes.json();
        expect(mocks.evaluateMastery).toHaveBeenCalledTimes(1);
        expect(payload).toMatchObject({
            masteryProbability: 0.91,
            masterySource: "ai",
            masteryLevel: 2,
        });
        expect(await database.aiUsage.count({ where: { userId: "user-1", kind: "mastery" } })).toBe(1);

        // 跨用户访问返回 404
        const other = await database.user.create({
            data: { id: "user-2", email: "other@example.com", password: "x", role: "user" },
        });
        mocks.session = { user: { id: other.id, email: other.email, role: "user" }, expires: "2099-01-01" };
        const crossRes = await MANUAL_MASTERY(
            new Request(`http://localhost/api/error-items/${created.id}/mastery`, { method: "POST" }),
            { params: Promise.resolve({ id: created.id }) },
        );
        expect(crossRes.status).toBe(404);
    });
});
