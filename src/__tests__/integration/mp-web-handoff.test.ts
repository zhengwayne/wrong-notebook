// @vitest-environment node
/**
 * 小程序「查看详情」一次性网页登录链接：只存摘要、5 分钟过期、只能用一次、绑定账号与目标页面、
 * 目标页面只允许站内相对路径、跨账号与吊销、签发限流、专注锁随链接带到网页端，
 * 以及兑换出的网页会话不能让仅微信账号设置邮箱或密码。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { decode } from 'next-auth/jwt';
import { getServerSession } from 'next-auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));

vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => null) }));
vi.mock('@/lib/auth', () => ({ authOptions: { cookies: { sessionToken: { options: { secure: true } } } } }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { POST as WEB_LINK } from '@/app/api/mp/web-link/route';
import { GET as HANDOFF } from '@/app/api/auth/mp-handoff/route';
import { PATCH as PATCH_USER } from '@/app/api/user/route';
import { isApiAllowedInKidMode, KID_MODE_COOKIE_NAME, signKidModeToken } from '@/lib/kid-mode-lock';
import { generateMiniProgramToken, hashMiniProgramToken } from '@/lib/server/mp-auth';
import {
    hashHandoffToken,
    normalizeHandoffNext,
    redeemWebHandoff,
    WEB_HANDOFF_TTL_MS,
    webHandoffUserLimiter,
} from '@/lib/server/mp-web-handoff';

const SECRET = 'test-nextauth-secret-for-handoff';
const SITE = 'https://xueji.example.com';
const WX_EMAIL = 'wx_abc@wechat.local';
let database: PrismaClient;
let directory: string;

async function mpToken(userId: string, authVersion = 0) {
    const token = generateMiniProgramToken();
    await database.miniProgramSession.create({
        data: {
            tokenHash: hashMiniProgramToken(token), userId, appId: 'wx-app', openid: `o-${userId}-${Math.random()}`,
            authVersion, expiresAt: new Date(Date.now() + 86400_000),
        },
    });
    return token;
}

function mint(token: string | null, path: string, extra: Record<string, string> = {}) {
    return WEB_LINK(new Request('http://localhost/api/mp/web-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
        body: JSON.stringify({ path }),
    }));
}

async function mintUrl(token: string, path: string, extra: Record<string, string> = {}) {
    const res = await mint(token, path, extra);
    expect(res.status).toBe(200);
    const body = await res.json();
    return new URL(body.url);
}

function redeem(url: URL | string) {
    const u = new URL(String(url));
    return HANDOFF(new Request(`http://localhost${u.pathname}${u.search}`));
}

function sessionCookie(res: Response): string | null {
    const all = res.headers.getSetCookie();
    const hit = all.find((c) => c.startsWith('next-auth.session-token='));
    return hit ? hit.split(';')[0].slice('next-auth.session-token='.length) : null;
}

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'wrong-notebook-handoff-'));
    const url = `file:${join(directory, 'test.db')}`;
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
    });
    database = new PrismaClient({ datasources: { db: { url } } });
    mocks.prisma = database;
}, 120000);

afterAll(async () => {
    await database?.$disconnect();
    if (directory) rmSync(directory, { recursive: true, force: true });
});

beforeEach(async () => {
    vi.stubEnv('NEXTAUTH_SECRET', SECRET);
    vi.stubEnv('NEXTAUTH_URL', SITE);
    vi.stubEnv('TRUST_PROXY', '');
    vi.mocked(getServerSession).mockReset().mockResolvedValue(null);
    webHandoffUserLimiter.reset('wx-1');
    webHandoffUserLimiter.reset('web-1');
    await database.webHandoffToken.deleteMany();
    await database.miniProgramSession.deleteMany();
    await database.user.deleteMany();
    await database.user.create({ data: { id: 'wx-1', email: WX_EMAIL, password: 'unusable-hash', name: '微信家长' } });
    await database.user.create({ data: { id: 'web-1', email: 'web@example.com', password: 'unusable-hash', personasConfirmedAt: new Date() } });
});

describe('目标页面校验（只允许站内相对路径）', () => {
    it('接受错题详情和家长试卷详情', () => {
        expect(normalizeHandoffNext('/error-items/cm123abc')).toBe('/error-items/cm123abc');
        expect(normalizeHandoffNext('/parent/papers/p_1-2')).toBe('/parent/papers/p_1-2');
        expect(normalizeHandoffNext('/grading')).toBe('/grading');
        expect(normalizeHandoffNext('/grading/t_1')).toBe('/grading/t_1');
        expect(normalizeHandoffNext('/grading/t_1/papers')).toBe('/grading/t_1/papers');
        expect(normalizeHandoffNext('/teacher')).toBe('/teacher');
        expect(normalizeHandoffNext('/help')).toBe('/help');
    });
    it.each([
        'https://evil.example/error-items/1', '//evil.example/error-items/1', '/\\evil.example', '/error-items/1?x=1',
        '/error-items/1#a', '/error-items/../admin', '/error-items/%2e%2e', '/admin', '/settings', '/error-items/',
        '/grading?tab=papers', '/grading/t1/submissions/s1', '/grading/', '/teacher/x', '/help/../admin',
        'javascript:alert(1)', '/error-items/a b', '/error-items/1\n', '', null, 42, `/error-items/${'a'.repeat(80)}`,
    ])('拒绝 %j', (value) => {
        expect(normalizeHandoffNext(value)).toBeNull();
    });
});

describe('签发 POST /api/mp/web-link', () => {
    it('只接受小程序令牌：网页会话、没有令牌都拒绝', async () => {
        expect((await mint(null, '/error-items/e1')).status).toBe(401);
        vi.mocked(getServerSession).mockResolvedValue({ user: { id: 'web-1', email: 'web@example.com' }, expires: '' } as never);
        expect((await mint(null, '/error-items/e1')).status).toBe(403);
        expect(await database.webHandoffToken.count()).toBe(0);
    });

    it('库里只存摘要，链接指向配置的站点并带上目标页面', async () => {
        const url = await mintUrl(await mpToken('wx-1'), '/error-items/e1');
        expect(url.origin).toBe(SITE);
        expect(url.pathname).toBe('/api/auth/mp-handoff');
        expect(url.searchParams.get('next')).toBe('/error-items/e1');
        const raw = url.searchParams.get('t')!;
        const row = await database.webHandoffToken.findFirstOrThrow();
        expect(row.tokenHash).toBe(hashHandoffToken(raw));
        expect(JSON.stringify(row)).not.toContain(raw);
        expect(row.userId).toBe('wx-1');
        expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(WEB_HANDOFF_TTL_MS);
    });

    it('拒绝站外或不允许的目标页面', async () => {
        const token = await mpToken('wx-1');
        for (const path of ['//evil.example', 'https://evil.example', '/settings', '/admin/users']) {
            expect((await mint(token, path)).status).toBe(400);
        }
    });

    it('签发限流：同一账号 10 分钟最多 10 次', async () => {
        const token = await mpToken('wx-1');
        for (let i = 0; i < 10; i++) expect((await mint(token, '/error-items/e1')).status).toBe(200);
        expect((await mint(token, '/error-items/e1')).status).toBe(429);
    });
});

describe('兑换 GET /api/auth/mp-handoff', () => {
    it('仅微信账号也能以同一账号登录网页，并跳到目标页面', async () => {
        const res = await redeem(await mintUrl(await mpToken('wx-1'), '/error-items/e1'));
        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe(`${SITE}/error-items/e1`);
        const raw = sessionCookie(res);
        expect(raw).toBeTruthy();
        const jwt = await decode({ token: raw!, secret: SECRET });
        expect(jwt).toMatchObject({ id: 'wx-1', sub: 'wx-1', email: WX_EMAIL, authVersion: 0, revoked: false, mustChangePassword: false, role: 'user' });
        const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('next-auth.session-token='))!;
        expect(setCookie).toMatch(/HttpOnly/i);
        expect(setCookie).toMatch(/SameSite=lax/i);
        expect(setCookie).toMatch(/Secure/i);
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('只能用一次：第二次跳到登录页且不发会话', async () => {
        const url = await mintUrl(await mpToken('wx-1'), '/error-items/e1');
        expect((await redeem(url)).status).toBe(303);
        const again = await redeem(url);
        expect(again.headers.get('location')).toBe(`${SITE}/login?handoff=expired`);
        expect(sessionCookie(again)).toBeNull();
    });

    it('并发兑换只有一个成功', async () => {
        const url = await mintUrl(await mpToken('wx-1'), '/error-items/e1');
        const results = await Promise.all([redeem(url), redeem(url), redeem(url)]);
        expect(results.filter((r) => sessionCookie(r)).length).toBe(1);
    });

    it('过期后无效', async () => {
        const url = await mintUrl(await mpToken('wx-1'), '/error-items/e1');
        const t = url.searchParams.get('t');
        const later = new Date(Date.now() + WEB_HANDOFF_TTL_MS + 1000);
        expect(await redeemWebHandoff(database, t, '/error-items/e1', later)).toEqual({ ok: false, reason: 'EXPIRED' });
        await database.webHandoffToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
        const res = await redeem(url);
        expect(res.headers.get('location')).toBe(`${SITE}/login?handoff=expired`);
        expect(sessionCookie(res)).toBeNull();
    });

    it('改了 next（换页面或站外地址）就作废，令牌也被消耗', async () => {
        const url = await mintUrl(await mpToken('wx-1'), '/error-items/e1');
        for (const next of ['/error-items/other', '//evil.example', 'https://evil.example/']) {
            const tampered = new URL(url);
            tampered.searchParams.set('next', next);
            const res = await redeem(tampered);
            expect(res.headers.get('location')).toBe(`${SITE}/login?handoff=expired`);
            expect(sessionCookie(res)).toBeNull();
        }
        expect(sessionCookie(await redeem(url))).toBeNull();
    });

    it('伪造或乱填的令牌无效', async () => {
        for (const t of ['', 'xjwh_nope', 'xjmp_abc', 'x'.repeat(500)]) {
            const res = await redeem(`${SITE}/api/auth/mp-handoff?t=${encodeURIComponent(t)}&next=/error-items/e1`);
            expect(res.headers.get('location')).toBe(`${SITE}/login?handoff=expired`);
        }
    });

    it('跨账号：A 签发的链接只会登录 A；即使篡改库里账号也因会话不匹配而作废', async () => {
        const urlA = await mintUrl(await mpToken('wx-1'), '/error-items/item-of-web-1');
        const jwt = await decode({ token: sessionCookie(await redeem(urlA))!, secret: SECRET });
        expect(jwt?.id).toBe('wx-1');

        const urlB = await mintUrl(await mpToken('wx-1'), '/error-items/e1');
        await database.webHandoffToken.updateMany({ where: { usedAt: null }, data: { userId: 'web-1' } });
        const res = await redeem(urlB);
        expect(sessionCookie(res)).toBeNull();
    });

    it('签发后改密（authVersion 变化）或退出小程序，链接作废', async () => {
        const token = await mpToken('wx-1');
        const url1 = await mintUrl(token, '/error-items/e1');
        await database.user.update({ where: { id: 'wx-1' }, data: { authVersion: 1 } });
        expect(sessionCookie(await redeem(url1))).toBeNull();

        await database.user.update({ where: { id: 'wx-1' }, data: { authVersion: 0 } });
        const url2 = await mintUrl(token, '/error-items/e1');
        await database.miniProgramSession.updateMany({ data: { revokedAt: new Date() } });
        expect(sessionCookie(await redeem(url2))).toBeNull();
    });

    it('禁用的账号不能兑换', async () => {
        const url = await mintUrl(await mpToken('wx-1'), '/error-items/e1');
        await database.user.update({ where: { id: 'wx-1' }, data: { isActive: false } });
        expect(sessionCookie(await redeem(url))).toBeNull();
    });
});

describe('孩子专注锁', () => {
    function kidCookie(userId = 'wx-1') {
        const lock = signKidModeToken({ userId, learnerId: 'kid-1', learnerName: '小宝', authVersion: 0, exp: Math.floor(Date.now() / 1000) + 3600 });
        return { lock, header: { cookie: `${KID_MODE_COOKIE_NAME}=${lock}` } };
    }

    it('签发和兑换接口在专注锁白名单里', () => {
        expect(isApiAllowedInKidMode('/api/mp/web-link', 'POST')).toBe(true);
        expect(isApiAllowedInKidMode('/api/auth/mp-handoff', 'GET')).toBe(true);
        expect(isApiAllowedInKidMode('/api/mp/web-link', 'GET')).toBe(false);
    });

    it('锁定时不能签发专注模式不允许的页面（家长试卷）', async () => {
        const { header } = kidCookie();
        expect((await mint(await mpToken('wx-1'), '/parent/papers/p1', header)).status).toBe(403);
    });

    it('锁定时签发错题详情，兑换后浏览器带上同一把锁', async () => {
        const { lock, header } = kidCookie();
        const res = await redeem(await mintUrl(await mpToken('wx-1'), '/error-items/e1', header));
        const kid = res.headers.getSetCookie().find((c) => c.startsWith(`${KID_MODE_COOKIE_NAME}=`));
        expect(kid).toContain(lock);
        expect(kid).toMatch(/HttpOnly/i);
    });

    it('未锁定时不写锁、也不清除浏览器里已有的锁；别人的锁不会被带上', async () => {
        const plain = await redeem(await mintUrl(await mpToken('wx-1'), '/error-items/e1'));
        expect(plain.headers.getSetCookie().some((c) => c.startsWith(`${KID_MODE_COOKIE_NAME}=`))).toBe(false);
        const { header } = kidCookie('web-1');
        const other = await redeem(await mintUrl(await mpToken('wx-1'), '/parent/papers/p1', header));
        expect(other.headers.getSetCookie().some((c) => c.startsWith(`${KID_MODE_COOKIE_NAME}=`))).toBe(false);
    });
});

describe('不重新打开“仅微信账号在网页端设邮箱/密码”的旁路', () => {
    it('兑换得到的网页会话里，仅微信账号仍不能设邮箱或密码', async () => {
        const res = await redeem(await mintUrl(await mpToken('wx-1'), '/error-items/e1'));
        const jwt = await decode({ token: sessionCookie(res)!, secret: SECRET });
        vi.mocked(getServerSession).mockResolvedValue({ user: { id: jwt!.id as string, email: jwt!.email as string }, expires: '' } as never);
        const patch = (body: unknown) => PATCH_USER(new Request('http://localhost/api/user', {
            method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        }));
        expect((await patch({ password: 'NewPass123!' })).status).toBe(403);
        expect((await patch({ email: 'mine@example.com' })).status).toBe(403);
        const user = await database.user.findUniqueOrThrow({ where: { id: 'wx-1' } });
        expect(user.email).toBe(WX_EMAIL);
        expect(user.password).toBe('unusable-hash');
        expect((await patch({ name: '新名字' })).status).toBe(200);
    });
});
