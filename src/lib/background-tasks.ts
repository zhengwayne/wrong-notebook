/**
 * 后台耗时事务登记：识别题目、生成动画讲解、重新解题、批量标注、生成试卷等调用 AI 的操作
 * 开始时登记，结束时标记成功或失败，供页面「后台任务」弹框查询进度。
 *
 * 登记状态保存在内存热缓存并持久化至 SQLite `AsyncOperation` 表（淘汰历史 background-tasks.json）：
 * 服务重启后由 instrumentation 调用 `recoverInterruptedAsyncOperations` 将运行中任务置为 `interrupted`，
 * 本模块在读取时映射为前端可理解的 `status = 'failed', error = 'SERVER_RESTARTED'`。
 */
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { createLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const logger = createLogger("background-tasks");

export type BackgroundTaskKind =
    | "analyze"          // 识别题目图片
    | "batch_upload"     // Openclaw 批量上传识别
    | "data_import"      // 导入备份数据
    | "svg_animation"    // 生成 SVG 动画讲解
    | "svg_narration"    // 补写动画的语音讲解稿
    | "tts_voice"        // 合成动画讲解的云端语音
    | "reanswer"         // 重新生成解答
    | "fix_latex"        // 修复 LaTeX
    | "figure"           // 重绘配图
    | "geogebra"         // 生成 GeoGebra 演示
    | "retag"            // 重新生成知识点（单题）
    | "retag_notebook"   // 错题本批量重新生成知识点
    | "practice"         // 生成举一反三题目
    | "exam"             // 生成试卷
    | "parent_paper";    // 家长试卷识别批改

export type BackgroundTaskStatus = "running" | "succeeded" | "failed";

export interface BackgroundTask {
    id: string;
    kind: BackgroundTaskKind;
    /** 操作对象的说明，如题目编号和题干开头、错题本名、试卷标题 */
    subject: string | null;
    status: BackgroundTaskStatus;
    /** 批量事务的进度 */
    progress: { done: number; total: number; failed: number } | null;
    error: string | null;
    /** 可跳转查看的页面 */
    link: string | null;
    startedAt: string;
    finishedAt: string | null;
}

interface StoredTask extends BackgroundTask {
    userId: string;
}

export interface BackgroundTaskInput {
    userId: string;
    kind: BackgroundTaskKind;
    subject?: string | null;
    link?: string | null;
    total?: number;
}

export interface BackgroundTaskHandle {
    id: string;
    setProgress: (done: number, total?: number, failed?: number) => void;
    succeed: () => void;
    fail: (error: unknown) => void;
}

/** 已结束的事务保留时长 */
export const FINISHED_TASK_TTL_MS = 30 * 60 * 1000;
/** 每个用户最多保留的已结束事务数 */
const MAX_FINISHED_PER_USER = 30;
/** 服务重启时仍在进行的事务记录的错误码 */
export const SERVER_RESTARTED = "SERVER_RESTARTED";

const TASK_CATEGORY = "task";

const store = globalThis as typeof globalThis & {
    __backgroundTasks?: Map<string, StoredTask>;
    __backgroundTasksDbChain?: Promise<void>;
    __backgroundTasksGeneration?: number;
};
const tasks: Map<string, StoredTask> = store.__backgroundTasks ??= new Map();

let sequence = 0;

function getAsyncOpRepo(): PrismaClient["asyncOperation"] | null {
    try {
        const db = prisma as unknown as { asyncOperation?: PrismaClient["asyncOperation"] };
        if (db?.asyncOperation && typeof db.asyncOperation.findMany === "function" && typeof db.asyncOperation.upsert === "function") {
            return db.asyncOperation;
        }
    } catch {
        // 局部 mock Prisma 的单元测试安全回退纯内存模式
    }
    return null;
}

function enqueueDbSync(work: (repo: PrismaClient["asyncOperation"]) => Promise<void>): void {
    const repo = getAsyncOpRepo();
    if (!repo) return;
    const generation = store.__backgroundTasksGeneration ?? 0;
    const prev = store.__backgroundTasksDbChain ?? Promise.resolve();
    store.__backgroundTasksDbChain = prev
        .then(async () => {
            if ((store.__backgroundTasksGeneration ?? 0) !== generation) return;
            const currentRepo = getAsyncOpRepo();
            if (!currentRepo) return;
            await work(currentRepo);
        })
        .catch((error) => {
            logger.warn({ error }, "Failed to persist background task state");
        });
}

/** 等待当前挂起的后台任务数据库同步写入全部完成 */
export async function flushBackgroundTasksToDb(): Promise<void> {
    if (store.__backgroundTasksDbChain) {
        await store.__backgroundTasksDbChain;
    }
}

function prune(now: number) {
    for (const [id, task] of tasks) {
        if (task.finishedAt && now - Date.parse(task.finishedAt) > FINISHED_TASK_TTL_MS) {
            tasks.delete(id);
        }
    }
}

function errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    // AI 错误码形如 AI_RESPONSE_ERROR: 详情，只保留错误码交给前端翻译
    return (message.startsWith("AI_") ? message.split(":")[0] : message).slice(0, 200);
}

function parseProgress(value: string | null): { done: number; total: number; failed: number } | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as Partial<{ done: number; total: number; failed: number }>;
        if (typeof parsed.done === "number" && typeof parsed.total === "number" && typeof parsed.failed === "number") {
            return { done: parsed.done, total: parsed.total, failed: parsed.failed };
        }
    } catch {
        // 忽略无效 JSON
    }
    return null;
}

/** 登记一个后台事务 */
export function startBackgroundTask(input: BackgroundTaskInput): BackgroundTaskHandle {
    const now = Date.now();
    prune(now);
    const id = `${now.toString(36)}-${(sequence++).toString(36)}`;
    const progress = input.total !== undefined ? { done: 0, total: input.total, failed: 0 } : null;
    const startedAtDate = new Date(now);
    const task: StoredTask = {
        id,
        userId: input.userId,
        kind: input.kind,
        subject: input.subject ?? null,
        status: "running",
        progress,
        error: null,
        link: input.link ?? null,
        startedAt: startedAtDate.toISOString(),
        finishedAt: null,
    };
    tasks.set(id, task);

    enqueueDbSync(async (repo) => {
        await repo.upsert({
            where: {
                scopeKey_category_kind_idempotencyKey: {
                    scopeKey: input.userId,
                    category: TASK_CATEGORY,
                    kind: input.kind,
                    idempotencyKey: id,
                },
            },
            create: {
                userId: input.userId,
                scopeKey: input.userId,
                category: TASK_CATEGORY,
                kind: input.kind,
                idempotencyKey: id,
                status: "running",
                subject: task.subject,
                link: task.link,
                progressJson: task.progress ? JSON.stringify(task.progress) : null,
                startedAt: startedAtDate,
            },
            update: {
                status: "running",
                subject: task.subject,
                link: task.link,
                progressJson: task.progress ? JSON.stringify(task.progress) : null,
            },
        });
    });

    const finish = (status: BackgroundTaskStatus, error: string | null) => {
        if (task.status !== "running") return;
        const finishedDate = new Date();
        task.status = status;
        task.error = error;
        task.finishedAt = finishedDate.toISOString();

        enqueueDbSync(async (repo) => {
            await repo.updateMany({
                where: {
                    scopeKey: input.userId,
                    category: TASK_CATEGORY,
                    kind: input.kind,
                    idempotencyKey: id,
                    status: "running",
                },
                data: {
                    status,
                    error,
                    progressJson: task.progress ? JSON.stringify(task.progress) : null,
                    finishedAt: finishedDate,
                    expiresAt: new Date(finishedDate.getTime() + FINISHED_TASK_TTL_MS),
                },
            });
        });
    };

    return {
        id,
        setProgress: (done, total, failed) => {
            if (task.status !== "running") return;
            task.progress = { done, total: total ?? task.progress?.total ?? done, failed: failed ?? task.progress?.failed ?? 0 };
            const progressSnapshot = JSON.stringify(task.progress);
            enqueueDbSync(async (repo) => {
                await repo.updateMany({
                    where: {
                        scopeKey: input.userId,
                        category: TASK_CATEGORY,
                        kind: input.kind,
                        idempotencyKey: id,
                        status: "running",
                    },
                    data: { progressJson: progressSnapshot },
                });
            });
        },
        succeed: () => finish("succeeded", null),
        fail: (error) => {
            finish("failed", errorMessage(error));
            logger.debug({ taskId: id, kind: task.kind, error: task.error }, "Background task failed");
        },
    };
}

/**
 * 登记事务并执行 operation：正常返回标记成功，抛错标记失败后继续抛出
 */
export async function trackBackgroundTask<T>(input: BackgroundTaskInput, operation: (task: BackgroundTaskHandle) => Promise<T>): Promise<T> {
    const task = startBackgroundTask(input);
    try {
        const result = await operation(task);
        task.succeed();
        return result;
    } catch (error) {
        task.fail(error);
        throw error;
    }
}

/**
 * 从 AsyncOperation 表把用户任务同步到当前进程缓存（含进程重启后标记的 interrupted -> failed/SERVER_RESTARTED）
 */
export async function syncBackgroundTasksFromDb(userId: string): Promise<void> {
    await flushBackgroundTasksToDb();
    const repo = getAsyncOpRepo();
    if (!repo) return;

    const now = new Date();
    const cutoff = new Date(now.getTime() - FINISHED_TASK_TTL_MS);
    await repo.deleteMany({
        where: {
            userId,
            category: TASK_CATEGORY,
            status: { not: "running" },
            finishedAt: { lt: cutoff },
        },
    });

    const rows = await repo.findMany({
        where: { userId, category: TASK_CATEGORY },
        orderBy: { startedAt: "asc" },
    });

    const seenKeys = new Set(rows.map((row) => row.idempotencyKey));
    for (const [key, existing] of tasks) {
        if (existing.userId === userId && !seenKeys.has(key)) {
            tasks.delete(key);
        }
    }

    for (const row of rows) {
        const mappedStatus: BackgroundTaskStatus = row.status === "succeeded"
            ? "succeeded"
            : row.status === "running"
                ? "running"
                : "failed";
        const mappedError = row.status === "interrupted" ? (row.error || SERVER_RESTARTED) : (row.error ?? null);
        const mappedProgress = parseProgress(row.progressJson);
        const mappedFinishedAt = row.finishedAt ? row.finishedAt.toISOString() : null;

        const existing = tasks.get(row.idempotencyKey);
        if (existing && existing.userId === userId) {
            if (existing.status === "running" && row.status === "running") {
                // 保留同进程活跃任务原对象引用，避免与 startBackgroundTask 闭包句柄脱节
                continue;
            }
            existing.status = mappedStatus;
            existing.progress = mappedProgress;
            existing.error = mappedError;
            existing.finishedAt = mappedFinishedAt;
            continue;
        }

        tasks.set(row.idempotencyKey, {
            id: row.idempotencyKey,
            userId,
            kind: row.kind as BackgroundTaskKind,
            subject: row.subject ?? null,
            status: mappedStatus,
            progress: mappedProgress,
            error: mappedError,
            link: row.link ?? null,
            startedAt: row.startedAt.toISOString(),
            finishedAt: mappedFinishedAt,
        });
    }
}

/**
 * 当前用户的事务：进行中的在前（按开始时间），其后是最近结束的
 */
export function listBackgroundTasks(userId: string): BackgroundTask[] {
    prune(Date.now());
    const own = [...tasks.values()].filter((task) => task.userId === userId);
    const running = own.filter((task) => task.status === "running")
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const finished = own.filter((task) => task.status !== "running")
        .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))
        .slice(0, MAX_FINISHED_PER_USER);
    return [...running, ...finished].map((task) => ({
        id: task.id,
        kind: task.kind,
        subject: task.subject,
        status: task.status,
        progress: task.progress && { ...task.progress },
        error: task.error,
        link: task.link,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
    }));
}

/** 清除当前用户已结束的事务记录 */
export function clearFinishedBackgroundTasks(userId: string): void {
    for (const [id, task] of tasks) {
        if (task.userId === userId && task.status !== "running") tasks.delete(id);
    }
    enqueueDbSync(async (repo) => {
        await repo.deleteMany({
            where: {
                userId,
                category: TASK_CATEGORY,
                status: { not: "running" },
            },
        });
    });
}

/** 题目的简短说明：编号 + 题干开头（去掉公式符号和换行） */
export function describeQuestion(item: { shortId?: string | null; questionText?: string | null }): string {
    const text = (item.questionText ?? "")
        .replace(/\$+/g, "")
        .replace(/\\[a-zA-Z]+|[{}\\]/g, " ")
        .replace(/[#*>`|_-]+/g, " ")
        .replace(/\s+/g, " ")
        .replace(/\s*([，。；：？！、])\s*/g, "$1")
        .trim();
    const excerpt = text.length > 24 ? `${text.slice(0, 24)}…` : text;
    return [item.shortId, excerpt].filter(Boolean).join(" ") || "—";
}

/** 仅供测试：清空进程内登记表 */
export function resetBackgroundTasksForTest(): void {
    store.__backgroundTasksGeneration = (store.__backgroundTasksGeneration ?? 0) + 1;
    tasks.clear();
}

/** 清理所有后台任务缓存及旧版本遗留持久化文件（供 system-reset 调用） */
export function clearAllBackgroundTasks(): void {
    store.__backgroundTasksGeneration = (store.__backgroundTasksGeneration ?? 0) + 1;
    tasks.clear();
    const legacyFile = path.join(
        process.env.CONFIG_DIR || path.join(process.cwd(), "config"),
        "background-tasks.json",
    );
    try {
        fs.rmSync(/* turbopackIgnore: true */ legacyFile, { force: true });
    } catch (error) {
        logger.warn({ error }, "Failed to remove legacy background tasks persistence file");
    }
}
