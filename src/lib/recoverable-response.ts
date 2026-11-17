/**
 * 耗时请求的响应暂存，供请求被浏览器中断后取回。
 *
 * 结合进程内热缓存与 SQLite `AsyncOperation` 表（category = 'recoverable'）：
 * - 已完成响应按 `userId` 归属隔离（跨用户查询严格返回 404）；
 * - 当 `AsyncOperation` 表可用时支持跨重启取回已完成响应。
 */
import type { PrismaClient } from "@prisma/client";
import { createLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { resolveActor } from "@/lib/server/actor";
import { getRequestContext } from "@/lib/server/request-context";

const logger = createLogger("recoverable-response");

export const REQUEST_ID_HEADER = "x-request-id";

/** 请求结束后响应保留的时长 */
export const RESPONSE_TTL_MS = 15 * 60 * 1000;
/** 进行中的请求最长保留时长（超过后视为丢失） */
const RUNNING_TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 200;
/** 单个响应最多暂存的字符数，超出时不保存，前端按请求失败处理 */
const MAX_BODY_LENGTH = 5_000_000;

const REQUEST_ID_PATTERN = /^[a-f0-9]{32}$/;
const RECOVERABLE_SCOPE_KEY = "request";
const RECOVERABLE_CATEGORY = "recoverable";
const RECOVERABLE_KIND = "http_request";

export type StoredResponse =
    | { state: "running" }
    | { state: "done"; status: number; body: unknown };

interface Entry {
    userId: string | null;
    startedAt: number;
    finishedAt: number | null;
    status: number;
    body: unknown;
}

const store = globalThis as typeof globalThis & { __recoverableResponses?: Map<string, Entry> };
const entries: Map<string, Entry> = store.__recoverableResponses ??= new Map();

function getAsyncOpRepo(): PrismaClient["asyncOperation"] | null {
    try {
        const db = prisma as unknown as { asyncOperation?: PrismaClient["asyncOperation"] };
        if (db?.asyncOperation && typeof db.asyncOperation.findUnique === "function" && typeof db.asyncOperation.upsert === "function") {
            return db.asyncOperation;
        }
    } catch {
        // 局部 mock Prisma 的测试环境自动回退纯内存模式
    }
    return null;
}

function prune(now: number) {
    for (const [id, entry] of entries) {
        const expired = entry.finishedAt !== null
            ? now - entry.finishedAt > RESPONSE_TTL_MS
            : now - entry.startedAt > RUNNING_TTL_MS;
        if (expired) entries.delete(id);
    }
    // 超出上限时删除最早登记的
    for (const id of entries.keys()) {
        if (entries.size <= MAX_ENTRIES) break;
        entries.delete(id);
    }
}

/** 校验前端传来的请求编号（32 位十六进制），无效时返回 null */
export function parseRequestId(value: string | null | undefined): string | null {
    const id = value?.trim().toLowerCase();
    return id && REQUEST_ID_PATTERN.test(id) ? id : null;
}

async function readBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length > MAX_BODY_LENGTH) throw new Error("RESPONSE_TOO_LARGE");
    if (!text) return null;
    if ((response.headers.get("content-type") ?? "").includes("application/json")) return JSON.parse(text);
    return text;
}

async function tryResolveUserId(): Promise<string | null> {
    const fromCtx = getRequestContext()?.userId;
    if (fromCtx) return fromCtx;
    try {
        const actor = await resolveActor();
        return actor.kind === "authenticated" ? actor.user.id : null;
    } catch {
        return null;
    }
}

/**
 * 包装路由处理函数：请求带有请求编号时，暂存处理结果（状态码与响应内容）供断线后取回
 */
export function withRecoverableResponse<R extends Request, A extends unknown[]>(handler: (req: R, ...args: A) => Promise<Response>) {
    return async (req: R, ...args: A): Promise<Response> => {
        const id = parseRequestId(req.headers.get(REQUEST_ID_HEADER));
        if (!id) return handler(req, ...args);

        const now = Date.now();
        prune(now);
        const initialUserId = getRequestContext()?.userId ?? null;
        const entry: Entry = {
            userId: initialUserId,
            startedAt: now,
            finishedAt: null,
            status: 0,
            body: null,
        };
        entries.set(id, entry);

        const repo = getAsyncOpRepo();
        const dbInitPromise = (async () => {
            if (!entry.userId) {
                entry.userId = await tryResolveUserId();
            }
            if (!repo) return;
            await repo.upsert({
                where: {
                    scopeKey_category_kind_idempotencyKey: {
                        scopeKey: RECOVERABLE_SCOPE_KEY,
                        category: RECOVERABLE_CATEGORY,
                        kind: RECOVERABLE_KIND,
                        idempotencyKey: id,
                    },
                },
                create: {
                    userId: entry.userId,
                    scopeKey: RECOVERABLE_SCOPE_KEY,
                    category: RECOVERABLE_CATEGORY,
                    kind: RECOVERABLE_KIND,
                    idempotencyKey: id,
                    status: "running",
                    startedAt: new Date(now),
                    expiresAt: new Date(now + RUNNING_TTL_MS),
                },
                update: {
                    userId: entry.userId,
                    status: "running",
                    statusCode: null,
                    responseJson: null,
                    error: null,
                    startedAt: new Date(now),
                    finishedAt: null,
                    expiresAt: new Date(now + RUNNING_TTL_MS),
                },
            });
        })().catch((error) => {
            logger.warn({ requestId: id, error: error instanceof Error ? error.message : String(error) }, "Failed to persist running recoverable request");
        });

        try {
            const response = await handler(req, ...args);
            await dbInitPromise;
            const ownerUserId = entry.userId ?? getRequestContext()?.userId ?? (await tryResolveUserId());
            entry.userId = ownerUserId;

            try {
                const body = await readBody(response.clone());
                const finishedAt = Date.now();
                entry.body = body;
                entry.status = response.status;
                entry.finishedAt = finishedAt;

                if (repo) {
                    await repo.upsert({
                        where: {
                            scopeKey_category_kind_idempotencyKey: {
                                scopeKey: RECOVERABLE_SCOPE_KEY,
                                category: RECOVERABLE_CATEGORY,
                                kind: RECOVERABLE_KIND,
                                idempotencyKey: id,
                            },
                        },
                        create: {
                            userId: ownerUserId,
                            scopeKey: RECOVERABLE_SCOPE_KEY,
                            category: RECOVERABLE_CATEGORY,
                            kind: RECOVERABLE_KIND,
                            idempotencyKey: id,
                            status: "succeeded",
                            statusCode: response.status,
                            responseJson: JSON.stringify(body),
                            startedAt: new Date(now),
                            finishedAt: new Date(finishedAt),
                            expiresAt: new Date(finishedAt + RESPONSE_TTL_MS),
                        },
                        update: {
                            userId: ownerUserId,
                            status: "succeeded",
                            statusCode: response.status,
                            responseJson: JSON.stringify(body),
                            finishedAt: new Date(finishedAt),
                            expiresAt: new Date(finishedAt + RESPONSE_TTL_MS),
                        },
                    }).catch((error) => {
                        logger.warn({ requestId: id, error: error instanceof Error ? error.message : String(error) }, "Failed to persist done recoverable response");
                    });
                }
            } catch (error) {
                entries.delete(id);
                if (repo) {
                    await repo.deleteMany({
                        where: {
                            scopeKey: RECOVERABLE_SCOPE_KEY,
                            category: RECOVERABLE_CATEGORY,
                            kind: RECOVERABLE_KIND,
                            idempotencyKey: id,
                        },
                    }).catch(() => {});
                }
                logger.warn({ requestId: id, error: error instanceof Error ? error.message : String(error) }, "Response not stored for recovery");
            }
            return response;
        } catch (error) {
            entries.delete(id);
            await dbInitPromise;
            if (repo) {
                await repo.deleteMany({
                    where: {
                        scopeKey: RECOVERABLE_SCOPE_KEY,
                        category: RECOVERABLE_CATEGORY,
                        kind: RECOVERABLE_KIND,
                        idempotencyKey: id,
                    },
                }).catch(() => {});
            }
            throw error;
        }
    };
}

/** 按请求编号查询：进行中、已结束（含响应），或不存在 / 跨用户无权（返回 null） */
export async function getStoredResponse(id: string, viewerUserId?: string | null): Promise<StoredResponse | null> {
    const now = Date.now();
    prune(now);

    const entry = entries.get(id);
    if (entry) {
        if (entry.userId && viewerUserId !== undefined && entry.userId !== viewerUserId) {
            return null;
        }
        return entry.finishedAt === null ? { state: "running" } : { state: "done", status: entry.status, body: entry.body };
    }

    const repo = getAsyncOpRepo();
    if (!repo) return null;

    const record = await repo.findUnique({
        where: {
            scopeKey_category_kind_idempotencyKey: {
                scopeKey: RECOVERABLE_SCOPE_KEY,
                category: RECOVERABLE_CATEGORY,
                kind: RECOVERABLE_KIND,
                idempotencyKey: id,
            },
        },
    });
    if (!record) return null;
    if (record.expiresAt && record.expiresAt.getTime() <= now) {
        return null;
    }
    if (record.status === "interrupted" || record.status === "failed") {
        return null;
    }
    if (record.userId && viewerUserId !== undefined && record.userId !== viewerUserId) {
        return null;
    }
    if (record.status === "running") {
        return { state: "running" };
    }
    return {
        state: "done",
        status: record.statusCode ?? 200,
        body: record.responseJson ? JSON.parse(record.responseJson) : null,
    };
}

/** 仅供测试：清空内存暂存 */
export function resetRecoverableResponsesForTest(): void {
    entries.clear();
}

/** 清空内存中的断线重取响应缓存（供 system-reset 调用） */
export function clearRecoverableResponses(): void {
    entries.clear();
}

/** 注销/删除用户时从进程内热缓存移除该用户的断线恢复响应 */
export function purgeUserRecoverableResponses(userId: string): void {
    if (!userId) return;
    for (const [id, entry] of entries) {
        if (entry.userId === userId) {
            entries.delete(id);
        }
    }
}
