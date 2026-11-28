// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    session: { user: { id: "u-1", email: "onboarding@example.com", role: "user" }, expires: "2099-01-01" },
}));

vi.mock("@/lib/prisma", () => ({ get prisma() { return mocks.prisma; } }));
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/logger", () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { GET, POST } from "@/app/api/onboarding/route";
import { getOnboardingStatus } from "@/lib/onboarding";

let directory: string;
let db: PrismaClient;

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "onboarding-"));
    const url = `file:${join(directory, "test.db")}`;
    execFileSync(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: "pipe",
    });
    db = new PrismaClient({ datasources: { db: { url } } });
    mocks.prisma = db;
}, 120000);

beforeEach(async () => {
    await db.practiceRecord.deleteMany();
    await db.parentPaperPage.deleteMany();
    await db.parentPaper.deleteMany();
    await db.gradingResult.deleteMany();
    await db.gradingSubmission.deleteMany();
    await db.gradingKeyQuestion.deleteMany();
    await db.gradingTask.deleteMany();
    await db.errorItem.deleteMany();
    await db.learner.deleteMany();
    await db.gradingStudent.deleteMany();
    await db.gradingClass.deleteMany();
    await db.subject.deleteMany();
    await db.user.deleteMany();
    await db.user.create({
        data: {
            id: "u-1",
            email: mocks.session.user.email,
            password: "test-only",
            personas: '["teacher","parent","self"]',
            activePersona: "teacher",
            personasConfirmedAt: new Date(),
        },
    });
    await db.subject.create({ data: { id: "nb-1", name: "数学", stage: "junior_high", subjectKey: "math", userId: "u-1" } });
});

afterAll(async () => {
    await db?.$disconnect();
    if (directory) rmSync(directory, { recursive: true, force: true });
});

async function item(id: string, learnerId: string | null = null) {
    return db.errorItem.create({
        data: { id, shortId: id.slice(0, 8), userId: "u-1", subjectId: "nb-1", learnerId, questionText: id, originalImageUrl: "" },
    });
}

describe("teacher onboarding", () => {
    it("ticks off steps from real data only", async () => {
        let status = await getOnboardingStatus(db, "u-1", "teacher");
        expect(status.steps.map((s) => s.done)).toEqual([false, false, false, false]);
        expect(status.current).toBe("class");

        // 空班级不算建好
        await db.gradingClass.create({ data: { id: "c-empty", userId: "u-1", name: "空班" } });
        status = await getOnboardingStatus(db, "u-1", "teacher");
        expect(status.steps[0].done).toBe(false);

        await db.gradingClass.create({
            data: { id: "c-1", userId: "u-1", name: "初二1班", students: { create: [{ id: "s-1", name: "张三", order: 1 }, { id: "s-2", name: "李四", order: 2 }] } },
        });
        status = await getOnboardingStatus(db, "u-1", "teacher");
        expect(status.steps[0]).toMatchObject({ done: true, meta: { classId: "c-1", className: "初二1班", students: 2 } });
        expect(status.current).toBe("task");

        // 没答案的普通任务不算
        await db.gradingTask.create({ data: { id: "t-draft", userId: "u-1", classId: "c-1", title: "草稿", subjectName: "数学" } });
        status = await getOnboardingStatus(db, "u-1", "teacher");
        expect(status.steps[1].done).toBe(false);

        await db.gradingTask.create({
            data: {
                id: "t-1", userId: "u-1", classId: "c-1", title: "期中", subjectName: "数学",
                questions: { create: [{ id: "q-1", order: 1, number: "1", maxScore: 5, answer: "A" }] },
            },
        });
        await db.gradingSubmission.create({ data: { id: "sub-1", taskId: "t-1", studentId: "s-1", images: "[]", status: "graded" } });
        status = await getOnboardingStatus(db, "u-1", "teacher");
        expect(status.steps[1]).toMatchObject({ done: true, meta: { taskId: "t-1", title: "期中" } });
        expect(status.steps[2]).toMatchObject({ done: true, meta: { count: 1, taskId: "t-1" } });
        expect(status.current).toBe("confirm");
        expect(status.completed).toBe(false);

        await db.gradingSubmission.update({ where: { id: "sub-1" }, data: { status: "confirmed", confirmedAt: new Date() } });
        status = await getOnboardingStatus(db, "u-1", "teacher");
        expect(status.completed).toBe(true);
        expect(status.visible).toBe(true);
        const saved = await db.user.findUniqueOrThrow({ where: { id: "u-1" } });
        expect(JSON.parse(saved.onboardingState).completedAt.teacher).toBe(status.completedAt);
    });
});

describe("parent and self onboarding", () => {
    it("keeps child and own items apart", async () => {
        await db.learner.create({ data: { id: "ln-kid", userId: "u-1", kind: "child", name: "小明" } });
        await db.learner.create({ data: { id: "ln-stu", userId: "u-1", kind: "student", name: "学生" } });
        await item("own-1");
        await item("stu-1", "ln-stu");

        let parent = await getOnboardingStatus(db, "u-1", "parent");
        expect(parent.steps.map((s) => s.done)).toEqual([true, false, false, false]);
        expect(parent.steps[0].meta).toMatchObject({ learnerId: "ln-kid", name: "小明" });

        await db.parentPaper.create({ data: { id: "pp-1", userId: "u-1", learnerId: "ln-kid", status: "pending_confirmation" } });
        parent = await getOnboardingStatus(db, "u-1", "parent");
        expect(parent.current).toBe("confirm");
        expect(parent.steps[2].meta).toMatchObject({ paperId: "pp-1" });

        await item("kid-1", "ln-kid");
        await db.practiceRecord.create({ data: { userId: "u-1", errorItemId: "kid-1", result: "correct", source: "manual" } });
        parent = await getOnboardingStatus(db, "u-1", "parent");
        expect(parent.completed).toBe(true);

        const self = await getOnboardingStatus(db, "u-1", "self");
        expect(self.steps.map((s) => s.done)).toEqual([true, false, false]);
        expect(self.steps[1].meta).toMatchObject({ count: 1, target: 5 });
    });

    it("needs 5 own items and a graded review for self", async () => {
        for (let i = 0; i < 5; i += 1) await item(`own-${i}`);
        await db.practiceRecord.create({ data: { userId: "u-1", errorItemId: "own-0", result: null, source: "practice" } });
        let self = await getOnboardingStatus(db, "u-1", "self");
        expect(self.steps.map((s) => s.done)).toEqual([true, true, false]);
        await db.practiceRecord.create({ data: { userId: "u-1", errorItemId: "own-1", result: "wrong", source: "manual" } });
        self = await getOnboardingStatus(db, "u-1", "self");
        expect(self.completed).toBe(true);
    });
});

describe("/api/onboarding", () => {
    it("defaults to the active persona and supports dismiss / reopen", async () => {
        let res = await GET(new Request("http://localhost/api/onboarding"));
        expect(res.status).toBe(200);
        let body = await res.json();
        expect(body.persona).toBe("teacher");
        expect(body.visible).toBe(true);

        res = await POST(new Request("http://localhost/api/onboarding", { method: "POST", body: JSON.stringify({ persona: "teacher", action: "dismiss" }) }));
        body = await res.json();
        expect(body.visible).toBe(false);
        expect(body.dismissedAt).toBeTruthy();

        res = await GET(new Request("http://localhost/api/onboarding?persona=parent"));
        body = await res.json();
        expect(body.persona).toBe("parent");
        expect(body.visible).toBe(true);

        res = await POST(new Request("http://localhost/api/onboarding", { method: "POST", body: JSON.stringify({ persona: "teacher", action: "reopen" }) }));
        body = await res.json();
        expect(body.visible).toBe(true);
        expect(body.dismissedAt).toBeNull();
    });

    it("rejects bad actions and falls back for unknown personas", async () => {
        const res = await POST(new Request("http://localhost/api/onboarding", { method: "POST", body: JSON.stringify({ persona: "teacher", action: "boom" }) }));
        expect(res.status).toBe(400);
        const fallback = await GET(new Request("http://localhost/api/onboarding?persona=admin"));
        expect(fallback.status).toBe(200);
        expect((await fallback.json()).persona).toBe("teacher");
    });
});
