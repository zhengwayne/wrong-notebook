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
import { getDueItems } from "@/lib/due-items";
import { collectEvidence } from "@/lib/learning-path/service";

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
let database: PrismaClient<{ log: [{ emit: "event"; level: "query" }] }>;
const capturedQueries: string[] = [];

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "wrong-notebook-lp-test-"));
    const url = `file:${join(directory, "test.db")}`;
    execFileSync(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: "pipe",
    });
    database = new PrismaClient({
        datasources: { db: { url } },
        log: [{ emit: "event", level: "query" }],
    });
    database.$on("query", (event) => {
        capturedQueries.push(event.query);
    });
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

    it("GET /api/learning-path 命中缓存时数据库零写入（R13），且 subjectId 过滤只作用于展示", async () => {
        await database.subject.create({
            data: { id: "nb-self-phys", name: "物理", stage: "junior_high", subjectKey: "physics", userId: "user-1" },
        });
        await database.knowledgeTag.create({
            data: { id: "tag-force", name: "力学", subject: "physics", isSystem: true, order: 1 },
        });
        await database.errorItem.createMany({
            data: [
                {
                    id: "item-self-math", shortId: "Sm0001", userId: "user-1", subjectId: "nb-self",
                    questionText: "数学算式", answerText: "2", analysis: "解析",
                    knowledgePoints: '["整数运算"]', originalImageUrl: "",
                },
                {
                    id: "item-self-phys", shortId: "Sp0001", userId: "user-1", subjectId: "nb-self-phys",
                    questionText: "物理受力", answerText: "5N", analysis: "解析",
                    knowledgePoints: '["力学"]', originalImageUrl: "",
                },
            ],
        });

        // 首次构建全科路径
        const initialRes = await GET_PATH(new Request("http://localhost/api/learning-path?language=zh"));
        expect(initialRes.status).toBe(200);
        const initialPath = await initialRes.json();
        const storedRowBefore = await database.learningPath.findUniqueOrThrow({ where: { id: initialPath.id } });

        // 清空记录后再次 GET 命中缓存：断言零 INSERT / UPDATE / DELETE / BEGIN / COMMIT
        capturedQueries.length = 0;
        const cachedRes = await GET_PATH(new Request("http://localhost/api/learning-path?language=zh"));
        expect(cachedRes.status).toBe(200);
        const cachedData = await cachedRes.json();
        expect(cachedData.replanned).toBe(false);
        const writeQueries = capturedQueries.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q));
        expect(writeQueries).toEqual([]);

        // 带 subjectId 过滤查询：只展示物理科目内容，但数据库中全科路径版本与 hash 原封不动
        capturedQueries.length = 0;
        const physRes = await GET_PATH(new Request("http://localhost/api/learning-path?subjectId=nb-self-phys&language=zh"));
        expect(physRes.status).toBe(200);
        const physData = await physRes.json();
        expect(physData.mastery.map((m: { knowledgePoint: string }) => m.knowledgePoint)).toEqual(["力学"]);
        expect(capturedQueries.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q))).toEqual([]);

        const storedRowAfter = await database.learningPath.findUniqueOrThrow({ where: { id: initialPath.id } });
        expect(storedRowAfter.version).toBe(storedRowBefore.version);
        expect(storedRowAfter.evidenceHash).toBe(storedRowBefore.evidenceHash);
    });

    it("listClassPaths 在 30 名学生下批量加载证据，SQL 查询数大幅下降且缓存态零写入", async () => {
        const cls30 = await database.gradingClass.create({
            data: { id: "class-30", userId: "user-1", name: "初三3班" },
        });
        for (let i = 1; i <= 30; i++) {
            const name = `学生${String(i).padStart(2, "0")}`;
            const nbId = `nb-c30-${i}`;
            await database.subject.create({
                data: { id: nbId, name: `${name}·数学`, stage: "junior_high", subjectKey: "math", userId: "user-1" },
            });
            await database.gradingStudent.create({
                data: { id: `stu-c30-${i}`, classId: cls30.id, name, studentNo: String(i), order: i },
            });
            await database.errorItem.create({
                data: {
                    id: `item-c30-${i}`, shortId: `C3${String(i).padStart(4, "0")}`, userId: "user-1", subjectId: nbId,
                    questionText: `第${i}题`, answerText: "1", knowledgePoints: '["方程"]', originalImageUrl: "",
                },
            });
        }

        // 首次物化 30 人（单事务批量写入，读查询已合并）
        capturedQueries.length = 0;
        const firstRes = await GET_CLASS(new Request("http://localhost/api/learning-path/class?classId=class-30&language=zh"));
        expect(firstRes.status).toBe(200);
        const firstData = await firstRes.json();
        expect(firstData.students).toHaveLength(30);
        // 首次 30 名学生物化路径（含路径与步骤写入），总 SQL 仍明显低于逐学生 N+1 查询（>300 次）
        expect(capturedQueries.length).toBeLessThan(200);

        // 二次访问（命中缓存）：SQL 查询应降至常数级 <= 15 次且零写入
        capturedQueries.length = 0;
        const secondRes = await GET_CLASS(new Request("http://localhost/api/learning-path/class?classId=class-30&language=zh"));
        expect(secondRes.status).toBe(200);
        const secondData = await secondRes.json();
        expect(secondData.students).toHaveLength(30);
        expect(capturedQueries.length).toBeLessThanOrEqual(15);
        expect(capturedQueries.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q))).toEqual([]);
    }, 30000);

    it("ebbinghaus-v1 与 fsrs-v1 两种 algorithmVersion 下，学习路径 dueItemIds 与统一 getDueItems 结果完全一致且切换版本会触发重排", async () => {
        const oldDue = new Date("2026-01-01T08:00:00+08:00");
        await database.errorItem.create({
            data: {
                id: "sync-item-1", shortId: "SY0001", userId: "user-1", subjectId: "nb-self",
                questionText: "一元一次方程", answerText: "2", knowledgePoints: '["方程"]', originalImageUrl: "",
                createdAt: oldDue,
            },
        });
        await database.errorItem.create({
            data: {
                id: "sync-item-2", shortId: "SY0002", userId: "user-1", subjectId: "nb-self",
                questionText: "近期已练题", answerText: "5", knowledgePoints: '["方程"]', originalImageUrl: "",
                createdAt: oldDue,
            },
        });
        await database.practiceRecord.create({
            data: {
                userId: "user-1",
                errorItemId: "sync-item-2",
                result: "correct",
                isCorrect: true,
                source: "review",
                createdAt: new Date(),
            },
        });

        for (const version of ["ebbinghaus-v1", "fsrs-v1"] as const) {
            await database.user.update({ where: { id: "user-1" }, data: { reviewAlgorithmVersion: version } });
            const unified = await getDueItems(database, { userId: "user-1", learnerId: null }, {
                timeZone: "Asia/Taipei",
                subjectIds: ["nb-self"],
            });
            const collected = await collectEvidence("user-1", {
                studentKey: "self",
                studentName: "我",
                classId: null,
                subjectIds: ["nb-self"],
                kind: "self",
                learnerId: null,
            });
            expect(unified.algorithmVersion).toBe(version);
            expect([...collected.dueItemIds].sort()).toEqual(unified.items.map((item) => item.id).sort());
            expect(unified.items.map((item) => item.id)).toEqual(["sync-item-1"]);
        }

        // 先在 ebbinghaus-v1 生成路径，再切换 fsrs-v1，应识别哈希变化并重排版本 +1
        await database.user.update({ where: { id: "user-1" }, data: { reviewAlgorithmVersion: "ebbinghaus-v1" } });
        const ebRes = await GET_PATH(new Request("http://localhost/api/learning-path?language=zh"));
        expect(ebRes.status).toBe(200);
        const ebData = await ebRes.json();
        await database.user.update({ where: { id: "user-1" }, data: { reviewAlgorithmVersion: "fsrs-v1" } });
        const fsrsRes = await GET_PATH(new Request("http://localhost/api/learning-path?language=zh"));
        expect(fsrsRes.status).toBe(200);
        const fsrsData = await fsrsRes.json();

        expect(fsrsData.version).toBe(ebData.version + 1);
    });
});
