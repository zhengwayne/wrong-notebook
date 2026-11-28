/**
 * 统一异步作业、幂等操作执行器与冷启动中断恢复（基于 SQLite AsyncOperation 表）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { createLogger } from "@/lib/logger";

const logger = createLogger("async-operations");

const store = globalThis as typeof globalThis & {
    __inflightIdempotentOps?: Map<string, { requestHash: string; promise: Promise<{ fromDb: boolean; value: unknown }> }>;
};
const inflightOps = store.__inflightIdempotentOps ??= new Map();

export class IdempotencyConflictError extends Error {
    readonly status = 409;
    constructor(message = "Idempotency key reused with different request payload") {
        super(message);
        this.name = "IdempotencyConflictError";
    }
}

export class CrossTenantOperationError extends Error {
    readonly status = 404;
    constructor(message = "Operation not found") {
        super(message);
        this.name = "CrossTenantOperationError";
    }
}

function normalizeValue(value: unknown): unknown {
    if (value === null || typeof value !== "object") {
        return value;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (Array.isArray(value)) {
        return value.map((item) => (item === undefined ? null : normalizeValue(item)));
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([a], [b]) => a.localeCompare(b));
    const sorted: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
        sorted[key] = normalizeValue(entryValue);
    }
    return sorted;
}

/** 计算稳定键序下的请求载荷 SHA-256 摘要，避免键序差异造成误判 409 */
export function computeRequestHash(payload: unknown): string {
    const serialized = JSON.stringify(normalizeValue(payload)) ?? "null";
    return crypto.createHash("sha256").update(serialized, "utf8").digest("hex");
}

function isUniqueConstraintError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    return (error as { code?: string }).code === "P2002";
}

export interface RunIdempotentOptions {
    db: PrismaClient;
    userId: string;
    kind: string;
    idempotencyKey: string;
    payload: unknown;
    ttlMs?: number;
}

/**
 * 在 `(userId, kind, idempotencyKey)` 下执行带并发合并与持久化幂等的业务操作：
 * - 同键同载荷并发/重放：至多执行一次 `execute()` 并复用同一结果
 * - 同键异载荷：抛出 `IdempotencyConflictError`（409）
 * - 跨租户归属不匹配：抛出 `CrossTenantOperationError`（404）
 */
export async function runIdempotentOperation<T>(
    options: RunIdempotentOptions,
    execute: () => Promise<T>,
): Promise<{ reused: boolean; result: T }> {
    const { db, userId, kind, idempotencyKey, payload, ttlMs = 24 * 60 * 60 * 1000 } = options;
    const scopeKey = userId;
    const category = "idempotent";
    const requestHash = computeRequestHash(payload);
    const inflightKey = `${scopeKey}::${category}::${kind}::${idempotencyKey}`;

    const existingInflight = inflightOps.get(inflightKey);
    if (existingInflight) {
        if (existingInflight.requestHash !== requestHash) {
            throw new IdempotencyConflictError();
        }
        const shared = await existingInflight.promise;
        return { reused: true, result: shared.value as T };
    }

    const runnerPromise = (async (): Promise<{ fromDb: boolean; value: unknown }> => {
        const now = new Date();
        const uniqueWhere = {
            scopeKey_category_kind_idempotencyKey: {
                scopeKey,
                category,
                kind,
                idempotencyKey,
            },
        };

        const existing = await db.asyncOperation.findUnique({ where: uniqueWhere });
        if (existing) {
            if (existing.userId && existing.userId !== userId) {
                throw new CrossTenantOperationError();
            }
            const expired = Boolean(existing.expiresAt && existing.expiresAt.getTime() <= now.getTime());
            if (!expired) {
                if (existing.requestHash !== requestHash) {
                    throw new IdempotencyConflictError();
                }
                if (existing.status === "succeeded" && existing.responseJson !== null) {
                    return { fromDb: true, value: JSON.parse(existing.responseJson) as T };
                }
            } else {
                await db.asyncOperation.deleteMany({ where: { id: existing.id } });
            }
        }

        let opId: string | null = null;
        try {
            const created = await db.asyncOperation.create({
                data: {
                    userId,
                    scopeKey,
                    category,
                    kind,
                    idempotencyKey,
                    requestHash,
                    status: "running",
                    startedAt: now,
                    expiresAt: ttlMs > 0 ? new Date(now.getTime() + ttlMs) : null,
                },
                select: { id: true },
            });
            opId = created.id;
        } catch (error) {
            if (!isUniqueConstraintError(error)) throw error;
            const raced = await db.asyncOperation.findUnique({ where: uniqueWhere });
            if (raced) {
                if (raced.userId && raced.userId !== userId) {
                    throw new CrossTenantOperationError();
                }
                if (raced.requestHash !== requestHash) {
                    throw new IdempotencyConflictError();
                }
                if (raced.status === "succeeded" && raced.responseJson !== null) {
                    return { fromDb: true, value: JSON.parse(raced.responseJson) as T };
                }
                opId = raced.id;
            }
        }

        try {
            const value = await execute();
            if (opId) {
                await db.asyncOperation.update({
                    where: { id: opId },
                    data: {
                        status: "succeeded",
                        statusCode: 200,
                        responseJson: JSON.stringify(value),
                        finishedAt: new Date(),
                        expiresAt: ttlMs > 0 ? new Date(Date.now() + ttlMs) : null,
                    },
                });
            }
            return { fromDb: false, value };
        } catch (error) {
            if (opId) {
                await db.asyncOperation.deleteMany({ where: { id: opId, status: "running" } }).catch(() => {});
            }
            throw error;
        }
    })();

    inflightOps.set(inflightKey, { requestHash, promise: runnerPromise });
    try {
        const resolved = await runnerPromise;
        return {
            reused: resolved.fromDb,
            result: resolved.value as T,
        };
    } finally {
        if (inflightOps.get(inflightKey)?.promise === runnerPromise) {
            inflightOps.delete(inflightKey);
        }
    }
}

/** 按主键查询异步作业，校验跨用户隔离（非本人记录返回 null，对应 404） */
export async function findOwnedAsyncOperation(
    db: PrismaClient,
    id: string,
    viewerUserId: string,
) {
    const record = await db.asyncOperation.findUnique({ where: { id } });
    if (!record) return null;
    if (record.userId && record.userId !== viewerUserId) {
        return null;
    }
    return record;
}

/**
 * 服务冷启动自愈：将上一进程遗留的 running 态作业统一置为 interrupted (SERVER_RESTARTED)，
 * 清理已过期条目与旧版遗留的 config/background-tasks.json 文件。
 */
export async function recoverInterruptedAsyncOperations(db: PrismaClient): Promise<number> {
    const now = new Date();
    const updated = await db.asyncOperation.updateMany({
        where: { status: "running" },
        data: {
            status: "interrupted",
            error: "SERVER_RESTARTED",
            finishedAt: now,
        },
    });
    await db.asyncOperation.deleteMany({
        where: {
            status: { not: "running" },
            expiresAt: { lte: now },
        },
    });

    const legacyTasksFile = path.join(
        process.env.CONFIG_DIR || path.join(process.cwd(), "config"),
        "background-tasks.json",
    );
    try {
        fs.rmSync(/* turbopackIgnore: true */ legacyTasksFile, { force: true });
    } catch (error) {
        logger.warn({ error }, "Failed to remove legacy background-tasks.json");
    }

    if (updated.count > 0) {
        logger.info({ interrupted: updated.count }, "Marked interrupted async operations after restart");
    }
    return updated.count;
}
