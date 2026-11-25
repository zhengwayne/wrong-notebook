import { NextResponse } from "next/server";
import { z } from "zod";
import { accountDisabled, createErrorResponse, ErrorCode, forbidden, tooManyRequests } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { parsePersonas } from "@/lib/personas";
import { prisma } from "@/lib/prisma";
import { getClientIp, MP_SIGNUP_GLOBAL_KEY, mpLoginIpLimiter, mpSignupGlobalLimiter, mpSignupIpLimiter } from "@/lib/rate-limit";
import { defineApiRoute } from "@/lib/server/api-route";
import {
    code2Session,
    ensureMiniProgramAccount,
    getMiniProgramConfig,
    isMiniProgramAutoSignupEnabled,
    issueMiniProgramSession,
    toMiniProgramUserProfile,
    WechatLoginError,
} from "@/lib/server/mp-auth";

const logger = createLogger("api:mp:login");

const bodySchema = z.object({ code: z.string().trim().min(1).max(128) });

/**
 * POST /api/mp/login { code }：wx.login 的 code 换 openid，直接签发小程序会话。
 * 已绑定的微信登录到对应账号；未绑定的微信自动建一个仅微信登录的新账号（不需要邮箱和密码）。
 * 自动注册不受网页端 ALLOW_REGISTRATION 影响，可用 WECHAT_MP_AUTO_SIGNUP=false 关闭；建号按 IP 限流。
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

        let signupWait = 0;
        const account = await ensureMiniProgramAccount(
            prisma,
            { appId: config.appId, openid: wx.openid, ...(wx.unionid ? { unionid: wx.unionid } : {}) },
            {
                allowSignup: isMiniProgramAutoSignupEnabled(),
                beforeCreate: () => {
                    signupWait = Math.max(
                        mpSignupGlobalLimiter.retryAfter(MP_SIGNUP_GLOBAL_KEY),
                        ip ? mpSignupIpLimiter.retryAfter(ip) : 0,
                    );
                    if (signupWait > 0) return false;
                    mpSignupGlobalLimiter.hit(MP_SIGNUP_GLOBAL_KEY);
                    if (ip) mpSignupIpLimiter.hit(ip);
                    return true;
                },
            },
        );
        if (account.kind === "signup_disabled") {
            if (signupWait > 0) return tooManyRequests(signupWait);
            return forbidden("MP_SIGNUP_DISABLED");
        }
        if (!account.user.isActive) return accountDisabled();

        const issued = await issueMiniProgramSession(prisma, {
            userId: account.user.id,
            authVersion: account.user.authVersion ?? 0,
            appId: config.appId,
            openid: wx.openid,
        });
        if (account.bindingId) {
            await prisma.wechatBinding.update({ where: { id: account.bindingId }, data: { lastLoginAt: new Date() } });
        }
        logger.info({ userId: account.user.id, created: account.kind === "created" }, "Mini program login");

        return NextResponse.json({
            status: "ok",
            created: account.kind === "created",
            token: issued.token,
            expiresAt: issued.expiresAt.toISOString(),
            user: toMiniProgramUserProfile(account.user, parsePersonas),
        });
    },
);
