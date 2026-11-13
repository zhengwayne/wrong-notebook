// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as GET_PATH, POST as POST_PATH } from "@/app/api/learning-path/route";
import { GET as GET_CLASS } from "@/app/api/learning-path/class/route";
import { PATCH as PATCH_STEP } from "@/app/api/learning-path/steps/[id]/route";

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    session: { user: { id: "user-1", email: "lp-test@example.com", role: "user" }, expires: "2099-01-01" },
}));

vi.mock("@/lib/prisma", () => ({ get prisma() { return mocks.prisma; } }));
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/logger", () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock("@/lib/config", () => ({ getAppTimeZone: () => "Asia/Taipei" }));
vi.mock("@/lib/learning-path/ai", () => ({
    suggestKnowledgeOrder: async (points: Array<{ knowledgePoint: string }>) => ({
        order: points.map((item) => item.knowledgePoint),
        usedAi: false,
    }),
}));

let directory: string;
let database: PrismaClient;

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "wrong-notebook-lp-test-"));
    const url = `file:${join(directory, "test.db")}`;
    execFileSync(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: "pipe",
    });
    database = new PrismaClient({ datasources: { db: { url } } });
    mocks.prisma = database;
}, 120000);

beforeEach(async () => {
    await database.learningPath.deleteMany();
    await database.knowledgeMastery.deleteMany();
    await database.knowledgeTag.deleteMany();
    await database.user.deleteMany();
    await database.user.create({ data: { id: "user-1", email: mocks.session.user.email, password: "test-only" } });
    await database.subject.createMany({ data: [
        { id: "nb-li", name: "李四·数学", stage: "junior_high", subjectKey: "math", userId: "user-1" },
        { id: "nb-self", name: "数学", stage: "junior_high", subjectKey: "math", userId: "user-1" },
    ] });
    await database.knowledgeTag.createMany({ data: [
        { id: "tag-arith", name: "整数运算", subject: "math", isSystem: true, order: 1 },
        { id: "tag-eq", name: "方程", subject: "math", isSystem: true, parentId: "tag-arith", order: 2 },
    ] });
    await database.errorItem.create({
        data: {
            id: "item-arith", shortId: "Ar0001", userId: "user-1", subjectId: "nb-li",
            questionText: "计算 12-5", answerText: "7", analysis: "退位减",
            errorType: "计算", knowledgePoints: '["整数运算"]', originalImageUrl: "",
            tags: { connect: [{ id: "tag-arith" }] },
        },
    });
    await database.errorItem.create({
        data: {
            id: "item-eq", shortId: "Eq0001", userId: "user-1", subjectId: "nb-li",
            questionText: "解方程 2x+1=7", answerText: "3", analysis: "移项",
            errorType: "概念", knowledgePoints: '["方程"]', originalImageUrl: "",
            tags: { connect: [{ id: "tag-eq" }] },
        },
    });
    await database.gradingClass.create({
        data: {
            id: "class-1", userId: "user-1", name: "初二1班",
            students: { create: [{ id: "stu-li", name: "李四", studentNo: "08", order: 1 }] },
        },
    });
});

afterAll(async () => {
    await database?.$disconnect();
    if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("学习路径接口（真实 SQLite）", () => {
    it("根据学生错题本生成带先修顺序的路径，并写入掌握快照", async () => {
        const response = await GET_PATH(new Request("http://localhost/api/learning-path?studentKey=stu-li&language=zh"));
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.studentName).toBe("李四");
        expect(data.steps.length).toBeGreaterThan(0);
        expect(data.steps.map((step: { type: string }) => step.type)).toEqual(expect.arrayContaining(["review_explanation", "variant_practice", "checkpoint"]));
        const firstExplain = data.steps.find((step: { type: string }) => step.type === "review_explanation");
        expect(firstExplain.knowledgePoints).toContain("整数运算");
        const mastery = await database.knowledgeMastery.findMany({ where: { userId: "user-1", studentKey: "stu-li" } });
        expect(mastery.length).toBeGreaterThan(0);
        expect(data.today.length).toBeGreaterThan(0);
    });

    it("证据未变化时不重排，新作答后自动重排且保留锁定步骤", async () => {
        const firstRes = await GET_PATH(new Request("http://localhost/api/learning-path?studentKey=stu-li&language=zh"));
        const first = await firstRes.json();
        const version = first.version;
        const explain = first.steps.find((step: { type: string }) => step.type === "review_explanation");
        const locked = await PATCH_STEP(
            new Request(`http://localhost/api/learning-path/steps/${explain.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "lock" }),
            }),
            { params: Promise.resolve({ id: explain.id }) },
        );
        expect(locked.status).toBe(200);

        const againRes = await GET_PATH(new Request("http://localhost/api/learning-path?studentKey=stu-li&language=zh"));
        const again = await againRes.json();
        expect(again.replanned).toBe(false);
        expect(again.version).toBe(version);

        await database.practiceRecord.create({
            data: { userId: "user-1", errorItemId: "item-eq", result: "wrong", isCorrect: false, source: "practice", originalImageUrl: "" },
        });
        const thirdRes = await GET_PATH(new Request("http://localhost/api/learning-path?studentKey=stu-li&language=zh"));
        const third = await thirdRes.json();
        expect(third.replanned).toBe(true);
        expect(third.version).toBeGreaterThan(version);
        const stillLocked = third.steps.find((step: { id: string }) => step.id === explain.id);
        expect(stillLocked?.locked).toBe(true);
    });

    it("可完成步骤，班级总览能看到该学生", async () => {
        const created = await GET_PATH(new Request("http://localhost/api/learning-path?studentKey=stu-li&language=zh"));
        const path = await created.json();
        const stepId = path.today[0].id;
        const completed = await PATCH_STEP(
            new Request(`http://localhost/api/learning-path/steps/${stepId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "complete" }),
            }),
            { params: Promise.resolve({ id: stepId }) },
        );
        expect(completed.status).toBe(200);
        const after = await completed.json();
        expect(after.steps.find((step: { id: string }) => step.id === stepId).status).toBe("completed");

        const classRes = await GET_CLASS(new Request("http://localhost/api/learning-path/class?classId=class-1&language=zh"));
        expect(classRes.status).toBe(200);
        const classData = await classRes.json();
        expect(classData.className).toBe("初二1班");
        expect(classData.students[0].name).toBe("李四");
        expect(classData.students[0].pathId).toBe(path.id);
    });

    it("本人路径与强制重排、顺序建议接口可用", async () => {
        await database.errorItem.create({
            data: {
                id: "item-self", shortId: "Sf0001", userId: "user-1", subjectId: "nb-self",
                questionText: "计算 3+5", answerText: "8", analysis: "加法",
                knowledgePoints: '["整数运算"]', originalImageUrl: "",
                tags: { connect: [{ id: "tag-arith" }] },
            },
        });
        const mine = await GET_PATH(new Request("http://localhost/api/learning-path?language=zh"));
        expect(mine.status).toBe(200);
        const data = await mine.json();
        expect(data.studentKey).toBe("self");
        expect(data.steps.length).toBeGreaterThan(0);

        const replanned = await POST_PATH(new Request("http://localhost/api/learning-path", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "replan", language: "zh" }),
        }));
        expect(replanned.status).toBe(200);
        expect((await replanned.json()).replanned).toBe(true);

        const suggested = await POST_PATH(new Request("http://localhost/api/learning-path", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "suggest-order", language: "zh" }),
        }));
        expect(suggested.status).toBe(200);
        const payload = await suggested.json();
        expect(payload.suggestion.usedAi).toBe(false);
    });
});
