import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import type { NextRequest } from "next/server";
import { kidModeRestricted } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { KID_MODE_COOKIE_NAME, isApiAllowedInKidMode, isKidModeAllowedPagePath, verifyKidModeToken } from "@/lib/kid-mode-lock";
import { isPersona, landingPath } from "@/lib/personas";

const logger = createLogger('proxy');

const SESSION_COOKIE_NAME = "next-auth.session-token";

/** 旧会话没有该字段时也要进确认页；确认后 token 会带上 false */
function needsPersonaConfirm(token: { needsPersonaConfirmation?: boolean } | null): boolean {
    return token?.needsPersonaConfirmation !== false;
}

interface DbSessionState {
    revoked: boolean;
    disabled: boolean;
    personaConfirmed: boolean | null;
}

async function fetchDbSessionState(
    userId: string | undefined,
    tokenAuthVersion: number | undefined,
): Promise<DbSessionState | null> {
    if (!userId) return null;
    try {
        const { prisma } = await import("@/lib/prisma");
        const row = await prisma.user.findUnique({
            where: { id: userId },
            select: { personasConfirmedAt: true, isActive: true, authVersion: true },
        });
        if (row === null) {
            return { revoked: true, disabled: false, personaConfirmed: null };
        }
        if (!row) return null;
        const disabled = row.isActive === false;
        const revoked = typeof row.authVersion === "number" && (
            tokenAuthVersion !== undefined
                ? row.authVersion !== tokenAuthVersion
                : row.authVersion > 0
        );
        return {
            revoked,
            disabled,
            personaConfirmed: Boolean(row.personasConfirmedAt),
        };
    } catch {
        return null;
    }
}

function redirectToLoginClearingSession(req: NextRequest, callbackUrl?: string): NextResponse {
    const loginUrl = callbackUrl
        ? `/login?callbackUrl=${encodeURIComponent(callbackUrl)}`
        : "/login";
    const response = NextResponse.redirect(new URL(loginUrl, req.url));
    response.cookies.delete(SESSION_COOKIE_NAME);
    return response;
}

export async function proxy(req: NextRequest) {
    // 家长开启孩子专注做题锁时，在网关层统一拦截所有非白名单 API（包括未使用 defineApiRoute 的路由）；未带锁 Cookie 时零开销直通
    if (req.nextUrl.pathname.startsWith("/api/")) {
        const rawKidCookie = req.cookies.get(KID_MODE_COOKIE_NAME)?.value;
        if (!rawKidCookie) {
            return NextResponse.next();
        }
        try {
            const token = await getToken({
                req,
                secret: process.env.NEXTAUTH_SECRET,
                cookieName: SESSION_COOKIE_NAME,
            });
            if (token) {
                const kidLock = verifyKidModeToken(rawKidCookie, {
                    userId: typeof token.id === "string" ? token.id : undefined,
                    authVersion: typeof token.authVersion === "number" ? token.authVersion : undefined,
                });
                if (kidLock && !isApiAllowedInKidMode(req.nextUrl.pathname, req.method)) {
                    return kidModeRestricted();
                }
            }
        } catch {
            // 令牌解析失败时不阻断后续路由自身鉴权流程
        }
        return NextResponse.next();
    }

    // 页面请求的登录保护（Next.js 16 起由 middleware 更名为 proxy，运行在 Node.js 运行时）
    logger.debug({ method: req.method, path: req.nextUrl.pathname }, 'Processing request');

    // 免注册公开令牌页面（扫码交作业 / 单生批改反馈卡）直接放行，由页面内公开/半公开 API 做哈希令牌校验
    if (req.nextUrl.pathname.startsWith("/submit/") || req.nextUrl.pathname.startsWith("/share/")) {
        return NextResponse.next();
    }

    try {
        const token = await getToken({
            req,
            secret: process.env.NEXTAUTH_SECRET,
            cookieName: SESSION_COOKIE_NAME, // Explicitly look for the standardized cookie
        });

        const isAuth = !!token;
        // /initialize：全新安装时用一次性初始化链接创建管理员，未登录也要能打开
        const isAuthPage = ["/login", "/register", "/initialize"].some((prefix) => req.nextUrl.pathname.startsWith(prefix));
        const isAdminPage = req.nextUrl.pathname.startsWith("/admin");

        logger.debug({
            path: req.nextUrl.pathname,
            isAuth,
            isAuthPage,
            hasToken: !!token,
            cookies: req.cookies.getAll().map(c => c.name)
        }, 'Auth status');

        const tokenInvalidByClaim = isAuth && (token?.revoked === true || token?.isActive === false);
        const dbState = isAuth && !tokenInvalidByClaim
            ? await fetchDbSessionState(
                typeof token?.id === "string" ? token.id : undefined,
                typeof token?.authVersion === "number" ? token.authVersion : undefined,
            )
            : null;
        const sessionInvalidated = tokenInvalidByClaim || Boolean(dbState?.revoked || dbState?.disabled);

        if (isAuthPage) {
            if (isAuth) {
                if (sessionInvalidated) {
                    const res = NextResponse.next();
                    res.cookies.delete(SESSION_COOKIE_NAME);
                    return res;
                }
                if (token?.mustChangePassword) {
                    logger.debug('Redirecting authenticated user with default password to /setup');
                    return NextResponse.redirect(new URL("/setup", req.url));
                }
                if (needsPersonaConfirm(token) && !dbState?.personaConfirmed) {
                    logger.debug('Redirecting authenticated user to persona onboarding');
                    return NextResponse.redirect(new URL("/onboarding/persona", req.url));
                }
                const home = landingPath(isPersona(token?.activePersona) ? token.activePersona : null);
                logger.debug({ home }, 'Redirecting authenticated user away from auth page');
                return NextResponse.redirect(new URL(home, req.url));
            }
            return null;
        }

        if (!isAuth || sessionInvalidated) {
            let from = req.nextUrl.pathname;
            if (req.nextUrl.search) {
                from += req.nextUrl.search;
            }

            if (sessionInvalidated) {
                logger.info({ userId: token?.id, path: req.nextUrl.pathname }, 'Clearing revoked or disabled session');
                return redirectToLoginClearingSession(req, from);
            }

            logger.debug({ callbackUrl: from }, 'Redirecting unauthenticated user to login');
            return NextResponse.redirect(
                new URL(`/login?callbackUrl=${encodeURIComponent(from)}`, req.url)
            );
        }

        // 管理员仍使用默认密码时，所有页面都先跳到安装向导改密码
        const isSetupPage = req.nextUrl.pathname.startsWith("/setup");
        if (token?.mustChangePassword && !isSetupPage) {
            logger.info({ userId: token.id, path: req.nextUrl.pathname }, 'Redirecting admin with default password to /setup');
            return NextResponse.redirect(new URL("/setup", req.url));
        }

        const isPersonaOnboarding = req.nextUrl.pathname.startsWith("/onboarding");
        let personaConfirmed = !needsPersonaConfirm(token);
        if (!personaConfirmed && !isSetupPage) {
            if (dbState?.personaConfirmed) personaConfirmed = true;
        }
        if (!personaConfirmed && !isPersonaOnboarding && !isSetupPage) {
            logger.info({ userId: token.id, path: req.nextUrl.pathname }, 'Redirecting user to persona confirmation');
            return NextResponse.redirect(new URL("/onboarding/persona", req.url));
        }
        if (personaConfirmed && isPersonaOnboarding) {
            const home = landingPath(isPersona(token?.activePersona) ? token.activePersona : null);
            return NextResponse.redirect(new URL(home, req.url));
        }

        // 已确认身份时，按当前身份进入对应首页
        if (req.nextUrl.pathname === "/" && personaConfirmed && token?.activePersona) {
            const home = landingPath(isPersona(token?.activePersona) ? token.activePersona : null);
            if (home !== "/") {
                return NextResponse.redirect(new URL(home, req.url));
            }
        }

        // Admin route protection: only allow users with admin role
        if (isAdminPage && token?.role !== "admin") {
            logger.warn({ userId: token?.id, path: req.nextUrl.pathname }, 'Non-admin user attempting to access admin area');
            const home = landingPath(isPersona(token?.activePersona) ? token.activePersona : null);
            return NextResponse.redirect(new URL(home, req.url));
        }

        // 家长开启孩子专注做题模式时，服务端强制将非学习页面收敛重定向至对应孩子的学习路径页
        const rawKidCookie = req.cookies.get(KID_MODE_COOKIE_NAME)?.value;
        if (rawKidCookie) {
            const kidLock = verifyKidModeToken(rawKidCookie, {
                userId: typeof token?.id === "string" ? token.id : undefined,
                authVersion: typeof token?.authVersion === "number" ? token.authVersion : undefined,
            });
            if (kidLock) {
                if (!isKidModeAllowedPagePath(req.nextUrl.pathname)) {
                    return NextResponse.redirect(
                        new URL(`/learn?studentKey=${encodeURIComponent(kidLock.learnerId)}`, req.url),
                    );
                }
                if (req.nextUrl.pathname === "/learn") {
                    const reqKey = req.nextUrl.searchParams.get("studentKey") || req.nextUrl.searchParams.get("learnerId");
                    if (reqKey && reqKey !== kidLock.learnerId) {
                        const target = new URL(req.url);
                        target.searchParams.set("studentKey", kidLock.learnerId);
                        target.searchParams.delete("learnerId");
                        return NextResponse.redirect(target);
                    }
                }
            }
        }
    } catch (e) {
        // 无法确认登录状态时按未登录处理（失败即拒绝），否则会绕过强制改密和管理员页面的拦截
        logger.error({ error: e }, 'Error processing token');
        const path = req.nextUrl.pathname;
        if (["/login", "/register", "/initialize"].some((prefix) => path.startsWith(prefix))) {
            return NextResponse.next();
        }
        return NextResponse.redirect(
            new URL(`/login?callbackUrl=${encodeURIComponent(path + req.nextUrl.search)}`, req.url)
        );
    }
}

export const config = {
    matcher: [
        /*
         * Match all request paths except for the ones starting with:
         * - api (API routes)
         * - _next/static (static files)
         * - _next/image (image optimization files)
         * - favicon.ico (favicon file)
         * - icons/、manifest.webmanifest（PWA 图标与清单，登录页也要能加载）
         * - sw.js、offline.html（Service Worker 与离线页，未登录时也要能加载）
         */
        "/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest|sw.js|offline.html).*)",
    ],
};
