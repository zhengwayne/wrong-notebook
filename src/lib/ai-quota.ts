import crypto from "node:crypto";
import type { NextResponse } from "next/server";
import { createErrorResponse, ErrorCode } from "@/lib/api-errors";
import type { ApiErrorResponse } from "@/lib/api-errors";
import { getAppConfig, getAppTimeZone } from "@/lib/config";
import { formatDateTime, getDayRange } from "@/lib/date-time";
import { createLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const logger = createLogger("ai-quota");

/** 与 recoverable-response 的 REQUEST_ID_HEADER 一致（此处不引入以免带上鉴权依赖） */
const REQUEST_ID_HEADER = "x-request-id";

/** 计入额度的用户操作；后台规则重算不计入 */
export const AI_USAGE_KINDS = ["analyze", "reanswer", "practice", "grade", "figure", "latex", "geogebra", "animation", "exam", "retag", "mastery"] as const;
export type AiUsageKind = typeof AI_USAGE_KINDS[number];

/**
 * 每日 AI 次数的计算方式：成功才算一次。
 * 调用前先原子预留一次（预留中的也占名额，并发再多也不会超过上限），
 * 成功后确认，失败（繁忙、超时、AI 报错、没认出内容）时退回。
 * 预留超过 15 分钟仍未结算（进程重启等）会被自动退回。
 */
export const AI_RESERVATION_TTL_MS = 15 * 60 * 1000;

export type AiUsageStatus = "reserved" | "confirmed" | "released" | "expired";

export interface QuotaUser {
    id: string;
    role?: string | null;
}

export interface AiQuotaReservation {
    /** 超过每日上限时的 429 响应；为 null 表示已预留成功 */
    limited: NextResponse<ApiErrorResponse> | null;
    /** AiUsage 记录 id；统计异常时为 null（此时不拦截也不计数） */
    id: string | null;
    /** 是同一请求编号的重复请求，沿用了第一次的预留 */
    reused: boolean;
    confirm(): Promise<void>;
    release(): Promise<void>;
    /** ok 为真确认，否则退回 */
    settle(ok: boolean): Promise<void>;
    /** 按响应结算：2xx 确认，其余退回；返回原响应，便于 return quota.settleResponse(res) */
    settleResponse<T extends Response>(response: T, ok?: boolean): Promise<T>;
    /** 交给后台任务：结算推迟到任务结束时按 ref 进行 */
    attach(ref: string): Promise<void>;
}

export interface ReserveOptions {
    /** 从请求头 x-request-id 取请求编号，同一编号只预留一次 */
    request?: Request;
    /** 一个请求里预留多次时区分各次（例如逐份答卷） */
    requestKeySuffix?: string;
    /** 直接指定请求编号 */
    requestKey?: string | null;
    /** 后台任务关联 */
    ref?: string;
}

function hasReservationSupport(): boolean {
    try {
        const db = prisma as unknown as {
            aiDailyQuota?: { findUnique?: unknown };
            aiUsage?: { findFirst?: unknown; updateMany?: unknown };
            $executeRaw?: unknown;
        };
        return Boolean(
            db?.aiDailyQuota
            && typeof db.aiDailyQuota.findUnique === "function"
            && typeof db.aiUsage?.findFirst === "function"
            && typeof db.aiUsage?.updateMany === "function"
            && typeof db.$executeRaw === "function",
        );
    } catch {
        return false;
    }
}

export function aiDayKey(now = new Date()): string {
    return formatDateTime(now, "yyyy-MM-dd", getAppTimeZone());
}

/** 统计口径：今天已确认（成功）的 AI 调用次数 */
export async function countTodayAiUsage(userId: string, now = new Date()): Promise<number> {
    const { start, end } = getDayRange(now, getAppTimeZone());
    return prisma.aiUsage.count({ where: { userId, status: "confirmed", createdAt: { gte: start, lt: end } } });
}

const noop = async () => {};

function handle(id: string | null, limited: NextResponse<ApiErrorResponse> | null, reused = false): AiQuotaReservation {
    const confirm = id ? () => confirmAiReservation(id) : noop;
    // 重复请求沿用第一次的预留：重复的那次失败不能把第一次的退掉
    const release = id && !reused ? () => releaseAiReservation(id) : noop;
    const reservation: AiQuotaReservation = {
        limited,
        id,
        reused,
        confirm,
        release,
        settle: (ok) => (ok ? confirm() : release()),
        async settleResponse(response, ok) {
            await reservation.settle(ok ?? (response.status >= 200 && response.status < 300));
            return response;
        },
        attach: async (ref) => {
            if (!id) return;
            try {
                await prisma.aiUsage.updateMany({ where: { id }, data: { ref } });
            } catch (error) {
                logger.warn({ error, id, ref }, "Failed to attach AI reservation");
            }
        },
    };
    return reservation;
}

function requestKeyFrom(options: ReserveOptions, kind: AiUsageKind): string | null {
    const base = options.requestKey ?? options.request?.headers.get(REQUEST_ID_HEADER)?.trim() ?? null;
    if (!base) return null;
    return `${kind}:${base.slice(0, 120)}${options.requestKeySuffix ? `:${options.requestKeySuffix}` : ""}`;
}

/** 把指定日期的已占用次数减一（最低 0） */
async function decrementDay(userId: string, dayKey: string | null | undefined): Promise<void> {
    if (!dayKey) return;
    await prisma.$executeRaw`
        UPDATE "AiDailyQuota"
        SET "count" = CASE WHEN "count" > 0 THEN "count" - 1 ELSE 0 END,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "userId" = ${userId} AND "dayKey" = ${dayKey}
    `;
}

async function ensureDayRow(userId: string, dayKey: string, now: Date): Promise<void> {
    const existing = await prisma.aiDailyQuota.findUnique({ where: { userId_dayKey: { userId, dayKey } }, select: { id: true } });
    if (existing) return;
    const { start, end } = getDayRange(now, getAppTimeZone());
    const baseline = await prisma.aiUsage.count({
        where: { userId, status: { in: ["reserved", "confirmed"] }, createdAt: { gte: start, lt: end } },
    });
    await prisma.$executeRaw`
        INSERT INTO "AiDailyQuota" ("id", "userId", "dayKey", "count", "updatedAt")
        VALUES (${crypto.randomUUID()}, ${userId}, ${dayKey}, ${baseline}, CURRENT_TIMESTAMP)
        ON CONFLICT("userId", "dayKey") DO NOTHING
    `;
}

/** 占用一次：有上限时仅在未满时成功；返回是否占到 */
async function takeSlot(user: QuotaUser, dayKey: string, now: Date, limit: number): Promise<boolean> {
    if (limit > 0 && user.role !== "admin") {
        await ensureDayRow(user.id, dayKey, now);
        const reserved = await prisma.$executeRaw`
            UPDATE "AiDailyQuota"
            SET "count" = "count" + 1, "updatedAt" = CURRENT_TIMESTAMP
            WHERE "userId" = ${user.id} AND "dayKey" = ${dayKey} AND "count" < ${limit}
        `;
        return Number(reserved) > 0;
    }
    await prisma.$executeRaw`
        INSERT INTO "AiDailyQuota" ("id", "userId", "dayKey", "count", "updatedAt")
        VALUES (${crypto.randomUUID()}, ${user.id}, ${dayKey}, 1, CURRENT_TIMESTAMP)
        ON CONFLICT("userId", "dayKey") DO UPDATE SET "count" = "count" + 1, "updatedAt" = CURRENT_TIMESTAMP
    `;
    return true;
}

/** 把超过 15 分钟仍未结算的预留自动退回 */
export async function expireStaleAiReservations(userId?: string, now = new Date()): Promise<number> {
    if (!hasReservationSupport()) return 0;
    const cutoff = new Date(now.getTime() - AI_RESERVATION_TTL_MS);
    const stale = await prisma.aiUsage.findMany({
        where: { ...(userId ? { userId } : {}), status: "reserved", createdAt: { lt: cutoff } },
        select: { id: true, userId: true, dayKey: true },
        take: 200,
    });
    let expired = 0;
    for (const row of stale) {
        const moved = await prisma.aiUsage.updateMany({ where: { id: row.id, status: "reserved" }, data: { status: "expired", settledAt: now } });
        if (moved.count === 0) continue;
        await decrementDay(row.userId, row.dayKey);
        expired += 1;
    }
    if (expired) logger.info({ userId, expired }, "Expired stale AI reservations");
    return expired;
}

/**
 * 发起 AI 调用前原子预留一次额度。超出每日上限时 reservation.limited 为 429 响应，路由直接返回它。
 * 管理员和未设上限时不拦截，但同样记录。统计出错时放行，不影响正常使用。
 */
export async function reserveAiQuota(user: QuotaUser, kind: AiUsageKind, options: ReserveOptions = {}): Promise<AiQuotaReservation> {
    try {
        if (!hasReservationSupport()) return handle(null, null);
        const limit = getAppConfig().aiDailyLimit ?? 0;
        const now = new Date();
        const dayKey = aiDayKey(now);
        const requestKey = requestKeyFrom(options, kind);

        await expireStaleAiReservations(user.id, now);

        let existing: { id: string; status: string } | null = null;
        if (requestKey) {
            existing = await prisma.aiUsage.findFirst({ where: { userId: user.id, requestKey }, select: { id: true, status: true } });
            if (existing && (existing.status === "reserved" || existing.status === "confirmed")) {
                logger.info({ userId: user.id, kind, requestKey }, "Duplicate AI request reuses reservation");
                return handle(existing.id, null, true);
            }
        }

        if (!(await takeSlot(user, dayKey, now, limit))) {
            logger.info({ userId: user.id, kind, limit, dayKey }, "AI daily limit reached");
            return handle(null, createErrorResponse(ErrorCode.AI_DAILY_LIMIT_EXCEEDED, 429, ErrorCode.AI_DAILY_LIMIT_EXCEEDED, { limit }));
        }

        if (existing) {
            // 同一请求编号上次失败已退回，这次重新预留
            const revived = await prisma.aiUsage.updateMany({
                where: { id: existing.id, status: { in: ["released", "expired"] } },
                data: { status: "reserved", kind, dayKey, createdAt: now, settledAt: null, ref: options.ref ?? null },
            });
            if (revived.count === 1) return handle(existing.id, null);
            await decrementDay(user.id, dayKey);
            return handle(existing.id, null, true);
        }

        try {
            const row = await prisma.aiUsage.create({
                data: { userId: user.id, kind, status: "reserved", dayKey, requestKey, ref: options.ref ?? null, createdAt: now },
                select: { id: true },
            });
            return handle(row.id, null);
        } catch (error) {
            // 同一请求编号并发到达：另一边已预留，退回本次占用并沿用那一条
            if ((error as { code?: string })?.code === "P2002" && requestKey) {
                await decrementDay(user.id, dayKey);
                const other = await prisma.aiUsage.findFirst({ where: { userId: user.id, requestKey }, select: { id: true } });
                return handle(other?.id ?? null, null, true);
            }
            await decrementDay(user.id, dayKey);
            throw error;
        }
    } catch (error) {
        logger.error({ error, userId: user.id, kind }, "Failed to reserve AI quota");
        return handle(null, null);
    }
}

/** 成功：确认这次预留。已被超时自动退回的会重新计入（任务确实成功了）。可重复调用 */
export async function confirmAiReservation(id: string): Promise<void> {
    try {
        const now = new Date();
        const done = await prisma.aiUsage.updateMany({ where: { id, status: "reserved" }, data: { status: "confirmed", settledAt: now } });
        if (done.count === 1) return;
        const row = await prisma.aiUsage.findUnique({ where: { id }, select: { userId: true, status: true, dayKey: true } });
        if (row?.status !== "expired") return;
        const revived = await prisma.aiUsage.updateMany({ where: { id, status: "expired" }, data: { status: "confirmed", settledAt: now } });
        if (revived.count === 1 && row.dayKey) {
            await prisma.$executeRaw`
                INSERT INTO "AiDailyQuota" ("id", "userId", "dayKey", "count", "updatedAt")
                VALUES (${crypto.randomUUID()}, ${row.userId}, ${row.dayKey}, 1, CURRENT_TIMESTAMP)
                ON CONFLICT("userId", "dayKey") DO UPDATE SET "count" = "count" + 1, "updatedAt" = CURRENT_TIMESTAMP
            `;
        }
    } catch (error) {
        logger.warn({ error, id }, "Failed to confirm AI reservation");
    }
}

/** 失败：退回这次预留，扣回预留当天（不是退回时的当天）。只会退一次 */
export async function releaseAiReservation(id: string): Promise<void> {
    try {
        const row = await prisma.aiUsage.findUnique({ where: { id }, select: { userId: true, dayKey: true } });
        if (!row) return;
        const done = await prisma.aiUsage.updateMany({ where: { id, status: "reserved" }, data: { status: "released", settledAt: new Date() } });
        if (done.count === 1) await decrementDay(row.userId, row.dayKey);
    } catch (error) {
        logger.warn({ error, id }, "Failed to release AI reservation");
    }
}

/** 后台任务结束时按关联结算该任务名下所有未结算的预留 */
export async function settleAiReservationsByRef(ref: string, ok: boolean): Promise<void> {
    try {
        if (!hasReservationSupport()) return;
        const rows = await prisma.aiUsage.findMany({
            where: { ref, status: ok ? { in: ["reserved", "expired"] } : "reserved" },
            select: { id: true },
        });
        for (const row of rows) {
            if (ok) await confirmAiReservation(row.id);
            else await releaseAiReservation(row.id);
        }
    } catch (error) {
        logger.warn({ error, ref, ok }, "Failed to settle AI reservations");
    }
}

/** 预留 → 执行 → 按结果结算；执行抛错时退回并继续抛出 */
export async function runWithAiQuota<T>(
    reservation: AiQuotaReservation,
    run: () => Promise<T>,
    isSuccess: (result: T) => boolean = () => true,
): Promise<T> {
    let result: T;
    try {
        result = await run();
    } catch (error) {
        await reservation.release();
        throw error;
    }
    await reservation.settle(isSuccess(result));
    return result;
}

export const aiQuotaRefs = {
    gradingSubmission: (id: string) => `grading-submission:${id}`,
    examPaper: (id: string) => `exam-paper:${id}`,
    variantRun: (id: string) => `variant-run:${id}`,
};
