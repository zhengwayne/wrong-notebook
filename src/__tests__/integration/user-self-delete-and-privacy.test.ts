// @vitest-environment node
/**
 * OPT-20 自助注销账户彻底清理（含无外键表、自引用标签树、TTS 磁盘缓存、匿名审计）与 AI 数据去向摘要集成测试（真实 SQLite）
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ADMIN_EMAIL } from "@/lib/default-admin";
import { flushBackgroundTasksToDb, listBackgroundTasks, resetBackgroundTasksForTest, startBackgroundTask } from "@/lib/background-tasks";
import { speechId } from "@/lib/tts/speech-cache";

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    sessionUser: { id: "user-del", email: "delete-me@example.com", role: "user", isActive: true, authVersion: 0 },
    config: {
        aiProvider: "openai",
        textSameAsVision: false,
        aiTextProvider: "deepseek",
        openai: {
            instances: [{ id: "inst-1", name: "Local Ollama", apiKey: "secret-key", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen" }],
            activeInstanceId: "inst-1",
        },
        deepseek: { apiKey: "ds-secret", baseUrl: "", model: "deepseek-v4-flash" },
        tts: { mode: "minimax" as const },
    } as Record<string, unknown>,
    infoLogs: [] as Array<{ payload: Record<string, unknown>; msg: string }>,
}));

vi.mock("@/lib/prisma", () => ({ get prisma() { return mocks.prisma; } }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("next-auth", () => ({
    getServerSession: vi.fn(async () => ({ user: mocks.sessionUser, expires: "2099-01-01" })),
}));
vi.mock("@/lib/config", () => ({
    getAppConfig: () => mocks.config,
    getAppTimeZone: () => "Asia/Shanghai",
    updateAppConfig: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
    createLogger: () => ({
        debug: vi.fn(),
        info: (payload: Record<string, unknown>, msg: string) => {
            mocks.infoLogs.push({ payload: payload ?? {}, msg });
        },
        warn: vi.fn(),
        error: vi.fn(),
    }),
}));

import { DELETE as DELETE_SELF } from "@/app/api/user/route";
import { GET as GET_SETTINGS } from "@/app/api/settings/route";
import { getStoredResponse, REQUEST_ID_HEADER, resetRecoverableResponsesForTest, withRecoverableResponse } from "@/lib/recoverable-response";
import { NextResponse } from "next/server";

let directory: string;
let db: PrismaClient;
let prevConfigDir: string | undefined;

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "user-self-delete-"));
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
    mocks.infoLogs.length = 0;
    resetBackgroundTasksForTest();
    resetRecoverableResponsesForTest();
    rmSync(process.env.CONFIG_DIR!, { recursive: true, force: true });

    await db.asyncOperation.deleteMany();
    await db.aiDailyQuota.deleteMany();
    await db.sourceImport.deleteMany();
    await db.learnerBackfillAudit.deleteMany();
    await db.learningPathStep.deleteMany();
    await db.learningPath.deleteMany();
    await db.itemMemory.deleteMany();
    await db.knowledgeMastery.deleteMany();
    await db.parentPaperQuestion.deleteMany();
    await db.parentPaperPage.deleteMany();
    await db.parentPaper.deleteMany();
    await db.gradingResult.deleteMany();
    await db.gradingSubmission.deleteMany();
    await db.gradingKeyQuestion.deleteMany();
    await db.gradingTask.deleteMany();
    await db.gradingStudent.deleteMany();
    await db.gradingClass.deleteMany();
    await db.variantStageLog.deleteMany();
    await db.variantItem.deleteMany();
    await db.variantRun.deleteMany();
    await db.practiceRecord.deleteMany();
    await db.reviewSchedule.deleteMany();
    await db.examQuestion.deleteMany();
    await db.examPaper.deleteMany();
    await db.errorItem.deleteMany();
    await db.learner.deleteMany();
    await db.subject.deleteMany();
    await db.aiUsage.deleteMany();
    await db.aiProvenance.deleteMany();
    await db.knowledgeTag.updateMany({ data: { parentId: null } });
    await db.knowledgeTag.deleteMany();
    await db.user.deleteMany();
});

describe("OPT-20 用户自助注销账户与数据去向告知", () => {
    it("输入错误密码拒绝注销；验证密码通过后彻底删除名下全部表记录、自定义标签树与独占语音缓存", async () => {
        const pwHash = await hash("my-secret-pass", 4);
        const target = await db.user.create({
            data: { id: "user-del", email: "delete-me@example.com", password: pwHash, name: "待注销同学", role: "user" },
        });
        const keeper = await db.user.create({
            data: { id: "user-keep", email: "keeper@example.com", password: pwHash, name: "保留用户", role: "user" },
        });
        mocks.sessionUser = { id: target.id, email: target.email, role: "user", isActive: true, authVersion: 0 };

        // 系统标签与共享 AiProvenance 必须保留
        await db.knowledgeTag.create({ data: { id: "sys-tag", name: "系统几何", subject: "math", isSystem: true } });
        const prov = await db.aiProvenance.create({
            data: { id: "prov-shared", task: "analyze", provider: "openai", model: "qwen", promptVersion: "p1", parserVersion: "v1" },
        });

        // 目标用户自引用自定义标签树 + 全链路业务数据
        const rootTag = await db.knowledgeTag.create({ data: { id: "tag-parent", name: "代数", subject: "math", isSystem: false, userId: target.id } });
        const childTag = await db.knowledgeTag.create({ data: { id: "tag-child", name: "方程", subject: "math", isSystem: false, userId: target.id, parentId: rootTag.id } });
        const sub = await db.subject.create({ data: { id: "sub-del", name: "数学", stage: "junior_high", userId: target.id } });
        const ln = await db.learner.create({ data: { id: "ln-del", userId: target.id, kind: "child", name: "小星" } });
        await db.learnerBackfillAudit.create({
            data: { id: "audit-del", batchId: "b1", userId: target.id, entityType: "learner", entityId: ln.id, action: "create" },
        });
        const item = await db.errorItem.create({
            data: {
                id: "ei-del",
                shortId: "DEL001",
                userId: target.id,
                subjectId: sub.id,
                learnerId: ln.id,
                provenanceId: prov.id,
                originalImageUrl: "data:image/png;base64,AA==",
                questionText: "解 x+1=2",
                tags: { connect: [{ id: childTag.id }] },
            },
        });
        await db.practiceRecord.create({
            data: { id: "pr-del", userId: target.id, learnerId: ln.id, errorItemId: item.id, result: "wrong" },
        });
        await db.itemMemory.create({
            data: { id: "im-del", userId: target.id, learnerId: ln.id, scopeKey: ln.id, errorItemId: item.id, dueAt: new Date() },
        });
        await db.aiDailyQuota.create({ data: { id: "adq-del", userId: target.id, dayKey: "2026-11-18", count: 2 } });

        // 保留用户的数据不得受任何牵连
        await db.subject.create({ data: { id: "sub-keep", name: "英语", stage: "junior_high", userId: keeper.id } });

        // 进程内存任务、断线恢复响应与磁盘 TTS 缓存（1 个独占 + 1 个共享）
        startBackgroundTask({ userId: target.id, kind: "analyze", subject: "敏感题干" });
        await flushBackgroundTasksToDb();

        const reqId = "abcdef0123456789abcdef0123456789";
        await withRecoverableResponse(async () => NextResponse.json({ secretQuestion: true }))(
            new Request("http://localhost/test", { headers: { [REQUEST_ID_HEADER]: reqId } }),
        );

        const ttsDir = join(process.env.CONFIG_DIR!, "tts-cache");
        mkdirSync(ttsDir, { recursive: true });
        const privateSpeechId = speechId({ provider: "minimax", model: "speech-2.8-hd", voice: "v1", language: "zh", text: "私有音频" });
        const sharedSpeechId = speechId({ provider: "minimax", model: "speech-2.8-hd", voice: "v1", language: "zh", text: "共享音频" });
        writeFileSync(join(ttsDir, `${privateSpeechId}.mp3`), "mp3-private");
        writeFileSync(
            join(ttsDir, `${privateSpeechId}.json`),
            JSON.stringify({ provider: "minimax", model: "speech-2.8-hd", voice: "v1", language: "zh", text: "私有音频", authorizedUserIds: [target.id] }),
        );
        writeFileSync(join(ttsDir, `${sharedSpeechId}.mp3`), "mp3-shared");
        writeFileSync(
            join(ttsDir, `${sharedSpeechId}.json`),
            JSON.stringify({ provider: "minimax", model: "speech-2.8-hd", voice: "v1", language: "zh", text: "共享音频", authorizedUserIds: [target.id, keeper.id] }),
        );

        // 1) 错误密码被拒绝
        const wrongRes = await DELETE_SELF(
            new Request("http://localhost/api/user", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password: "wrong-password" }),
            }),
        );
        expect(wrongRes.status).toBe(400);
        expect(await db.user.count({ where: { id: target.id } })).toBe(1);

        // 2) 正确密码永久注销
        const okRes = await DELETE_SELF(
            new Request("http://localhost/api/user", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password: "my-secret-pass" }),
            }),
        );
        expect(okRes.status).toBe(200);
        expect(await okRes.json()).toEqual({ success: true });

        // 校验目标用户在全部按 userId 分隔的 Prisma 模型下均为 0 条
        for (const model of Prisma.dmmf.datamodel.models) {
            if (!model.fields.some((f) => f.name === "userId")) continue;
            const delegateName = model.name[0].toLowerCase() + model.name.slice(1);
            const delegate = (db as unknown as Record<string, { count: (args: { where: { userId: string } }) => Promise<number> }>)[delegateName];
            expect(await delegate.count({ where: { userId: target.id } }), `${model.name} 应已清空目标用户记录`).toBe(0);
        }
        expect(await db.user.findUnique({ where: { id: target.id } })).toBeNull();

        // 其他用户、系统标签与共享 AiProvenance 完好
        expect(await db.user.count({ where: { id: keeper.id } })).toBe(1);
        expect(await db.subject.count({ where: { userId: keeper.id } })).toBe(1);
        expect(await db.knowledgeTag.count({ where: { isSystem: true } })).toBe(1);
        expect(await db.aiProvenance.count({ where: { id: prov.id } })).toBe(1);

        // 热缓存与独占语音缓存清除，共享语音缓存剥离目标用户后继续服务另一用户
        expect(listBackgroundTasks(target.id)).toEqual([]);
        expect(await getStoredResponse(reqId, target.id)).toBeNull();
        expect(existsSync(join(ttsDir, `${privateSpeechId}.mp3`))).toBe(false);
        expect(existsSync(join(ttsDir, `${privateSpeechId}.json`))).toBe(false);
        expect(existsSync(join(ttsDir, `${sharedSpeechId}.mp3`))).toBe(true);
        const sharedMeta = JSON.parse(readFileSync(join(ttsDir, `${sharedSpeechId}.json`), "utf8")) as { authorizedUserIds: string[] };
        expect(sharedMeta.authorizedUserIds).toEqual([keeper.id]);

        // 审计日志不含个人 PII（无 email / name / userId）
        const deletionLog = mocks.infoLogs.find((entry) => entry.payload.event === "user_account_deleted");
        expect(deletionLog).toBeDefined();
        const serializedLog = JSON.stringify(deletionLog);
        expect(serializedLog).not.toContain(target.id);
        expect(serializedLog).not.toContain(target.email);
        expect(serializedLog).not.toContain("待注销同学");
    });

    it("默认超管或最后一个活跃管理员不允许自删", async () => {
        const pwHash = await hash("admin-pass-123", 4);
        const soleAdmin = await db.user.create({
            data: { id: "sole-admin", email: "sole-admin@example.com", password: pwHash, role: "admin", isActive: true },
        });
        mocks.sessionUser = { id: soleAdmin.id, email: soleAdmin.email, role: "admin", isActive: true, authVersion: 0 };

        const soleRes = await DELETE_SELF(
            new Request("http://localhost/api/user", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password: "admin-pass-123" }),
            }),
        );
        expect(soleRes.status).toBe(400);
        expect(await db.user.count({ where: { id: soleAdmin.id } })).toBe(1);

        const defaultAdmin = await db.user.create({
            data: { id: "def-admin", email: DEFAULT_ADMIN_EMAIL, password: pwHash, role: "admin", isActive: true },
        });
        mocks.sessionUser = { id: defaultAdmin.id, email: defaultAdmin.email, role: "admin", isActive: true, authVersion: 0 };

        const defaultRes = await DELETE_SELF(
            new Request("http://localhost/api/user", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password: "admin-pass-123" }),
            }),
        );
        expect(defaultRes.status).toBe(400);
        expect(await db.user.count({ where: { id: defaultAdmin.id } })).toBe(1);
    });

    it("普通用户 GET /api/settings 返回脱敏数据去向摘要且不泄露私有 URL 或密钥", async () => {
        const regular = await db.user.create({
            data: { id: "u-flow", email: "flow@example.com", password: "h", role: "user" },
        });
        mocks.sessionUser = { id: regular.id, email: regular.email, role: "user", isActive: true, authVersion: 0 };

        const res = await GET_SETTINGS();
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.dataFlow).toEqual({
            vision: { provider: "openai", endpointType: "local" },
            textSameAsVision: false,
            text: { provider: "deepseek", endpointType: "official" },
            tts: { mode: "minimax", isCloud: true, endpointType: "official" },
        });
        expect(JSON.stringify(body)).not.toContain("127.0.0.1");
        expect(JSON.stringify(body)).not.toContain("secret-key");
        expect(JSON.stringify(body)).not.toContain("ds-secret");
    });
});
