// @vitest-environment node
/**
 * GET /api/error-items/list 全维度筛选参数真实 SQLite 集成测试
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createIsolatedTestDb, type IsolatedTestDb } from "../helpers/two-tenants";

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    sessionUser: {
        id: "user-1",
        email: "list@example.com",
        role: "user",
        isActive: true,
        authVersion: 0,
        masteryThreshold: 50,
    },
}));

vi.mock("@/lib/prisma", () => ({ get prisma() { return mocks.prisma; } }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("next-auth", () => ({
    getServerSession: vi.fn(async () => ({ user: mocks.sessionUser, expires: "2099-01-01" })),
}));
vi.mock("@/lib/config", () => ({ getAppTimeZone: () => "Asia/Shanghai" }));
vi.mock("@/lib/logger", () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET as LIST_ITEMS } from "@/app/api/error-items/list/route";

let testDb: IsolatedTestDb;
let db: PrismaClient;

beforeAll(() => {
    testDb = createIsolatedTestDb("error-list-filters-");
    db = testDb.db;
    mocks.prisma = db;
}, 120000);

afterAll(async () => {
    await testDb.cleanup();
});

beforeEach(async () => {
    await db.$executeRawUnsafe("PRAGMA foreign_keys = OFF;");
    await db.practiceRecord.deleteMany();
    await db.errorItem.deleteMany();
    await db.knowledgeTag.deleteMany();
    await db.learner.deleteMany();
    await db.subject.deleteMany();
    await db.user.deleteMany();
    await db.$executeRawUnsafe("PRAGMA foreign_keys = ON;");

    await db.user.createMany({
        data: [
            { id: "user-1", email: "list@example.com", password: "hash", role: "user", masteryThreshold: 50 },
            { id: "user-2", email: "other@example.com", password: "hash", role: "user", masteryThreshold: 50 },
        ],
    });
});

describe("GET /api/error-items/list 全参数筛选", () => {
    it("精确按 learnerId、subjectId、query/shortId、mastery、timeRange、chapter/tag、gradeSemester、paperLevel 与 view=print 筛选", async () => {
        const subjMath = await db.subject.create({ data: { id: "s-math", userId: "user-1", name: "数学" } });
        const subjPhy = await db.subject.create({ data: { id: "s-phy", userId: "user-1", name: "物理" } });
        const child = await db.learner.create({ data: { id: "c1", userId: "user-1", kind: "child", name: "大宝" } });
        await db.learner.create({ data: { id: "c-other", userId: "user-2", kind: "child", name: "他人孩子" } });

        // 创建章节树：章节「几何」 -> 子标签「勾股定理」、「全等三角形」
        const chapTag = await db.knowledgeTag.create({
            data: { id: "t-chap", name: "几何", subject: "math", isSystem: true },
        });
        const childTagA = await db.knowledgeTag.create({
            data: { id: "t-pyth", name: "勾股定理", subject: "math", isSystem: true, parentId: chapTag.id },
        });
        const childTagB = await db.knowledgeTag.create({
            data: { id: "t-cong", name: "全等三角形", subject: "math", isSystem: true, parentId: chapTag.id },
        });

        const now = Date.now();
        const item1 = await db.errorItem.create({
            data: {
                id: "e1",
                shortId: "ABCD12",
                userId: "user-1",
                subjectId: subjMath.id,
                learnerId: child.id,
                originalImageUrl: "data:image/png;base64,BIG_IMAGE_PAYLOAD",
                questionText: "直角三角形斜边计算",
                answerText: "5",
                analysis: "套用公式",
                gradeSemester: "初一，上",
                paperLevel: "A",
                createdAt: new Date(now - 2 * 86_400_000), // 本周内
                tags: { connect: [{ id: childTagA.id }] },
            },
        });
        // 已掌握 + 上个月题（用于验证 mastery 与 month 筛选及自定义前缀年级）
        const item2 = await db.errorItem.create({
            data: {
                id: "e2",
                shortId: "EFGH34",
                userId: "user-1",
                subjectId: subjPhy.id,
                learnerId: child.id,
                originalImageUrl: "data:image/png;base64,ANOTHER_IMG",
                questionText: "力学平衡受力分析",
                knowledgePoints: JSON.stringify(["全等三角形"]),
                gradeSemester: "一年级下",
                paperLevel: "B",
                masteryProbability: 0.9,
                createdAt: new Date(now - 20 * 86_400_000), // 本月内但超一周
                tags: { connect: [{ id: childTagB.id }] },
            },
        });
        await db.practiceRecord.create({
            data: { userId: "user-1", errorItemId: item2.id, result: "correct", isCorrect: true },
        });

        // 不属于当前用户的孩子 404
        const badLearnerRes = await LIST_ITEMS(new Request("http://localhost/api/error-items/list?learnerId=c-other"));
        expect(badLearnerRes.status).toBe(404);

        // 按 shortId 查询
        const shortRes = await (await LIST_ITEMS(new Request("http://localhost/api/error-items/list?query=ABCD12"))).json();
        expect(shortRes.items.map((i: { id: string }) => i.id)).toEqual([item1.id]);

        // 默认列表剥离原图；view=print 返回原图与解答
        expect(shortRes.items[0].originalImageUrl).toBeUndefined();
        const printRes = await (await LIST_ITEMS(new Request("http://localhost/api/error-items/list?view=print&query=ABCD12"))).json();
        expect(printRes.items[0].originalImageUrl).toContain("BIG_IMAGE_PAYLOAD");

        // mastery=new vs mastered
        const newRes = await (await LIST_ITEMS(new Request("http://localhost/api/error-items/list?mastery=new"))).json();
        expect(newRes.items.map((i: { id: string }) => i.id)).toEqual([item1.id]);
        const masteredRes = await (await LIST_ITEMS(new Request("http://localhost/api/error-items/list?mastery=mastered"))).json();
        expect(masteredRes.items.map((i: { id: string }) => i.id)).toEqual([item2.id]);

        // timeRange=week 与 month
        const weekRes = await (await LIST_ITEMS(new Request("http://localhost/api/error-items/list?timeRange=week"))).json();
        expect(weekRes.items.map((i: { id: string }) => i.id)).toEqual([item1.id]);
        const monthRes = await (await LIST_ITEMS(new Request("http://localhost/api/error-items/list?timeRange=month"))).json();
        expect(monthRes.total).toBe(2);

        // chapter 树递归查询 / 不存在 chapter 返回空 / chapter + tag 组合 / 仅 tag
        const chapRes = await (await LIST_ITEMS(new Request("http://localhost/api/error-items/list?chapter=几何"))).json();
        expect(chapRes.total).toBe(2);
        const missingChapRes = await (await LIST_ITEMS(new Request("http://localhost/api/error-items/list?chapter=不存在章节"))).json();
        expect(missingChapRes.total).toBe(0);
        const chapTagRes = await (await LIST_ITEMS(new Request("http://localhost/api/error-items/list?chapter=几何&tag=勾股定理"))).json();
        expect(chapTagRes.items.map((i: { id: string }) => i.id)).toEqual([item1.id]);
        await db.knowledgeTag.create({ data: { id: "t-other-chapter", name: "代数", subject: "math", isSystem: true } });
        const outside = await (await LIST_ITEMS(new Request("http://localhost/api/error-items/list?chapter=代数&tag=勾股定理"))).json();
        expect(outside.total).toBe(0);
        const invalidPage = await (await LIST_ITEMS(new Request("http://localhost/api/error-items/list?page=bad&pageSize=bad"))).json();
        expect(invalidPage).toMatchObject({ page: 1, total: 2 });
        const tagOnlyRes = await (await LIST_ITEMS(new Request("http://localhost/api/error-items/list?tag=全等三角形"))).json();
        expect(tagOnlyRes.items.map((i: { id: string }) => i.id)).toEqual([item2.id]);

        // gradeSemester 别名（七年级上 -> 命中 初一，上）、自定义前缀（一年级下）及非标准回退
        const gradeAliasRes = await (await LIST_ITEMS(new Request("http://localhost/api/error-items/list?gradeSemester=七年级上"))).json();
        expect(gradeAliasRes.items.map((i: { id: string }) => i.id)).toEqual([item1.id]);
        const customGradeRes = await (await LIST_ITEMS(new Request("http://localhost/api/error-items/list?gradeSemester=一年级下"))).json();
        expect(customGradeRes.items.map((i: { id: string }) => i.id)).toEqual([item2.id]);
        const fallbackGradeRes = await (await LIST_ITEMS(new Request("http://localhost/api/error-items/list?gradeSemester=CustomTerm"))).json();
        expect(fallbackGradeRes.total).toBe(0);

        // learnerId + subjectId + paperLevel
        const levelRes = await (await LIST_ITEMS(new Request("http://localhost/api/error-items/list?learnerId=c1&subjectId=s-math&paperLevel=A"))).json();
        expect(levelRes.items.map((i: { id: string }) => i.id)).toEqual([item1.id]);
    });
});
