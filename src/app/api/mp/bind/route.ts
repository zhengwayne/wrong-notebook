import { NextResponse } from "next/server";
import { compare } from "bcryptjs";
import { z } from "zod";
import { accountDisabled, conflict, createErrorResponse, ErrorCode, forbidden, tooManyRequests } from "@/lib/api-errors";
import { isDefaultAdminPassword } from "@/lib/default-admin";
import { findUserByEmailInsensitive, normalizeEmail } from "@/lib/email";
import { createLogger } from "@/lib/logger";
import { parsePersonas } from "@/lib/personas";
import { prisma } from "@/lib/prisma";
import { getClientIp, loginAccountLimiter, loginIpLimiter } from "@/lib/rate-limit";
import { defineApiRoute } from "@/lib/server/api-route";
import {
    getMiniProgramConfig,
    issueMiniProgramSession,
    toMiniProgramUserProfile,
    verifyBindTicket,
} from "@/lib/server/mp-auth";

const logger = createLogger("api:mp:bind");

const bodySchema = z.object({
    bindTicket: z.string().min(1).max(2048),
    email: z.string().trim().min(1).max(320),
    password: z.string().min(1).max(256),
});

/**
 * POST /api/mp/bind { bindTicket, email, password }：用现有账号密码把微信 openid 绑定到账号，只需一次。
 * 与网页登录共用账号和 IP 失败限流；仍在使用默认管理员密码的账号须先在网页端改密。
 */
export const POST = defineApiRoute(
    { auth: "public", maxBodyBytes: 4096, bodySchema },
    async (req, { body }) => {
        const config = getMiniProgramConfig();
        if (!config) {
            return createErrorResponse("MP_NOT_CONFIGURED", 503, ErrorCode.OPERATION_NOT_ALLOWED);
        }
        const ticket = verifyBindTicket(body.bindTicket, config.appId);
        if (!ticket) {
            return createErrorResponse("INVALID_BIND_TICKET", 400, ErrorCode.BAD_REQUEST);
        }

        const ip = getClientIp(req.headers);
        const accountKey = normalizeEmail(body.email);
        const wait = Math.max(loginAccountLimiter.retryAfter(accountKey), ip ? loginIpLimiter.retryAfter(ip) : 0);
        if (wait > 0) return tooManyRequests(wait);
        const recordFailure = () => {
            loginAccountLimiter.hit(accountKey);
            if (ip) loginIpLimiter.hit(ip);
        };

        const user = await findUserByEmailInsensitive(prisma, body.email);
        if (!user) {
            recordFailure();
            return createErrorResponse("INVALID_CREDENTIALS", 401, ErrorCode.UNAUTHORIZED);
        }
        if (!user.isActive) return accountDisabled();
        if (!(await compare(body.password, user.password))) {
            recordFailure();
            return createErrorResponse("INVALID_CREDENTIALS", 401, ErrorCode.UNAUTHORIZED);
        }
        loginAccountLimiter.reset(accountKey);
        if (isDefaultAdminPassword(user.role, body.password)) {
            return forbidden("MUST_CHANGE_PASSWORD");
        }

        const outcome = await prisma.$transaction(async (tx) => {
            const byOpenid = await tx.wechatBinding.findUnique({
                where: { appId_openid: { appId: config.appId, openid: ticket.openid } },
                select: { userId: true },
            });
            if (byOpenid && byOpenid.userId !== user.id) return "openid_taken" as const;
            if (!byOpenid) {
                // 账号此前绑定过另一个微信：改绑到当前微信，旧微信的小程序会话全部作废
                const previous = await tx.wechatBinding.findUnique({
                    where: { appId_userId: { appId: config.appId, userId: user.id } },
                    select: { id: true, openid: true },
                });
                if (previous) {
                    await tx.miniProgramSession.updateMany({
                        where: { userId: user.id, appId: config.appId, openid: previous.openid, revokedAt: null },
                        data: { revokedAt: new Date() },
                    });
                    await tx.wechatBinding.delete({ where: { id: previous.id } });
                }
                await tx.wechatBinding.create({
                    data: { appId: config.appId, openid: ticket.openid, unionid: ticket.unionid ?? null, userId: user.id, lastLoginAt: new Date() },
                });
            }
            return "bound" as const;
        });
        if (outcome === "openid_taken") {
            return conflict("WECHAT_ALREADY_BOUND");
        }

        const issued = await issueMiniProgramSession(prisma, {
            userId: user.id,
            authVersion: user.authVersion ?? 0,
            appId: config.appId,
            openid: ticket.openid,
        });
        logger.info({ userId: user.id }, "Mini program account bound");

        return NextResponse.json({
            status: "ok",
            token: issued.token,
            expiresAt: issued.expiresAt.toISOString(),
            user: toMiniProgramUserProfile(user, parsePersonas),
        });
    },
);
