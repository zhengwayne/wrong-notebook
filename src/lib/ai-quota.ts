import crypto from "node:crypto";
import type { NextResponse } from "next/server";
import { createErrorResponse, ErrorCode } from "@/lib/api-errors";
import type { ApiErrorResponse } from "@/lib/api-errors";
import { getAppConfig, getAppTimeZone } from "@/lib/config";
import { formatDateTime, getDayRange } from "@/lib/date-time";
import { createLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const logger = createLogger("ai-quota");

/** 计入额度的用户操作；后台规则重算不计入 */
export const AI_USAGE_KINDS = ["analyze", "reanswer", "practice", "grade", "figure", "latex", "geogebra", "animation", "exam", "retag", "mastery"] as const;
export type AiUsageKind = typeof AI_USAGE_KINDS[number];

export interface QuotaUser {
    id: string;
    role?: string | null;
}

function hasAtomicQuotaSupport(): boolean {
    try {
        const db = prisma as unknown as {
            aiDailyQuota?: { findUnique?: unknown };
            $executeRaw?: unknown;
        };
        return Boolean(
            db?.aiDailyQuota
            && typeof db.aiDailyQuota.findUnique === "function"
            && typeof db.$executeRaw === "function",
        );
    } catch {
        return false;
    }
}

/** 用户在应用时区的今天已发起的 AI 调用次数 */
export async function countTodayAiUsage(userId: string, now = new Date()): Promise<number> {
    const { start, end } = getDayRange(now, getAppTimeZone());
    return prisma.aiUsage.count({ where: { userId, createdAt: { gte: start, lt: end } } });
}

/**
 * 发起 AI 调用前原子检查并预留额度：超出每日上限时返回 429 响应，路由直接返回它；
 * 否则原子占用一次额度并写入 AiUsage 明细后返回 null。管理员不受限制，但同样记录用量。
 * 读取配置或记录失败时不阻止调用，避免统计问题影响正常使用。
 */
export async function consumeAiQuota(user: QuotaUser, kind: AiUsageKind): Promise<NextResponse<ApiErrorResponse> | null> {
    try {
        const limit = getAppConfig().aiDailyLimit ?? 0;

        if (hasAtomicQuotaSupport()) {
            const now = new Date();
            const timeZone = getAppTimeZone();
            const dayKey = formatDateTime(now, "yyyy-MM-dd", timeZone);

            if (limit > 0 && user.role !== "admin") {
                const existing = await prisma.aiDailyQuota.findUnique({
                    where: { userId_dayKey: { userId: user.id, dayKey } },
                    select: { id: true },
                });
                if (!existing) {
                    const { start, end } = getDayRange(now, timeZone);
                    const baseline = await prisma.aiUsage.count({
                        where: { userId: user.id, createdAt: { gte: start, lt: end } },
                    });
                    await prisma.$executeRaw`
                        INSERT INTO "AiDailyQuota" ("id", "userId", "dayKey", "count", "updatedAt")
                        VALUES (${crypto.randomUUID()}, ${user.id}, ${dayKey}, ${baseline}, CURRENT_TIMESTAMP)
                        ON CONFLICT("userId", "dayKey") DO NOTHING
                    `;
                }

                const reserved = await prisma.$executeRaw`
                    UPDATE "AiDailyQuota"
                    SET "count" = "count" + 1, "updatedAt" = CURRENT_TIMESTAMP
                    WHERE "userId" = ${user.id} AND "dayKey" = ${dayKey} AND "count" < ${limit}
                `;
                if (Number(reserved) === 0) {
                    logger.info({ userId: user.id, kind, limit, dayKey }, "AI daily limit reached");
                    return createErrorResponse(ErrorCode.AI_DAILY_LIMIT_EXCEEDED, 429, ErrorCode.AI_DAILY_LIMIT_EXCEEDED, { limit });
                }

                await prisma.aiUsage.create({ data: { userId: user.id, kind } });
                return null;
            }

            await prisma.$executeRaw`
                INSERT INTO "AiDailyQuota" ("id", "userId", "dayKey", "count", "updatedAt")
                VALUES (${crypto.randomUUID()}, ${user.id}, ${dayKey}, 1, CURRENT_TIMESTAMP)
                ON CONFLICT("userId", "dayKey") DO UPDATE SET
                    "count" = "count" + 1,
                    "updatedAt" = CURRENT_TIMESTAMP
            `;
            await prisma.aiUsage.create({ data: { userId: user.id, kind } });
            return null;
        }

        // 仅 mock aiUsage 的单测环境保持原计数写入流程兼容
        if (limit > 0 && user.role !== "admin" && await countTodayAiUsage(user.id) >= limit) {
            logger.info({ userId: user.id, kind, limit }, "AI daily limit reached");
            return createErrorResponse(ErrorCode.AI_DAILY_LIMIT_EXCEEDED, 429, ErrorCode.AI_DAILY_LIMIT_EXCEEDED, { limit });
        }
        await prisma.aiUsage.create({ data: { userId: user.id, kind } });
    } catch (error) {
        logger.error({ error, userId: user.id, kind }, "Failed to check AI quota");
    }
    return null;
}

/**
 * 在识别校验失败或未真正发起上游 AI 调用时释放之前原子预留的每日额度（最低扣至 0）
 */
export async function releaseAiQuota(userId: string, now = new Date()): Promise<void> {
    try {
        if (!hasAtomicQuotaSupport()) return;
        const dayKey = formatDateTime(now, "yyyy-MM-dd", getAppTimeZone());
        await prisma.$executeRaw`
            UPDATE "AiDailyQuota"
            SET "count" = CASE WHEN "count" > 0 THEN "count" - 1 ELSE 0 END,
                "updatedAt" = CURRENT_TIMESTAMP
            WHERE "userId" = ${userId} AND "dayKey" = ${dayKey}
        `;
    } catch (error) {
        logger.warn({ error, userId }, "Failed to release AI quota");
    }
}
