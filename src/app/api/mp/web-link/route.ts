import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, forbidden, kidModeRestricted, tooManyRequests } from "@/lib/api-errors";
import { KID_MODE_COOKIE_NAME, parseCookieValue } from "@/lib/kid-mode-lock";
import { createLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/rate-limit";
import { defineApiRoute } from "@/lib/server/api-route";
import { hashMiniProgramToken, readMiniProgramBearer } from "@/lib/server/mp-auth";
import { buildHandoffUrl, mintWebHandoff, webHandoffIpLimiter, webHandoffUserLimiter } from "@/lib/server/mp-web-handoff";

const logger = createLogger("api:mp:web-link");

const bodySchema = z.object({ path: z.string().min(1).max(256) }).strict();

/** 链接用的站点地址：优先 NEXTAUTH_URL（生产为 https 域名），否则用请求地址 */
function siteOrigin(req: Request): string {
    const configured = process.env.NEXTAUTH_URL?.trim();
    if (configured) {
        try {
            return new URL(configured).origin;
        } catch {
            // 配置无效时退回请求地址
        }
    }
    return new URL(req.url).origin;
}

/**
 * POST /api/mp/web-link { path }（只接受小程序 Bearer 令牌）：签发一次性网页登录链接，
 * 打开后以同一账号登录网页端并进入 path（错题详情或家长试卷详情）。约 5 分钟内有效、只能用一次。
 */
export const POST = defineApiRoute(
    { auth: "user", maxBodyBytes: 1024, bodySchema },
    async (req, { body, user }) => {
        const token = readMiniProgramBearer(req.headers.get("authorization"));
        if (!token) return forbidden("MP_TOKEN_REQUIRED");
        const mpSession = await prisma.miniProgramSession.findUnique({
            where: { tokenHash: hashMiniProgramToken(token) },
            select: { id: true, userId: true, authVersion: true, revokedAt: true, expiresAt: true },
        });
        if (!mpSession || mpSession.userId !== user.id || mpSession.revokedAt || mpSession.expiresAt.getTime() <= Date.now()) {
            return forbidden("MP_TOKEN_REQUIRED");
        }

        const ip = getClientIp(req.headers);
        const wait = Math.max(webHandoffUserLimiter.retryAfter(user.id), ip ? webHandoffIpLimiter.retryAfter(ip) : 0);
        if (wait > 0) return tooManyRequests(wait);
        webHandoffUserLimiter.hit(user.id);
        if (ip) webHandoffIpLimiter.hit(ip);

        const result = await mintWebHandoff(prisma, {
            userId: user.id,
            authVersion: mpSession.authVersion,
            mpSessionId: mpSession.id,
            nextPath: body.path,
            rawKidLock: parseCookieValue(req.headers.get("cookie"), KID_MODE_COOKIE_NAME),
        });
        if (!result.ok) {
            if (result.reason === "KID_MODE_RESTRICTED") return kidModeRestricted();
            return badRequest("BAD_TARGET");
        }
        logger.info({ userId: user.id }, "Web handoff link issued");
        return NextResponse.json(
            { url: buildHandoffUrl(siteOrigin(req), result.token, body.path), expiresAt: result.expiresAt.toISOString() },
            { headers: { "Cache-Control": "no-store" } },
        );
    },
);
