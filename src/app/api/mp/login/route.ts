import { NextResponse } from "next/server";
import { z } from "zod";
import { accountDisabled, createErrorResponse, ErrorCode, tooManyRequests } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { parsePersonas } from "@/lib/personas";
import { prisma } from "@/lib/prisma";
import { getClientIp, mpLoginIpLimiter } from "@/lib/rate-limit";
import { defineApiRoute } from "@/lib/server/api-route";
import {
    code2Session,
    getMiniProgramConfig,
    issueMiniProgramSession,
    MP_BIND_TICKET_TTL_SECONDS,
    signBindTicket,
    toMiniProgramUserProfile,
    WechatLoginError,
} from "@/lib/server/mp-auth";

const logger = createLogger("api:mp:login");

const bodySchema = z.object({ code: z.string().trim().min(1).max(128) });

/**
 * POST /api/mp/login { code }：wx.login 的 code 换 openid。
 * 已绑定账号时直接签发小程序会话；未绑定时返回 10 分钟有效的绑定凭证，前端用账号密码完成一次绑定。
 */
export const POST = defineApiRoute(
    { auth: "public", maxBodyBytes: 4096, bodySchema },
    async (req, { body }) => {
        const config = getMiniProgramConfig();
        if (!config) {
            return createErrorResponse("MP_NOT_CONFIGURED", 503, ErrorCode.OPERATION_NOT_ALLOWED);
        }

        const ip = getClientIp(req.headers);
        if (ip) {
            const wait = mpLoginIpLimiter.retryAfter(ip);
            if (wait > 0) return tooManyRequests(wait);
            mpLoginIpLimiter.hit(ip);
        }

        let wx;
        try {
            wx = await code2Session(config, body.code);
        } catch (error) {
            if (error instanceof WechatLoginError && error.code === "INVALID_CODE") {
                return createErrorResponse("INVALID_CODE", 400, ErrorCode.BAD_REQUEST);
            }
            logger.warn({ error: error instanceof Error ? error.message : String(error) }, "code2session failed");
            return createErrorResponse("WECHAT_UNAVAILABLE", 502, ErrorCode.INTERNAL_ERROR);
        }

        const binding = await prisma.wechatBinding.findUnique({
            where: { appId_openid: { appId: config.appId, openid: wx.openid } },
            select: {
                id: true,
                user: {
                    select: {
                        id: true, email: true, name: true, role: true, isActive: true, authVersion: true,
                        personas: true, activePersona: true, personasConfirmedAt: true,
                    },
                },
            },
        });

        if (!binding) {
            return NextResponse.json({
                status: "needs_bind",
                bindTicket: signBindTicket({ appId: config.appId, openid: wx.openid, ...(wx.unionid ? { unionid: wx.unionid } : {}) }),
                expiresIn: MP_BIND_TICKET_TTL_SECONDS,
            });
        }
        if (!binding.user.isActive) return accountDisabled();

        const issued = await issueMiniProgramSession(prisma, {
            userId: binding.user.id,
            authVersion: binding.user.authVersion ?? 0,
            appId: config.appId,
            openid: wx.openid,
        });
        await prisma.wechatBinding.update({ where: { id: binding.id }, data: { lastLoginAt: new Date() } });
        logger.info({ userId: binding.user.id }, "Mini program login");

        return NextResponse.json({
            status: "ok",
            token: issued.token,
            expiresAt: issued.expiresAt.toISOString(),
            user: toMiniProgramUserProfile(binding.user, parsePersonas),
        });
    },
);
