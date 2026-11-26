import { NextResponse } from "next/server";
import { compare } from "bcryptjs";
import { z } from "zod";
import { accountDisabled, badRequest, conflict, createErrorResponse, ErrorCode, forbidden, tooManyRequests } from "@/lib/api-errors";
import { isDefaultAdminPassword } from "@/lib/default-admin";
import { findUserByEmailInsensitive, normalizeEmail } from "@/lib/email";
import { createLogger } from "@/lib/logger";
import { parsePersonas } from "@/lib/personas";
import { prisma } from "@/lib/prisma";
import { getClientIp, loginAccountLimiter, loginIpLimiter } from "@/lib/rate-limit";
import { defineApiRoute } from "@/lib/server/api-route";
import {
    countWechatAccountData,
    getMiniProgramConfig,
    hashMiniProgramToken,
    issueMiniProgramSession,
    readMiniProgramBearer,
    toMiniProgramUserProfile,
} from "@/lib/server/mp-auth";
import { isWechatPlaceholderEmail } from "@/lib/wechat-account";

const logger = createLogger("api:mp:bind");

const bodySchema = z.object({
    email: z.string().trim().min(1).max(320),
    password: z.string().min(1).max(256),
});

class LinkAbort extends Error {
    constructor(readonly reason: "HAS_DATA" | "OPENID_TAKEN" | "STALE", readonly detail?: Record<string, number>) {
        super(reason);
    }
}

/**
 * POST /api/mp/bind { email, password }（需小程序登录）：可选的“关联网页账号”。
 * 只允许仅微信登录的账号使用：校验网页账号的邮箱密码后，把当前微信改绑到网页账号，之后微信直接登录网页账号。
 * 安全规则：
 * - 仅微信账号里已有学习数据（错题、孩子、试卷等）时拒绝关联（409 WECHAT_ACCOUNT_HAS_DATA），不合并、不丢数据；
 * - 关联成功后删除这个空的仅微信账号（AI 用量记录迁到网页账号），作废它的全部小程序会话；
 * - 与网页登录共用账号和 IP 失败限流；仍在使用默认管理员密码的账号须先在网页端改密；
 * - 网页账号此前绑定过别的微信时改绑到当前微信，旧微信的小程序会话全部作废。
 */
export const POST = defineApiRoute(
    { auth: "user", maxBodyBytes: 4096, bodySchema },
    async (req, { body, user: current }) => {
        const config = getMiniProgramConfig();
        if (!config) {
            return createErrorResponse("MP_NOT_CONFIGURED", 503, ErrorCode.OPERATION_NOT_ALLOWED);
        }
        const token = readMiniProgramBearer(req.headers.get("authorization"));
        if (!token) return badRequest("MP_TOKEN_REQUIRED");
        const currentSession = await prisma.miniProgramSession.findUnique({
            where: { tokenHash: hashMiniProgramToken(token) },
            select: { userId: true, appId: true, openid: true },
        });
        if (!currentSession || currentSession.userId !== current.id || currentSession.appId !== config.appId) {
            return badRequest("MP_TOKEN_REQUIRED");
        }
        if (!isWechatPlaceholderEmail(current.email)) {
            return conflict("ALREADY_LINKED");
        }

        const ip = getClientIp(req.headers);
        const accountKey = normalizeEmail(body.email);
        const wait = Math.max(loginAccountLimiter.retryAfter(accountKey), ip ? loginIpLimiter.retryAfter(ip) : 0);
        if (wait > 0) return tooManyRequests(wait);
        const recordFailure = () => {
            loginAccountLimiter.hit(accountKey);
            if (ip) loginIpLimiter.hit(ip);
        };

        // 占位邮箱不是可登录的网页账号：与“账号不存在”同样处理
        const target = isWechatPlaceholderEmail(body.email) ? null : await findUserByEmailInsensitive(prisma, body.email);
        if (!target || isWechatPlaceholderEmail(target.email)) {
            recordFailure();
            return createErrorResponse("INVALID_CREDENTIALS", 401, ErrorCode.UNAUTHORIZED);
        }
        if (!target.isActive) return accountDisabled();
        if (!(await compare(body.password, target.password))) {
            recordFailure();
            return createErrorResponse("INVALID_CREDENTIALS", 401, ErrorCode.UNAUTHORIZED);
        }
        loginAccountLimiter.reset(accountKey);
        if (isDefaultAdminPassword(target.role, body.password)) {
            return forbidden("MUST_CHANGE_PASSWORD");
        }
        if (target.id === current.id) return conflict("ALREADY_LINKED");

        const { appId, openid } = currentSession;
        try {
            await prisma.$transaction(async (tx) => {
                // 先写一笔（作废这个微信账号的所有会话版本），让事务拿到 SQLite 写锁：
                // 之后到提交前其他请求都无法写入，数据检查与删除之间不会插入新数据；中途放弃时整笔回滚。
                await tx.user.update({ where: { id: current.id }, data: { authVersion: { increment: 1 } } });
                const data = await countWechatAccountData(tx, current.id);
                if (data.total > 0) throw new LinkAbort("HAS_DATA", data.detail);

                const binding = await tx.wechatBinding.findUnique({
                    where: { appId_openid: { appId, openid } },
                    select: { id: true, userId: true },
                });
                if (!binding) throw new LinkAbort("STALE");
                if (binding.userId !== current.id) throw new LinkAbort("OPENID_TAKEN");

                const previous = await tx.wechatBinding.findUnique({
                    where: { appId_userId: { appId, userId: target.id } },
                    select: { id: true, openid: true },
                });
                if (previous) {
                    await tx.miniProgramSession.updateMany({
                        where: { userId: target.id, appId, openid: previous.openid, revokedAt: null },
                        data: { revokedAt: new Date() },
                    });
                    await tx.wechatBinding.delete({ where: { id: previous.id } });
                }

                await tx.wechatBinding.update({
                    where: { id: binding.id },
                    data: { userId: target.id, lastLoginAt: new Date() },
                });
                await tx.aiUsage.updateMany({ where: { userId: current.id }, data: { userId: target.id } });
                // 每日已用次数合并到网页账号，避免关联后当天额度被「清零」
                const quotaRows = await tx.aiDailyQuota.findMany({ where: { userId: current.id }, select: { dayKey: true, count: true } });
                for (const row of quotaRows) {
                    if (row.count <= 0) continue;
                    await tx.aiDailyQuota.upsert({
                        where: { userId_dayKey: { userId: target.id, dayKey: row.dayKey } },
                        create: { userId: target.id, dayKey: row.dayKey, count: row.count },
                        update: { count: { increment: row.count } },
                    });
                }
                // 空的仅微信账号随之删除（会话、原有当日计数等随级联删除）
                await tx.user.delete({ where: { id: current.id } });
            });
        } catch (error) {
            if (error instanceof LinkAbort) {
                if (error.reason === "HAS_DATA") {
                    return createErrorResponse("WECHAT_ACCOUNT_HAS_DATA", 409, ErrorCode.CONFLICT, error.detail);
                }
                if (error.reason === "OPENID_TAKEN") return conflict("WECHAT_ALREADY_BOUND");
                return badRequest("MP_TOKEN_REQUIRED");
            }
            throw error;
        }

        const issued = await issueMiniProgramSession(prisma, {
            userId: target.id,
            authVersion: target.authVersion ?? 0,
            appId,
            openid,
        });
        logger.info({ fromUserId: current.id, userId: target.id }, "Mini program WeChat account linked to web account");

        return NextResponse.json({
            status: "ok",
            token: issued.token,
            expiresAt: issued.expiresAt.toISOString(),
            user: toMiniProgramUserProfile(target, parsePersonas),
        });
    },
);
