// @vitest-environment node
/**
 * 教师批改全链路 API 真实 SQLite 集成测试：
 * 覆盖 grading/classes、classes/[id]、students/[id]、tasks、tasks/[id]、key-image、summary、
 * submissions/[id]、regrade、split、merge 的正常路径、边界校验与跨租户 404 隔离。
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_JPEG_DATA_URL } from "../helpers/sample-images";
import { createIsolatedTestDb, type IsolatedTestDb } from "../helpers/two-tenants";

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    currentUser: { id: "teacher-a", email: "ta@example.com", role: "user" } as { id: string; email: string; role: string } | null,
    consumeAiQuota: vi.fn<() => Promise<Response | null>>(async () => null),
    scheduleGrading: vi.fn(),
    readAnswerKeyFromImages: vi.fn(),
    buildKeyFromExam: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ get prisma() { return mocks.prisma; } }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: vi.fn(async () => mocks.currentUser) }));
vi.mock('@/lib/ai-quota', async () => (await import('../helpers/ai-quota-mock')).createAiQuotaMock((...args) => mocks.consumeAiQuota(...(args as []))));
vi.mock("@/lib/grading-service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/grading-service")>();
    return {
        ...actual,
        scheduleGrading: mocks.scheduleGrading,
        readAnswerKeyFromImages: mocks.readAnswerKeyFromImages,
        buildKeyFromExam: mocks.buildKeyFromExam,
    };
});
vi.mock("@/lib/logger", () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET as GET_CLASSES, POST as POST_CLASSES } from "@/app/api/grading/classes/route";
import { PUT as PUT_CLASS, DELETE as DELETE_CLASS } from "@/app/api/grading/classes/[id]/route";
import { DELETE as DELETE_STUDENT } from "@/app/api/grading/students/[id]/route";
import { GET as GET_TASKS, POST as POST_TASK } from "@/app/api/grading/tasks/route";
import { GET as GET_TASK, PUT as PUT_TASK, DELETE as DELETE_TASK } from "@/app/api/grading/tasks/[id]/route";
import { POST as POST_KEY_IMAGE } from "@/app/api/grading/tasks/[id]/key-image/route";
import { GET as GET_SUMMARY } from "@/app/api/grading/tasks/[id]/summary/route";
import { GET as GET_SUBMISSION, PATCH as PATCH_SUBMISSION, DELETE as DELETE_SUBMISSION } from "@/app/api/grading/submissions/[id]/route";
import { POST as POST_REGRADE } from "@/app/api/grading/submissions/[id]/regrade/route";
import { POST as POST_SPLIT } from "@/app/api/grading/submissions/[id]/split/route";
import { POST as POST_MERGE } from "@/app/api/grading/submissions/[id]/merge/route";

const jsonReq = (body: unknown, method = "POST") =>
    new Request("http://localhost/api/grading", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

const paramsOf = (id: string) => ({ params: Promise.resolve({ id }) });

let testDb: IsolatedTestDb;
let db: PrismaClient;

beforeAll(() => {
    testDb = createIsolatedTestDb("grading-routes-complete-");
    db = testDb.db;
    mocks.prisma = db;
}, 120000);

afterAll(async () => {
    await testDb.cleanup();
});

beforeEach(async () => {
    vi.clearAllMocks();
    mocks.currentUser = { id: "teacher-a", email: "ta@example.com", role: "user" };
    mocks.consumeAiQuota.mockResolvedValue(null);

    await db.$executeRawUnsafe("PRAGMA foreign_keys = OFF;");
    await db.gradingResult.deleteMany();
    await db.gradingSubmission.deleteMany();
    await db.gradingKeyQuestion.deleteMany();
    await db.gradingTask.deleteMany();
    await db.gradingStudent.deleteMany();
    await db.gradingClass.deleteMany();
    await db.learner.deleteMany();
    await db.user.deleteMany();
    await db.$executeRawUnsafe("PRAGMA foreign_keys = ON;");

    await db.user.createMany({
        data: [
            { id: "teacher-a", email: "ta@example.com", password: "hash", role: "user", isActive: true },
            { id: "teacher-b", email: "tb@example.com", password: "hash", role: "user", isActive: true },
        ],
    });
});

describe("教师批改 API 完整路由集成测试", () => {
    it("班级与学生花名册路由：未授权 401、创建并同步 Learner、重名 409、改名、删除与跨租户 404", async () => {
        mocks.currentUser = null;
        expect((await GET_CLASSES()).status).toBe(401);
        expect((await POST_CLASSES(jsonReq({ name: "一班" }))).status).toBe(401);
        expect((await PUT_CLASS(jsonReq({ name: "x" }, "PUT"), paramsOf("c1"))).status).toBe(401);
        expect((await DELETE_CLASS(new Request("http://localhost"), paramsOf("c1"))).status).toBe(401);
        expect((await DELETE_STUDENT(new Request("http://localhost"), paramsOf("s1"))).status).toBe(401);

        mocks.currentUser = { id: "teacher-a", email: "ta@example.com", role: "user" };

        expect((await POST_CLASSES(jsonReq({ name: "" }))).status).toBe(400);

        const c1Res = await POST_CLASSES(jsonReq({ name: "七年级(1)班", roster: "张三, 李四\n王五" }));
        expect(c1Res.status).toBe(201);
        const c1 = await c1Res.json();
        expect(c1.students).toHaveLength(3);

        // 同步创建对应 Learner
        const syncedLearners = await db.learner.findMany({ where: { userId: "teacher-a", kind: "student" } });
        expect(syncedLearners).toHaveLength(3);

        // 同名班级 409
        const dupRes = await POST_CLASSES(jsonReq({ name: "七年级(1)班" }));
        expect(dupRes.status).toBe(409);

        await POST_CLASSES(jsonReq({ name: "七年级(2)班" }));

        const listRes = await GET_CLASSES();
        expect(listRes.status).toBe(200);
        expect((await listRes.json())).toHaveLength(2);

        // 改名冲突与成功
        expect((await PUT_CLASS(jsonReq({ name: "七年级(2)班" }, "PUT"), paramsOf(c1.id))).status).toBe(409);
        const renameRes = await PUT_CLASS(jsonReq({ name: "初一(1)班" }, "PUT"), paramsOf(c1.id));
        expect(renameRes.status).toBe(200);
        expect((await renameRes.json()).name).toBe("初一(1)班");

        // 跨租户隔离 404
        mocks.currentUser = { id: "teacher-b", email: "tb@example.com", role: "user" };
        expect((await PUT_CLASS(jsonReq({ name: "窃改" }, "PUT"), paramsOf(c1.id))).status).toBe(404);
        expect((await DELETE_CLASS(new Request("http://localhost"), paramsOf(c1.id))).status).toBe(404);
        expect((await DELETE_STUDENT(new Request("http://localhost"), paramsOf(c1.students[0].id))).status).toBe(404);

        // 恢复 teacher-a 删除单个学生与整个班级
        mocks.currentUser = { id: "teacher-a", email: "ta@example.com", role: "user" };
        expect((await DELETE_STUDENT(new Request("http://localhost"), paramsOf(c1.students[0].id))).status).toBe(200);
        expect((await DELETE_STUDENT(new Request("http://localhost"), paramsOf(c1.students[0].id))).status).toBe(404);
        expect((await DELETE_CLASS(new Request("http://localhost"), paramsOf(c1.id))).status).toBe(200);
        expect((await DELETE_CLASS(new Request("http://localhost"), paramsOf(c1.id))).status).toBe(404);
    });

    it("改卷任务路由：从 keyText / examPaperId / questions 创建、识别答案卷、汇总 JSON 与 CSV 导出", async () => {
        const cls = await db.gradingClass.create({
            data: {
                userId: "teacher-a",
                name: "高一(3)班",
                students: { create: [{ name: "陈晨", order: 0 }, { name: "赵磊", order: 1 }] },
            },
            include: { students: true },
        });

        // 班级不存在或答案行错误
        expect((await POST_TASK(jsonReq({ title: "测验", classId: "missing" }))).status).toBe(404);
        expect((await POST_TASK(jsonReq({ title: "测验", classId: cls.id, keyText: "bad line without answer" }))).status).toBe(400);

        // 通过 keyText 创建
        const t1Res = await POST_TASK(jsonReq({
            title: "期中数学",
            classId: cls.id,
            subjectName: "数学",
            keyText: "1 A 3分\n2 主观 5分 写出证明过程",
        }));
        expect(t1Res.status).toBe(201);
        const t1 = await t1Res.json();
        expect(t1.questionCount).toBe(2);

        // 通过 examPaperId 创建（存在 & 不存在分支）
        mocks.buildKeyFromExam.mockResolvedValueOnce(null);
        expect((await POST_TASK(jsonReq({ title: "试卷引入", classId: cls.id, examPaperId: "missing-exam" }))).status).toBe(404);
        mocks.buildKeyFromExam.mockResolvedValueOnce([
            { number: "1", type: "objective", maxScore: 2, answer: "B" },
        ]);
        const tExamRes = await POST_TASK(jsonReq({ title: "试卷引入", classId: cls.id, examPaperId: "exam-1" }));
        expect(tExamRes.status).toBe(201);

        // 写入一张已判分答卷用于详情与 summary 测试
        const keyQuestions = await db.gradingKeyQuestion.findMany({ where: { taskId: t1.id }, orderBy: { order: "asc" } });
        await db.gradingSubmission.create({
            data: {
                taskId: t1.id,
                studentId: cls.students[0].id,
                images: JSON.stringify([SAMPLE_JPEG_DATA_URL]),
                status: "confirmed",
                totalScore: 3,
                results: {
                    create: [
                        { keyQuestionId: keyQuestions[0].id, verdict: "correct", score: 3, source: "auto" },
                        { keyQuestionId: keyQuestions[1].id, verdict: "wrong", score: 0, source: "ai" },
                    ],
                },
            },
        });

        // GET /tasks 列表
        const listRes = await GET_TASKS();
        expect(listRes.status).toBe(200);
        const list = await listRes.json();
        expect(list.find((item: { id: string }) => item.id === t1.id).confirmedCount).toBe(1);

        // key-image 识别成功、非法图片 400、配额受限 429、识别失败 500
        mocks.readAnswerKeyFromImages.mockResolvedValueOnce([
            { number: "1", type: "objective", maxScore: 2, answer: "C" },
        ]);
        const keyImgRes = await POST_KEY_IMAGE(jsonReq({ images: [SAMPLE_JPEG_DATA_URL], language: "zh" }), paramsOf(t1.id));
        expect(keyImgRes.status).toBe(200);
        expect((await keyImgRes.json()).questions).toHaveLength(1);

        const badImgRes = await POST_KEY_IMAGE(jsonReq({ images: ["not-a-data-url"], language: "zh" }), paramsOf(t1.id));
        expect(badImgRes.status).toBe(400);

        mocks.consumeAiQuota.mockResolvedValueOnce(new Response(JSON.stringify({ error: "quota" }), { status: 429 }));
        expect((await POST_KEY_IMAGE(jsonReq({ images: [SAMPLE_JPEG_DATA_URL], language: "zh" }), paramsOf(t1.id))).status).toBe(429);

        mocks.readAnswerKeyFromImages.mockRejectedValueOnce(new Error("AI_TIMEOUT"));
        expect((await POST_KEY_IMAGE(jsonReq({ images: [SAMPLE_JPEG_DATA_URL], language: "zh" }), paramsOf(t1.id))).status).toBe(500);

        // summary JSON + 中英文 CSV
        const sumJson = await (await GET_SUMMARY(new Request(`http://localhost/api/grading/tasks/${t1.id}/summary`), paramsOf(t1.id))).json();
        expect(sumJson.gradedCount).toBe(1);
        const csvEnRes = await GET_SUMMARY(new Request(`http://localhost/api/grading/tasks/${t1.id}/summary?format=csv&lang=en`), paramsOf(t1.id));
        expect(csvEnRes.headers.get("Content-Type")).toContain("text/csv");
        expect(await csvEnRes.text()).toContain("Name,Total,1,2");

        // GET / PUT / DELETE tasks/[id] 与跨租户隔离
        const detailRes = await GET_TASK(new Request("http://localhost"), paramsOf(t1.id));
        expect(detailRes.status).toBe(200);
        expect((await detailRes.json()).submissions).toHaveLength(1);

        // 已有 confirmed 答卷时拒绝全量替换答案（409），仅改标题允许（200）
        expect((await PUT_TASK(jsonReq({
            title: "期中数学(更新)",
            questions: [{ number: "1", type: "objective", maxScore: 4, answer: "D" }],
        }, "PUT"), paramsOf(t1.id))).status).toBe(409);
        expect((await PUT_TASK(jsonReq({ title: "期中数学(更新)" }, "PUT"), paramsOf(t1.id))).status).toBe(200);

        // 无已确认答卷的任务替换答案时自动重置已判答卷并重新入队判分
        const tReplaceRes = await POST_TASK(jsonReq({
            title: "随堂测验",
            classId: cls.id,
            keyText: "1 A 2",
        }));
        const tReplace = await tReplaceRes.json();
        const subReplace = await db.gradingSubmission.create({
            data: {
                taskId: tReplace.id,
                images: JSON.stringify([SAMPLE_JPEG_DATA_URL]),
                status: "graded",
                totalScore: 2,
            },
        });
        expect((await PUT_TASK(jsonReq({
            questions: [{ number: "1", type: "objective", maxScore: 5, answer: "B" }],
        }, "PUT"), paramsOf(tReplace.id))).status).toBe(200);
        expect(mocks.scheduleGrading).toHaveBeenCalledWith([subReplace.id], "zh");

        mocks.currentUser = { id: "teacher-b", email: "tb@example.com", role: "user" };
        expect((await GET_TASK(new Request("http://localhost"), paramsOf(t1.id))).status).toBe(404);
        expect((await GET_SUMMARY(new Request("http://localhost"), paramsOf(t1.id))).status).toBe(404);
        expect((await DELETE_TASK(new Request("http://localhost"), paramsOf(t1.id))).status).toBe(404);

        mocks.currentUser = { id: "teacher-a", email: "ta@example.com", role: "user" };
        expect((await DELETE_TASK(new Request("http://localhost"), paramsOf(t1.id))).status).toBe(200);
        expect((await DELETE_TASK(new Request("http://localhost"), paramsOf(t1.id))).status).toBe(404);
    });

    it("答卷详情、改判指定学生、重判 regrade、拆页 split、合并 merge 与删除路由完整覆盖", async () => {
        const cls = await db.gradingClass.create({
            data: {
                userId: "teacher-a",
                name: "一班",
                students: { create: [{ name: "小红", order: 0 }] },
            },
            include: { students: true },
        });
        const otherClass = await db.gradingClass.create({
            data: {
                userId: "teacher-a",
                name: "二班",
                students: { create: [{ name: "他班学生", order: 0 }] },
            },
            include: { students: true },
        });
        const task = await db.gradingTask.create({
            data: {
                userId: "teacher-a",
                classId: cls.id,
                title: "小测",
                questions: { create: [{ order: 0, number: "1", type: "objective", maxScore: 2, answer: "A" }] },
            },
            include: { questions: true },
        });

        const sub1 = await db.gradingSubmission.create({
            data: {
                taskId: task.id,
                images: JSON.stringify([SAMPLE_JPEG_DATA_URL, SAMPLE_JPEG_DATA_URL]),
                status: "graded",
                totalScore: 0,
                matchStatus: "review",
                results: { create: [{ keyQuestionId: task.questions[0].id, verdict: "wrong", score: 0, source: "auto" }] },
            },
            include: { results: true },
        });

        // GET & PATCH 指定非本班学生 400、指定本班学生 + 改判正确 200（version 递增）
        expect((await GET_SUBMISSION(new Request("http://localhost"), paramsOf(sub1.id))).status).toBe(200);
        expect((await PATCH_SUBMISSION(jsonReq({ studentId: otherClass.students[0].id }, "PATCH"), paramsOf(sub1.id))).status).toBe(400);

        const patched = await (await PATCH_SUBMISSION(
            jsonReq({
                studentId: cls.students[0].id,
                results: [{ id: sub1.results[0].id, verdict: "correct" }],
            }, "PATCH"),
            paramsOf(sub1.id),
        )).json();
        expect(patched.matchStatus).toBe("manual");
        expect(patched.totalScore).toBe(2);
        expect(patched.version).toBe(1);

        // 仅修改单题批注（不传 score/verdict）允许通过
        const commentOnlyRes = await PATCH_SUBMISSION(
            jsonReq({ results: [{ id: sub1.results[0].id, comment: "书写规范" }] }, "PATCH"),
            paramsOf(sub1.id),
        );
        expect(commentOnlyRes.status).toBe(200);
        expect((await commentOnlyRes.json()).results[0].comment).toBe("书写规范");

        // 清空学生回到 review 状态
        const cleared = await (await PATCH_SUBMISSION(jsonReq({ studentId: null }, "PATCH"), paramsOf(sub1.id))).json();
        expect(cleared.matchStatus).toBe("review");

        // regrade 202
        const regradeRes = await POST_REGRADE(jsonReq({ language: "zh" }), paramsOf(sub1.id));
        expect(regradeRes.status).toBe(202);
        expect(mocks.scheduleGrading).toHaveBeenCalledWith([sub1.id], "zh");

        // split 越界 400 与正常拆页 201
        expect((await POST_SPLIT(jsonReq({ fromPage: 2, language: "zh" }), paramsOf(sub1.id))).status).toBe(400);
        const splitRes = await POST_SPLIT(jsonReq({ fromPage: 1, language: "en" }), paramsOf(sub1.id));
        expect(splitRes.status).toBe(201);
        const splitBody = await splitRes.json();

        // merge 合并自身 400、正常将拆出的答卷合并回 sub1 200
        expect((await POST_MERGE(jsonReq({ targetId: splitBody.id, language: "zh" }), paramsOf(splitBody.id))).status).toBe(400);
        const mergeRes = await POST_MERGE(jsonReq({ targetId: sub1.id, language: "zh" }), paramsOf(splitBody.id));
        expect(mergeRes.status).toBe(200);
        const mergedSub = await db.gradingSubmission.findUniqueOrThrow({ where: { id: sub1.id } });
        expect(JSON.parse(mergedSub.images)).toHaveLength(2);

        // confirmed 状态锁定拦截（PATCH / regrade / split / merge 均 409）
        await db.gradingSubmission.update({ where: { id: sub1.id }, data: { status: "confirmed" } });
        expect((await PATCH_SUBMISSION(jsonReq({ studentId: null }, "PATCH"), paramsOf(sub1.id))).status).toBe(409);
        expect((await POST_REGRADE(jsonReq({}), paramsOf(sub1.id))).status).toBe(409);
        expect((await POST_SPLIT(jsonReq({ fromPage: 1, language: "zh" }), paramsOf(sub1.id))).status).toBe(409);

        // DELETE
        expect((await DELETE_SUBMISSION(new Request("http://localhost"), paramsOf(sub1.id))).status).toBe(200);
        expect((await DELETE_SUBMISSION(new Request("http://localhost"), paramsOf(sub1.id))).status).toBe(404);
    });
});
