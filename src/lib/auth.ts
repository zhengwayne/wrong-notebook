import { NextAuthOptions } from "next-auth"
import { PrismaAdapter } from "@next-auth/prisma-adapter"
import CredentialsProvider from "next-auth/providers/credentials"
import { prisma } from "@/lib/prisma"
import { compare } from "bcryptjs"
import { createLogger } from "@/lib/logger"
import { DEFAULT_ADMIN_PASSWORD, isDefaultAdminPassword } from "@/lib/default-admin"
import { TOO_MANY_ATTEMPTS } from "@/lib/auth-errors"
import { getClientIp, loginAccountLimiter, loginIpLimiter } from "@/lib/rate-limit"
import { isPersona, parsePersonas } from "@/lib/personas"
import { findUserByEmailInsensitive, normalizeEmail } from "@/lib/email"

const logger = createLogger('auth');


async function personaClaims(userId: string) {
    const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { personas: true, activePersona: true, personasConfirmedAt: true },
    })
    const personas = parsePersonas(row?.personas)
    const activePersona = isPersona(row?.activePersona) ? row.activePersona : null
    return {
        personas,
        activePersona,
        needsPersonaConfirmation: !row?.personasConfirmedAt,
    }
}

export const authOptions: NextAuthOptions = {
    adapter: PrismaAdapter(prisma),
    session: {
        strategy: "jwt",
    },
    // @ts-expect-error trustHost is a valid option in newer NextAuth versions but types might be lagging
    trustHost: true,
    pages: {
        signIn: "/login",
    },
    // Force using a single cookie name to avoid HTTP/HTTPS mismatches in proxy environments
    // This allows running without NEXTAUTH_URL behind Cloudflare Tunnel
    cookies: {
        sessionToken: {
            name: "next-auth.session-token",
            options: {
                httpOnly: true,
                sameSite: "lax",
                path: "/",
                // Only use secure cookies if explicitly running on HTTPS (via NEXTAUTH_URL)
                // This enables HTTP local IP access in Docker/Production if NEXTAUTH_URL is unset
                secure: process.env.NODE_ENV === "production" && process.env.NEXTAUTH_URL?.startsWith("https"),
            },
        },
    },
    providers: [
        CredentialsProvider({
            name: "Credentials",
            credentials: {
                email: { label: "Email", type: "email" },
                password: { label: "Password", type: "password" }
            },
            async authorize(credentials, req) {
                logger.debug({ email: credentials?.email }, 'Authorize called');
                if (!credentials?.email || !credentials?.password) {
                    logger.debug('Missing credentials');
                    return null
                }

                // 防暴力破解：账号或来源 IP 失败次数过多时，在校验密码前直接拒绝
                const ip = getClientIp(req?.headers);
                const accountKey = normalizeEmail(credentials.email);
                if (loginAccountLimiter.retryAfter(accountKey) > 0 || (ip && loginIpLimiter.retryAfter(ip) > 0)) {
                    logger.warn({ email: accountKey, ip }, 'Login locked after too many failed attempts');
                    throw new Error(TOO_MANY_ATTEMPTS)
                }
                const recordFailure = () => {
                    loginAccountLimiter.hit(accountKey);
                    if (ip) loginIpLimiter.hit(ip);
                };

                const user = await findUserByEmailInsensitive(prisma, credentials.email)

                if (!user) {
                    logger.debug('User not found');
                    recordFailure();
                    return null
                }

                // Check if user is active
                if (!user.isActive) {
                    logger.warn('User is disabled');
                    throw new Error("Account is disabled")
                }

                const isPasswordValid = await compare(credentials.password, user.password)

                if (!isPasswordValid) {
                    logger.debug('Invalid password');
                    recordFailure();
                    return null
                }

                loginAccountLimiter.reset(accountKey);

                logger.info({ email: user.email }, 'Login successful');

                const personas = parsePersonas(user.personas)
                const activePersona = isPersona(user.activePersona) ? user.activePersona : null
                return {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    role: user.role,
                    mustChangePassword: isDefaultAdminPassword(user.role, credentials.password),
                    personas,
                    activePersona,
                    needsPersonaConfirmation: !user.personasConfirmedAt,
                }
            }
        })
    ],
    // 仅在显式开启 NEXTAUTH_DEBUG=true 时输出 NextAuth 调试日志
    debug: process.env.NEXTAUTH_DEBUG === 'true',
    logger: {
        error(code, metadata) {
            logger.error({ code, metadata }, 'NextAuth error');
        },
        warn(code) {
            logger.warn({ code }, 'NextAuth warning');
        },
        debug(code, metadata) {
            logger.debug({ code, metadata }, 'NextAuth debug');
        }
    },
    callbacks: {
        async session({ session, token }) {
            logger.debug({ userId: token.id }, 'Session callback');
            return {
                ...session,
                user: {
                    ...session.user,
                    id: token.id,
                    role: token.role,
                    mustChangePassword: token.mustChangePassword === true,
                    personas: token.personas ?? [],
                    activePersona: token.activePersona ?? null,
                    needsPersonaConfirmation: token.needsPersonaConfirmation === true,
                }
            }
        },
        async jwt({ token, user, trigger }) {
            if (user) {
                logger.debug({ userId: user.id }, 'JWT callback - Initial signin');
                return {
                    ...token,
                    id: user.id,
                    role: user.role,
                    mustChangePassword: user.mustChangePassword === true,
                    personas: user.personas ?? [],
                    activePersona: user.activePersona ?? null,
                    needsPersonaConfirmation: user.needsPersonaConfirmation === true,
                }
            }
            // 客户端改完密码后调用 update()，以数据库中的密码为准重新判断，不信任客户端传值
            if (trigger === "update") {
                const next = { ...token }
                if (token.mustChangePassword) {
                    const dbUser = await prisma.user.findUnique({ where: { id: token.id }, select: { password: true } })
                    const stillDefault = !!dbUser && await compare(DEFAULT_ADMIN_PASSWORD, dbUser.password)
                    logger.info({ userId: token.id, stillDefault }, 'JWT callback - Re-checked default password')
                    next.mustChangePassword = stillDefault
                }
                if (token.id) {
                    const claims = await personaClaims(token.id)
                    Object.assign(next, claims)
                }
                return next
            }
            // 升级后已登录的旧 token 还没有身份字段，补一次，让现有账户看到确认页
            if (token.id && token.needsPersonaConfirmation === undefined) {
                try {
                    const claims = await personaClaims(token.id)
                    return { ...token, ...claims }
                } catch (error) {
                    logger.error({ error, userId: token.id }, 'JWT callback - Failed to load persona claims')
                }
            }
            logger.debug('JWT callback - Subsequent call');
            return token
        }
    }
}

// Log startup check
logger.info({
    NODE_ENV: process.env.NODE_ENV,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    HAS_SECRET: !!process.env.NEXTAUTH_SECRET,
    AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST
}, 'AuthConfig loading');
