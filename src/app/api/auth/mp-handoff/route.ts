import { NextResponse } from "next/server";
import { encode } from "next-auth/jwt";
import { authOptions } from "@/lib/auth";
import { buildKidModeSetCookie, isRequestHttps, verifyKidModeToken } from "@/lib/kid-mode-lock";
import { createLogger } from "@/lib/logger";
import { isPersona, parsePersonas } from "@/lib/personas";
import { prisma } from "@/lib/prisma";
import { peekWebHandoff, redeemWebHandoff, WEB_HANDOFF_PATH } from "@/lib/server/mp-web-handoff";

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

/** 小程序 <web-view> 里的请求：微信在 UA 里带 miniProgram（安卓 / iOS / 开发者工具一致） */
function isMiniProgramWebView(req: Request): boolean {
    return /miniProgram/i.test(req.headers.get("user-agent") ?? "");
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
}

/**
 * 浏览器里打开时先显示确认页，点「继续打开」（POST）才兑换：聊天软件、浏览器的链接预览和预取只会 GET，
 * 不会把一次性链接用掉；也避免别人发来的链接在不知情时把浏览器登录成别人的账号（登录 CSRF）。
 */
function confirmPage(token: string, nextPath: string, accountLabel: string): NextResponse {
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>打开学迹</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F6F5FB;color:#2B2640;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.card{width:min(360px,calc(100% - 48px));padding:28px 24px;border-radius:16px;background:#fff;box-shadow:0 1px 3px rgba(43,38,64,.06)}
h1{margin:0 0 8px;font-size:20px}p{margin:0 0 20px;color:#8A8499;font-size:14px;line-height:1.6}
button{width:100%;height:44px;border:0;border-radius:22px;background:#6B5CA5;color:#fff;font-size:16px;cursor:pointer}</style></head>
<body><form class="card" method="post" action="${WEB_HANDOFF_PATH}"><h1>打开学迹</h1><p>将以小程序里的账号「${escapeHtml(accountLabel)}」登录网页端，并打开对应页面。不是你的账号请直接关闭。链接只能使用一次。</p>
<input type="hidden" name="t" value="${escapeHtml(token)}"><input type="hidden" name="next" value="${escapeHtml(nextPath)}"><button type="submit" id="handoff-continue">继续打开</button></form></body></html>`;
    const res = new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    res.headers.set("X-Robots-Tag", "noindex");
    return noStore(res);
}

function failResponse(origin: string, reason: string): NextResponse {
    logger.info({ reason }, "Web handoff rejected");
    return noStore(NextResponse.redirect(new URL("/login?handoff=expired", origin), 303));
}

/**
 * GET /api/auth/mp-handoff?t=…&next=…：
 * - 小程序 <web-view> 里：直接兑换小程序签发的一次性登录令牌，建立普通网页会话后跳到 next；
 * - 其他浏览器：只显示「继续打开」确认页，不消耗令牌（见 confirmPage）。
 * 链接失效（过期、已用过、被篡改、账号已改密或退出小程序）时跳到登录页并提示回小程序重新打开。
 */
export async function GET(req: Request): Promise<NextResponse> {
    const url = new URL(req.url);
    const token = url.searchParams.get("t");
    const next = url.searchParams.get("next");
    if (isMiniProgramWebView(req)) return redeemAndRespond(req, token, next);
    const peek = await peekWebHandoff(prisma, token, next);
    if (!peek.ok) return failResponse(siteOrigin(req), peek.reason);
    return confirmPage(token as string, peek.nextPath, peek.accountLabel);
}

/** POST（确认页表单）：t、next 与链接里的相同，兑换后跳转 */
export async function POST(req: Request): Promise<NextResponse> {
    let form: FormData;
    try {
        form = await req.formData();
    } catch {
        return failResponse(siteOrigin(req), "INVALID");
    }
    const token = form.get("t");
    const next = form.get("next");
    return redeemAndRespond(req, typeof token === "string" ? token : null, typeof next === "string" ? next : null);
}

async function redeemAndRespond(req: Request, token: string | null, next: string | null): Promise<NextResponse> {
    const origin = siteOrigin(req);
    const secret = process.env.NEXTAUTH_SECRET;
    const fail = (reason: string) => failResponse(origin, reason);
    if (!secret) return fail("NO_SECRET");

    const result = await redeemWebHandoff(prisma, token, next);
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
