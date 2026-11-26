import { NextResponse } from "next/server";
import { encode } from "next-auth/jwt";
import { authOptions } from "@/lib/auth";
import { buildKidModeSetCookie, isRequestHttps, verifyKidModeToken } from "@/lib/kid-mode-lock";
import { createLogger } from "@/lib/logger";
import { isPersona, parsePersonas } from "@/lib/personas";
import { prisma } from "@/lib/prisma";
import { redeemWebHandoff } from "@/lib/server/mp-web-handoff";

const logger = createLogger("api:auth:mp-handoff");

const SESSION_COOKIE_NAME = "next-auth.session-token";
/** 与 NextAuth 默认一致：30 天 */
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 3600;

export const dynamic = "force-dynamic";

/** 跳转用的站点地址：优先 NEXTAUTH_URL，避免反向代理后拿到容器内地址 */
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

function noStore(res: NextResponse): NextResponse {
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
}

/**
 * GET /api/auth/mp-handoff?t=…&next=…：兑换小程序签发的一次性登录令牌，建立普通网页会话后跳到 next。
 * 链接失效（过期、已用过、被篡改、账号已改密或退出小程序）时跳到登录页并提示回小程序重新打开。
 */
export async function GET(req: Request): Promise<NextResponse> {
    const origin = siteOrigin(req);
    const url = new URL(req.url);
    const secret = process.env.NEXTAUTH_SECRET;
    const fail = (reason: string) => {
        logger.info({ reason }, "Web handoff rejected");
        return noStore(NextResponse.redirect(new URL("/login?handoff=expired", origin), 303));
    };
    if (!secret) return fail("NO_SECRET");

    const result = await redeemWebHandoff(prisma, url.searchParams.get("t"), url.searchParams.get("next"));
    if (!result.ok) return fail(result.reason);
    const { user, nextPath, kidLock } = result.value;

    const personas = parsePersonas(user.personas);
    const sessionToken = await encode({
        secret,
        maxAge: SESSION_MAX_AGE_SECONDS,
        // 与凭据登录后 jwt 回调写入的字段完全一致：普通网页会话，没有任何额外权限
        token: {
            name: user.name,
            email: user.email,
            sub: user.id,
            id: user.id,
            role: user.role,
            isActive: true,
            authVersion: user.authVersion,
            revoked: false,
            mustChangePassword: false,
            personas,
            activePersona: isPersona(user.activePersona) ? user.activePersona : null,
            needsPersonaConfirmation: !user.personasConfirmedAt,
        },
    });

    const res = NextResponse.redirect(new URL(nextPath, origin), 303);
    const cookieOptions = authOptions.cookies?.sessionToken?.options ?? {};
    res.cookies.set(SESSION_COOKIE_NAME, sessionToken, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: Boolean(cookieOptions.secure),
        maxAge: SESSION_MAX_AGE_SECONDS,
    });
    // 小程序处于孩子专注锁：浏览器也带上同一把锁（剩余时长不变），网页端按同样白名单限制；未锁定时不动浏览器里已有的锁
    if (kidLock) {
        const payload = verifyKidModeToken(kidLock, { userId: user.id, authVersion: user.authVersion });
        if (payload) {
            const remaining = payload.exp - Math.floor(Date.now() / 1000);
            res.headers.append("Set-Cookie", buildKidModeSetCookie(kidLock, isRequestHttps(req), remaining));
        }
    }
    logger.info({ userId: user.id, kidLock: Boolean(kidLock) }, "Web handoff session created");
    return noStore(res);
}
