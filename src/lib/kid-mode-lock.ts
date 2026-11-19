import crypto from 'node:crypto';

// TODO(security): 当前系统采用自托管账号密码认证，暂不强制引入第三方 OAuth / MFA 及泄露密码在线库比对，已在设置页保留强密码校验与 authVersion 即时吊销机制。

export const KID_MODE_COOKIE_NAME = '__wn_kid_lock';
export const KID_MODE_DEFAULT_TTL_SECONDS = 12 * 3600;
export const PARENT_PIN_MAX_ATTEMPTS = 5;
export const PARENT_PIN_LOCKOUT_MS = 15 * 60 * 1000;

export interface KidModeLockPayload {
    userId: string;
    learnerId: string;
    learnerName: string;
    authVersion: number;
    exp: number;
}

function resolveSigningKey(explicit?: string): string | null {
    const envKey = explicit || process.env.NEXTAUTH_SECRET;
    if (envKey && envKey.length > 0) {
        return `kid-mode-v1:${envKey}`;
    }
    if (process.env.NODE_ENV !== 'production') {
        return `kid-mode-dev-ephemeral:${process.cwd()}`;
    }
    return null;
}

export function signKidModeToken(payload: KidModeLockPayload, explicitKey?: string): string {
    const key = resolveSigningKey(explicitKey);
    if (!key) {
        throw new Error('Missing signing key for kid mode lock');
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = crypto.createHmac('sha256', key).update(body).digest('base64url');
    return `${body}.${signature}`;
}

export function verifyKidModeToken(
    rawToken: string | undefined | null,
    expected?: { userId?: string; authVersion?: number },
    explicitKey?: string,
): KidModeLockPayload | null {
    if (!rawToken || typeof rawToken !== 'string') return null;
    const dotIndex = rawToken.indexOf('.');
    if (dotIndex <= 0 || dotIndex !== rawToken.lastIndexOf('.')) return null;

    const key = resolveSigningKey(explicitKey);
    if (!key) return null;

    const body = rawToken.slice(0, dotIndex);
    const sig = rawToken.slice(dotIndex + 1);
    const expectedSig = crypto.createHmac('sha256', key).update(body).digest('base64url');

    const sigBuf = Buffer.from(sig, 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return null;
    }

    try {
        const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<KidModeLockPayload>;
        if (
            typeof parsed.userId !== 'string' ||
            typeof parsed.learnerId !== 'string' ||
            typeof parsed.learnerName !== 'string' ||
            typeof parsed.authVersion !== 'number' ||
            typeof parsed.exp !== 'number'
        ) {
            return null;
        }
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (parsed.exp <= nowSeconds) return null;
        if (expected?.userId && parsed.userId !== expected.userId) return null;
        if (expected?.authVersion !== undefined && parsed.authVersion !== expected.authVersion) return null;

        return {
            userId: parsed.userId,
            learnerId: parsed.learnerId,
            learnerName: parsed.learnerName,
            authVersion: parsed.authVersion,
            exp: parsed.exp,
        };
    } catch {
        return null;
    }
}

export function isRequestHttps(req: Request): boolean {
    const proto = req.headers.get('x-forwarded-proto');
    if (proto) {
        return proto.split(',')[0].trim().toLowerCase() === 'https';
    }
    return req.url.startsWith('https://');
}

export function buildKidModeSetCookie(
    token: string,
    isHttps: boolean,
    maxAgeSeconds: number = KID_MODE_DEFAULT_TTL_SECONDS,
): string {
    const parts = [
        `${KID_MODE_COOKIE_NAME}=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.max(1, Math.floor(maxAgeSeconds))}`,
    ];
    if (isHttps) parts.push('Secure');
    return parts.join('; ');
}

export function buildKidModeClearCookie(isHttps: boolean): string {
    const parts = [
        `${KID_MODE_COOKIE_NAME}=`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=0',
    ];
    if (isHttps) parts.push('Secure');
    return parts.join('; ');
}

export function parseCookieValue(cookieHeader: string | null | undefined, name: string): string | null {
    if (!cookieHeader) return null;
    for (const pair of cookieHeader.split(';')) {
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const k = pair.slice(0, eq).trim();
        if (k === name) {
            return pair.slice(eq + 1).trim();
        }
    }
    return null;
}

export function getKidModeLockFromRequest(
    req: Request | undefined,
    expected?: { userId?: string; authVersion?: number },
): KidModeLockPayload | null {
    if (!req) return null;
    const raw = parseCookieValue(req.headers.get('cookie'), KID_MODE_COOKIE_NAME);
    return verifyKidModeToken(raw, expected);
}

/** 专注做题模式下允许访问的页面路径前缀 */
const ALLOWED_PAGE_PREFIXES = ['/learn', '/review', '/practice', '/login', '/register', '/initialize'];

export function isKidModeAllowedPagePath(pathname: string): boolean {
    return ALLOWED_PAGE_PREFIXES.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
}

/** 专注做题模式下允许调用的 API 路由规则（拒绝一切删题、切号、改设置、改 PIN 等写操作） */
export function isApiAllowedInKidMode(pathname: string, method: string): boolean {
    const upperMethod = method.toUpperCase();
    if (pathname === '/api/parent/kid-mode' && upperMethod === 'GET') return true;
    if (pathname === '/api/parent/kid-mode/unlock' && upperMethod === 'POST') return true;

    if (pathname === '/api/learning-path' && upperMethod === 'GET') return true;
    if (pathname.startsWith('/api/learning-path/steps/') && upperMethod === 'PATCH') return true;
    if (pathname === '/api/review/due' && upperMethod === 'GET') return true;

    if (
        (pathname === '/api/practice/generate' ||
            pathname === '/api/practice/grade' ||
            pathname === '/api/practice/record') &&
        upperMethod === 'POST'
    ) {
        return true;
    }

    if (pathname.startsWith('/api/variants/') && upperMethod === 'GET') return true;

    if (pathname.startsWith('/api/error-items/') && upperMethod === 'GET') return true;
    if (pathname.startsWith('/api/tts') && (upperMethod === 'GET' || upperMethod === 'POST')) return true;
    if (pathname.startsWith('/api/requests/') && upperMethod === 'GET') return true;
    if (pathname === '/api/logs/frontend' && upperMethod === 'POST') return true;
    if (pathname === '/api/system/snapshot-status' && upperMethod === 'GET') return true;
    if (pathname === '/api/health' || pathname === '/api/version') return true;

    return false;
}
