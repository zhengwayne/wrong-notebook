// @vitest-environment node
/**
 * 微信小程序登录与 Bearer 鉴权：微信一键登录自动建号（并发只建一个）、可选关联网页账号的规则、
 * 占位邮箱不能用于网页登录、令牌吊销、专注锁与跨账号 404、multipart 识别上传。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_PNG_BASE64 } from '../helpers/sample-images';

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    analyzeImage: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
// 网页 Cookie 会话始终为空：本文件只验证小程序 Bearer 链路
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => null) }));
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn(async () => null) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/ai', () => ({ getAIService: vi.fn(() => ({ analyzeImage: mocks.analyzeImage })) }));
vi.mock('@/lib/ai/tag-service', () => ({ getNotebookCandidateTags: vi.fn(async () => undefined) }));

import { POST as MP_LOGIN } from '@/app/api/mp/login/route';
import { POST as MP_BIND } from '@/app/api/mp/bind/route';
import { DELETE as MP_LOGOUT, GET as MP_SESSION } from '@/app/api/mp/session/route';
import { DELETE as MP_UNBIND, GET as MP_BINDING } from '@/app/api/mp/binding/route';
import { POST as MP_PROFILE } from '@/app/api/mp/profile/route';
import { PATCH as PATCH_USER } from '@/app/api/user/route';
import { POST as CREATE_LEARNER } from '@/app/api/learners/route';
import { GET as LIST_NOTEBOOKS } from '@/app/api/notebooks/route';
import { POST as MP_ANALYZE } from '@/app/api/mp/analyze/route';
import { GET as GET_STORED_REQUEST } from '@/app/api/requests/[id]/route';
import { GET as GET_ERROR_ITEM } from '@/app/api/error-items/[id]/route';
import { DELETE as CLEAR_ERRORS } from '@/app/api/error-items/clear/route';
import { GET as LIST_LEARNERS } from '@/app/api/learners/route';
import { GET as REVIEW_DUE } from '@/app/api/review/due/route';
import { isApiAllowedInKidMode, KID_MODE_COOKIE_NAME, signKidModeToken } from '@/lib/kid-mode-lock';
import { loginAccountLimiter, loginIpLimiter, MP_SIGNUP_GLOBAL_KEY, mpLoginIpLimiter, mpSignupGlobalLimiter, mpSignupIpLimiter } from '@/lib/rate-limit';
import {
    buildWechatPlaceholderEmail,
    code2Session,
    hashMiniProgramToken,
    readMiniProgramBearer,
    WechatLoginError,
} from '@/lib/server/mp-auth';
import { isWechatPlaceholderEmail } from '@/lib/wechat-account';
import { proxy } from '@/proxy';

const APP_ID = 'wx-test-app';
let database: PrismaClient;
let directory: string;
let nextOpenid = 'openid-parent';

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
    return new Request(`http://localhost${url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10', ...headers },
        body: JSON.stringify(body),
    });
}

function bearer(token: string, extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${token}`, ...extra };
}

async function wechatLogin(openid = nextOpenid) {
    nextOpenid = openid;
    const res = await MP_LOGIN(jsonRequest('/api/mp/login', { code: `code-${openid}` }));
    return { status: res.status, body: await res.json() };
}

/** 微信登录；若还是仅微信账号，则用网页账号关联（覆盖“可选关联”的主流程），返回网页账号的令牌 */
async function loginAndBind(email = 'parent@example.com', password = 'ParentPass123!') {
    const login = await wechatLogin();
    expect(login.status).toBe(200);
    if (!login.body.user.wechatOnly) return login.body.token as string;
    const bind = await MP_BIND(jsonRequest('/api/mp/bind', { email, password }, bearer(login.body.token)));
    expect(bind.status).toBe(200);
    return (await bind.json()).token as string;
}

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'wrong-notebook-mp-auth-'));
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
    vi.unstubAllGlobals();
    if (directory) rmSync(directory, { recursive: true, force: true });
});

beforeEach(async () => {
    vi.stubEnv('WECHAT_MP_APPID', APP_ID);
    vi.stubEnv('WECHAT_MP_APPSECRET', 'test-secret');
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
        expect(String(input)).toContain('api.weixin.qq.com/sns/jscode2session');
        return new Response(JSON.stringify({ openid: nextOpenid, session_key: 'never-stored' }), { status: 200 });
    }));
    nextOpenid = 'openid-parent';
    mocks.analyzeImage.mockReset();
    for (const key of ['parent@example.com', 'other@example.com', 'admin@localhost']) loginAccountLimiter.reset(key);
    loginIpLimiter.reset('203.0.113.10');
    mpLoginIpLimiter.reset('203.0.113.10');
    mpSignupIpLimiter.reset('203.0.113.10');
    mpSignupGlobalLimiter.reset(MP_SIGNUP_GLOBAL_KEY);
    vi.stubEnv('WECHAT_MP_AUTO_SIGNUP', '');
    vi.stubEnv('ALLOW_REGISTRATION', 'false');
    vi.stubEnv('TRUST_PROXY', '');

    await database.miniProgramSession.deleteMany();
    await database.wechatBinding.deleteMany();
    await database.errorItem.deleteMany();
    await database.learner.deleteMany();
    await database.aiUsage.deleteMany();
    await database.user.deleteMany();

    const passwordHash = await bcrypt.hash('ParentPass123!', 4);
    await database.user.create({
        data: {
            id: 'parent-1', email: 'parent@example.com', password: passwordHash,
            personas: JSON.stringify(['parent']), activePersona: 'parent', personasConfirmedAt: new Date(),
        },
    });
    await database.user.create({ data: { id: 'other-1', email: 'other@example.com', password: passwordHash } });
    await database.learner.create({ data: { id: 'child-a', userId: 'parent-1', kind: 'child', name: '小宝' } });
    await database.errorItem.create({ data: { id: 'err-own', userId: 'parent-1', learnerId: 'child-a', originalImageUrl: '', questionText: '1+1' } });
    await database.errorItem.create({ data: { id: 'err-other', userId: 'other-1', originalImageUrl: '', questionText: '2+2' } });
});

describe('mp-auth 工具函数', () => {
    it('只识别 xjmp_ 前缀的 Bearer 令牌', () => {
        expect(readMiniProgramBearer('Bearer xjmp_abc')).toBe('xjmp_abc');
        expect(readMiniProgramBearer('bearer xjmp_abc')).toBe('xjmp_abc');
        expect(readMiniProgramBearer('Bearer other-token')).toBeNull();
        expect(readMiniProgramBearer('Basic xjmp_abc')).toBeNull();
        expect(readMiniProgramBearer(`Bearer xjmp_${'a'.repeat(200)}`)).toBeNull();
        expect(readMiniProgramBearer(null)).toBeNull();
    });

    it('专注锁白名单只放行只读的 /api/mp/session', () => {
        expect(isApiAllowedInKidMode('/api/mp/session', 'GET')).toBe(true);
        expect(isApiAllowedInKidMode('/api/mp/session', 'DELETE')).toBe(false);
        expect(isApiAllowedInKidMode('/api/mp/binding', 'DELETE')).toBe(false);
        expect(isApiAllowedInKidMode('/api/mp/analyze', 'POST')).toBe(false);
        expect(isApiAllowedInKidMode('/api/mp/bind', 'POST')).toBe(false);
        expect(isApiAllowedInKidMode('/api/mp/profile', 'POST')).toBe(false);
    });

    it('code2session 区分无效 code 与微信不可用，且不返回 session_key', async () => {
        const config = { appId: APP_ID, appSecret: 's' };
        const ok = await code2Session(config, 'c', async () => new Response(JSON.stringify({ openid: 'o', unionid: 'u', session_key: 'k' })));
        expect(ok).toEqual({ openid: 'o', unionid: 'u' });
        await expect(code2Session(config, 'c', async () => new Response(JSON.stringify({ errcode: 40029, errmsg: 'invalid code' }))))
            .rejects.toMatchObject({ code: 'INVALID_CODE' });
        await expect(code2Session(config, 'c', async () => new Response(JSON.stringify({ errcode: -1 }))))
            .rejects.toMatchObject({ code: 'WECHAT_UNAVAILABLE' });
        await expect(code2Session(config, 'c', async () => new Response('bad gateway', { status: 502 })))
            .rejects.toBeInstanceOf(WechatLoginError);
        await expect(code2Session(config, 'c', async () => { throw new Error('network'); }))
            .rejects.toMatchObject({ code: 'WECHAT_UNAVAILABLE' });
    });
});

describe('/api/mp/login 微信一键登录（自动建号）', () => {
    it('未配置 AppID/AppSecret 时返回 503', async () => {
        vi.stubEnv('WECHAT_MP_APPSECRET', '');
        const res = await MP_LOGIN(jsonRequest('/api/mp/login', { code: 'c' }));
        expect(res.status).toBe(503);
        expect((await res.json()).message).toBe('MP_NOT_CONFIGURED');
    });

    it('第一次登录直接建一个仅微信账号并签发令牌（网页端关闭注册也不影响）；再次登录进入同一账号', async () => {
        const usersBefore = await database.user.count();
        const first = await wechatLogin('openid-new');
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ status: 'ok', created: true });
        expect(first.body.token).toMatch(/^xjmp_/);
        expect(first.body.user).toMatchObject({ wechatOnly: true, email: null, personasConfirmed: false, role: 'user' });
        expect(first.body.user.name).toMatch(/^微信用户[0-9A-F]{4}$/);
        expect(JSON.stringify(first.body)).not.toContain('openid-new');
        expect(JSON.stringify(first.body)).not.toContain('wechat.local');

        const row = await database.user.findUniqueOrThrow({ where: { id: first.body.user.id } });
        expect(row.email).toBe(buildWechatPlaceholderEmail(APP_ID, 'openid-new'));
        expect(isWechatPlaceholderEmail(row.email)).toBe(true);
        expect(row.password).toMatch(/^\$2[aby]\$/);
        expect(await bcrypt.compare('', row.password)).toBe(false);
        expect(await database.user.count()).toBe(usersBefore + 1);

        const stored = await database.miniProgramSession.findFirstOrThrow({ where: { userId: row.id } });
        expect(stored.tokenHash).toBe(hashMiniProgramToken(first.body.token));
        expect(JSON.stringify(stored)).not.toContain(first.body.token);

        const again = await wechatLogin('openid-new');
        expect(again.body).toMatchObject({ status: 'ok', created: false });
        expect(again.body.user.id).toBe(row.id);
        expect(again.body.token).not.toBe(first.body.token);
        expect(await database.user.count()).toBe(usersBefore + 1);

        // 新账号可以正常使用现有接口（会话、孩子列表）
        const session = await MP_SESSION(new Request('http://localhost/api/mp/session', { headers: bearer(again.body.token) }));
        expect(session.status).toBe(200);
        expect((await LIST_LEARNERS(new Request('http://localhost/api/learners', { headers: bearer(again.body.token) }))).status).toBe(200);
    });

    it('同一微信并发登录只建一个账号、一条绑定', async () => {
        nextOpenid = 'openid-race';
        const results = await Promise.all(
            Array.from({ length: 6 }, (_, i) => MP_LOGIN(jsonRequest('/api/mp/login', { code: `race-${i}` }))),
        );
        const bodies = await Promise.all(results.map((res) => res.json()));
        expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200, 200, 200]);
        expect(new Set(bodies.map((body) => body.user.id)).size).toBe(1);
        expect(bodies.filter((body) => body.created).length).toBe(1);
        expect(await database.user.count({ where: { email: buildWechatPlaceholderEmail(APP_ID, 'openid-race') } })).toBe(1);
        expect(await database.wechatBinding.count({ where: { openid: 'openid-race' } })).toBe(1);
        expect(await database.miniProgramSession.count({ where: { openid: 'openid-race' } })).toBe(6);
    });

    it('绑定记录丢失时按占位邮箱挂回原账号，不重复建号', async () => {
        const first = await wechatLogin('openid-orphan');
        await database.wechatBinding.deleteMany({ where: { openid: 'openid-orphan' } });
        const again = await wechatLogin('openid-orphan');
        expect(again.status).toBe(200);
        expect(again.body.user.id).toBe(first.body.user.id);
        expect(again.body.created).toBe(false);
        expect(await database.wechatBinding.count({ where: { openid: 'openid-orphan' } })).toBe(1);
    });

    it('WECHAT_MP_AUTO_SIGNUP=false 时不建号（403），已有绑定照常登录', async () => {
        const existing = await wechatLogin('openid-before');
        vi.stubEnv('WECHAT_MP_AUTO_SIGNUP', 'false');
        const usersBefore = await database.user.count();
        const blocked = await wechatLogin('openid-blocked');
        expect(blocked.status).toBe(403);
        expect(blocked.body.message).toBe('MP_SIGNUP_DISABLED');
        expect(await database.user.count()).toBe(usersBefore);
        const ok = await wechatLogin('openid-before');
        expect(ok.status).toBe(200);
        expect(ok.body.user.id).toBe(existing.body.user.id);
    });

    it('同一 IP 建号过多时返回 429，老用户登录不受影响', async () => {
        vi.stubEnv('TRUST_PROXY', 'true');
        const existing = await wechatLogin('openid-regular');
        for (let i = 0; i < 25; i += 1) mpSignupIpLimiter.hit('203.0.113.10');
        const limited = await wechatLogin('openid-flood');
        expect(limited.status).toBe(429);
        expect(await database.user.count({ where: { email: buildWechatPlaceholderEmail(APP_ID, 'openid-flood') } })).toBe(0);
        const ok = await wechatLogin('openid-regular');
        expect(ok.status).toBe(200);
        expect(ok.body.user.id).toBe(existing.body.user.id);
    });

    it('取不到来源 IP 时有全站建号上限兜底', async () => {
        vi.stubEnv('TRUST_PROXY', '');
        for (let i = 0; i < 300; i += 1) mpSignupGlobalLimiter.hit(MP_SIGNUP_GLOBAL_KEY);
        expect((await wechatLogin('openid-global')).status).toBe(429);
    });

    it('禁用的账号无法用微信登录', async () => {
        const { body } = await wechatLogin('openid-disabled');
        await database.user.update({ where: { id: body.user.id }, data: { isActive: false } });
        expect((await wechatLogin('openid-disabled')).status).toBe(401);
    });

    it('可以改显示名称；空名字被拒绝', async () => {
        const { body } = await wechatLogin('openid-name');
        const ok = await MP_PROFILE(jsonRequest('/api/mp/profile', { name: '  小明妈妈 ' }, bearer(body.token)));
        expect(ok.status).toBe(200);
        expect((await ok.json()).user).toMatchObject({ name: '小明妈妈', wechatOnly: true, email: null });
        expect((await MP_PROFILE(jsonRequest('/api/mp/profile', { name: '   ' }, bearer(body.token)))).status).toBe(400);
        expect((await MP_PROFILE(jsonRequest('/api/mp/profile', { name: '小明' }))).status).toBe(401);
    });
});

describe('占位邮箱不能用于网页登录', () => {
    function patchUser(token: string, data: unknown) {
        return PATCH_USER(new Request('http://localhost/api/user', {
            method: 'PATCH',
            headers: bearer(token, { 'content-type': 'application/json' }),
            body: JSON.stringify(data),
        }));
    }

    it('仅微信账号不能自行设邮箱或密码（不绕过网页注册开关），改名字等其他设置照常', async () => {
        const { body } = await wechatLogin('openid-upgrade');
        const before = await database.user.findUniqueOrThrow({ where: { id: body.user.id } });
        for (const payload of [{ password: 'NewPass123!' }, { email: 'mom@example.com' }, { email: 'mom@example.com', password: 'NewPass123!' }]) {
            const res = await patchUser(body.token, payload);
            expect(res.status).toBe(403);
            expect((await res.json()).message).toBe('WECHAT_ONLY_ACCOUNT');
        }
        const after = await database.user.findUniqueOrThrow({ where: { id: body.user.id } });
        expect(after.email).toBe(before.email);
        expect(after.password).toBe(before.password);

        const rename = await patchUser(body.token, { name: '小明爸爸' });
        expect(rename.status).toBe(200);
        expect((await database.user.findUniqueOrThrow({ where: { id: body.user.id } })).name).toBe('小明爸爸');
    });

    it('任何账号都不能把邮箱改成 wechat.local 域名', async () => {
        const token = await loginAndBind();
        const res = await patchUser(token, { email: 'someone@WeChat.Local' });
        expect(res.status).toBe(400);
        expect((await database.user.findUniqueOrThrow({ where: { id: 'parent-1' } })).email).toBe('parent@example.com');
    });

    it('用占位邮箱关联网页账号按账号不存在处理', async () => {
        const victim = await wechatLogin('openid-victim');
        const attacker = await wechatLogin('openid-attacker');
        const placeholder = buildWechatPlaceholderEmail(APP_ID, 'openid-victim');
        const res = await MP_BIND(jsonRequest('/api/mp/bind', { email: placeholder, password: 'x' }, bearer(attacker.body.token)));
        expect(res.status).toBe(401);
        expect((await res.json()).message).toBe('INVALID_CREDENTIALS');
        expect(await database.user.count({ where: { id: victim.body.user.id } })).toBe(1);
    });
});

describe('/api/mp/bind 可选关联网页账号', () => {
    it('需要小程序登录；密码错误 401', async () => {
        expect((await MP_BIND(jsonRequest('/api/mp/bind', { email: 'parent@example.com', password: 'ParentPass123!' }))).status).toBe(401);
        const { body } = await wechatLogin();
        const wrong = await MP_BIND(jsonRequest('/api/mp/bind', { email: 'parent@example.com', password: 'nope' }, bearer(body.token)));
        expect(wrong.status).toBe(401);
        expect(await database.user.count({ where: { id: body.user.id } })).toBe(1);
    });

    it('空的微信账号关联成功：微信改绑到网页账号，空账号删除，旧令牌失效，AI 用量迁移，再次微信登录直接进网页账号', async () => {
        const { body } = await wechatLogin();
        const wxUserId = body.user.id as string;
        await database.aiUsage.create({ data: { userId: wxUserId, kind: 'analyze' } });
        await database.learner.create({ data: { userId: wxUserId, kind: 'self', name: '我自己' } });
        // 打开错题本会自动建空白默认错题本，不算数据
        const notebooks = await LIST_NOTEBOOKS(new Request('http://localhost/api/notebooks', { headers: bearer(body.token) }));
        expect(notebooks.status).toBe(200);
        expect(await database.subject.count({ where: { userId: wxUserId } })).toBeGreaterThan(0);

        const res = await MP_BIND(jsonRequest('/api/mp/bind', { email: 'PARENT@example.com', password: 'ParentPass123!' }, bearer(body.token)));
        expect(res.status).toBe(200);
        const linked = await res.json();
        expect(linked.token).toMatch(/^xjmp_/);
        expect(linked.user).toMatchObject({ id: 'parent-1', wechatOnly: false, email: 'parent@example.com', personas: ['parent'] });

        expect(await database.user.count({ where: { id: wxUserId } })).toBe(0);
        expect(await database.aiUsage.count({ where: { userId: 'parent-1' } })).toBe(1);
        expect(await database.wechatBinding.findFirst({ where: { openid: 'openid-parent' } })).toMatchObject({ userId: 'parent-1' });
        expect((await MP_SESSION(new Request('http://localhost/api/mp/session', { headers: bearer(body.token) }))).status).toBe(401);
        expect((await MP_SESSION(new Request('http://localhost/api/mp/session', { headers: bearer(linked.token) }))).status).toBe(200);
        expect(await database.errorItem.count({ where: { userId: 'parent-1' } })).toBe(1);
        expect(await database.subject.count({ where: { userId: wxUserId } })).toBe(0);

        const again = await wechatLogin();
        expect(again.body).toMatchObject({ created: false });
        expect(again.body.user.id).toBe('parent-1');
    });

    it('微信账号里已有数据（孩子或错题）时拒绝关联，什么都不改', async () => {
        const { body } = await wechatLogin();
        await database.user.update({ where: { id: body.user.id }, data: { personas: JSON.stringify(['parent']), activePersona: 'parent', personasConfirmedAt: new Date() } });
        const created = await CREATE_LEARNER(jsonRequest('/api/learners', { name: '小宝' }, bearer(body.token)));
        expect(created.status).toBeLessThan(300);

        const res = await MP_BIND(jsonRequest('/api/mp/bind', { email: 'parent@example.com', password: 'ParentPass123!' }, bearer(body.token)));
        expect(res.status).toBe(409);
        const payload = await res.json();
        expect(payload.message).toBe('WECHAT_ACCOUNT_HAS_DATA');
        expect(payload.details.childLearners).toBe(1);

        expect(await database.user.count({ where: { id: body.user.id } })).toBe(1);
        expect(await database.learner.count({ where: { userId: body.user.id } })).toBe(1);
        expect(await database.wechatBinding.findFirst({ where: { openid: 'openid-parent' } })).toMatchObject({ userId: body.user.id });
        expect((await MP_SESSION(new Request('http://localhost/api/mp/session', { headers: bearer(body.token) }))).status).toBe(200);

        // 自己建的错题本（即使是空的）也算数据
        const { body: nb } = await wechatLogin('openid-with-notebook');
        await database.subject.create({ data: { userId: nb.user.id, name: '物理错题' } });
        const nbBlocked = await MP_BIND(jsonRequest('/api/mp/bind', { email: 'parent@example.com', password: 'ParentPass123!' }, bearer(nb.token)));
        expect(nbBlocked.status).toBe(409);
        expect((await nbBlocked.json()).details.subjects).toBe(1);

        // 错题同样算数据
        const { body: other } = await wechatLogin('openid-with-item');
        await database.errorItem.create({ data: { userId: other.user.id, originalImageUrl: '', questionText: '3+3' } });
        const blocked = await MP_BIND(jsonRequest('/api/mp/bind', { email: 'parent@example.com', password: 'ParentPass123!' }, bearer(other.token)));
        expect(blocked.status).toBe(409);
        expect(await database.errorItem.count({ where: { userId: other.user.id } })).toBe(1);
    });

    it('已是网页账号再调用返回 409 ALREADY_LINKED', async () => {
        const token = await loginAndBind();
        const res = await MP_BIND(jsonRequest('/api/mp/bind', { email: 'other@example.com', password: 'ParentPass123!' }, bearer(token)));
        expect(res.status).toBe(409);
        expect((await res.json()).message).toBe('ALREADY_LINKED');
    });

    it('网页账号之前绑过别的微信：改绑到当前微信，旧微信的会话全部作废', async () => {
        const oldPhoneToken = await loginAndBind();
        const { body } = await wechatLogin('openid-new-phone');
        const res = await MP_BIND(jsonRequest('/api/mp/bind', { email: 'parent@example.com', password: 'ParentPass123!' }, bearer(body.token)));
        expect(res.status).toBe(200);
        expect((await MP_SESSION(new Request('http://localhost/api/mp/session', { headers: bearer(oldPhoneToken) }))).status).toBe(401);
        const bindings = await database.wechatBinding.findMany({ where: { userId: 'parent-1' } });
        expect(bindings.map((b) => b.openid)).toEqual(['openid-new-phone']);
        // 旧微信再登录会变成一个新的仅微信账号，不会进入网页账号
        const oldPhone = await wechatLogin('openid-parent');
        expect(oldPhone.body.user.wechatOnly).toBe(true);
        expect(oldPhone.body.user.id).not.toBe('parent-1');
    });

    it('仍在使用默认管理员密码时拒绝关联，要求先在网页端改密', async () => {
        await database.user.create({ data: { id: 'admin-1', email: 'admin@localhost', role: 'admin', password: await bcrypt.hash('123456', 4) } });
        const { body } = await wechatLogin('openid-admin');
        const res = await MP_BIND(jsonRequest('/api/mp/bind', { email: 'admin@localhost', password: '123456' }, bearer(body.token)));
        expect(res.status).toBe(403);
        expect((await res.json()).message).toBe('MUST_CHANGE_PASSWORD');
        expect(await database.wechatBinding.count({ where: { userId: 'admin-1' } })).toBe(0);
    });

    it('禁用的网页账号无法关联', async () => {
        await database.user.update({ where: { id: 'parent-1' }, data: { isActive: false } });
        const { body } = await wechatLogin();
        const res = await MP_BIND(jsonRequest('/api/mp/bind', { email: 'parent@example.com', password: 'ParentPass123!' }, bearer(body.token)));
        expect(res.status).not.toBe(200);
        expect(await database.user.count({ where: { id: body.user.id } })).toBe(1);
    });
});

describe('Bearer 令牌访问现有接口', () => {
    it('令牌可访问本人数据，访问他人错题与网页端同样被拒（403），他人孩子不出现，未带令牌返回 401', async () => {
        const token = await loginAndBind();
        const learners = await LIST_LEARNERS(new Request('http://localhost/api/learners', { headers: bearer(token) }));
        expect(learners.status).toBe(200);
        expect((await learners.json()).children.map((c: { id: string }) => c.id)).toEqual(['child-a']);

        const own = await GET_ERROR_ITEM(new Request('http://localhost/api/error-items/err-own', { headers: bearer(token) }), { params: Promise.resolve({ id: 'err-own' }) });
        expect(own.status).toBe(200);
        const other = await GET_ERROR_ITEM(new Request('http://localhost/api/error-items/err-other', { headers: bearer(token) }), { params: Promise.resolve({ id: 'err-other' }) });
        expect(other.status).toBe(403);
        await database.learner.create({ data: { id: 'child-other', userId: 'other-1', kind: 'child', name: '别人家孩子' } });
        const foreignLearner = await REVIEW_DUE(new Request('http://localhost/api/review/due?learnerId=child-other', { headers: bearer(token) }));
        expect(foreignLearner.status).toBe(404);

        expect((await LIST_LEARNERS(new Request('http://localhost/api/learners'))).status).toBe(401);
        expect((await LIST_LEARNERS(new Request('http://localhost/api/learners', { headers: bearer('xjmp_unknown') }))).status).toBe(401);
    });

    it('改密（authVersion 变化）后令牌立即失效', async () => {
        const token = await loginAndBind();
        await database.user.update({ where: { id: 'parent-1' }, data: { authVersion: { increment: 1 } } });
        const res = await MP_SESSION(new Request('http://localhost/api/mp/session', { headers: bearer(token) }));
        expect(res.status).toBe(401);
        expect((await res.json()).code).toBe('SESSION_REVOKED');
    });

    it('过期令牌按未登录处理', async () => {
        const token = await loginAndBind();
        await database.miniProgramSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
        const res = await MP_SESSION(new Request('http://localhost/api/mp/session', { headers: bearer(token) }));
        expect(res.status).toBe(401);
        expect((await res.json()).code).toBe('UNAUTHORIZED');
    });

    it('仅微信账号不能解绑（解绑后就进不来了），绑定保持不变', async () => {
        const { body } = await wechatLogin('openid-only');
        const res = await MP_UNBIND(new Request('http://localhost/api/mp/binding', { method: 'DELETE', headers: bearer(body.token) }));
        expect(res.status).toBe(409);
        expect((await res.json()).message).toBe('WECHAT_ONLY_ACCOUNT');
        expect(await database.wechatBinding.count({ where: { openid: 'openid-only' } })).toBe(1);
        const binding = await MP_BINDING(new Request('http://localhost/api/mp/binding', { headers: bearer(body.token) }));
        expect(await binding.json()).toMatchObject({ bound: true, wechatOnly: true });
    });

    it('退出只作废当前令牌；解绑作废全部令牌并删除绑定', async () => {
        const tokenA = await loginAndBind();
        const tokenB = await loginAndBind();
        const logout = await MP_LOGOUT(new Request('http://localhost/api/mp/session', { method: 'DELETE', headers: bearer(tokenA) }));
        expect(logout.status).toBe(200);
        expect((await MP_SESSION(new Request('http://localhost/api/mp/session', { headers: bearer(tokenA) }))).status).toBe(401);
        expect((await MP_SESSION(new Request('http://localhost/api/mp/session', { headers: bearer(tokenB) }))).status).toBe(200);

        const binding = await MP_BINDING(new Request('http://localhost/api/mp/binding', { headers: bearer(tokenB) }));
        expect(await binding.json()).toMatchObject({ configured: true, bound: true });
        const unbind = await MP_UNBIND(new Request('http://localhost/api/mp/binding', { method: 'DELETE', headers: bearer(tokenB) }));
        expect(unbind.status).toBe(200);
        expect((await MP_SESSION(new Request('http://localhost/api/mp/session', { headers: bearer(tokenB) }))).status).toBe(401);
        expect(await database.wechatBinding.count()).toBe(0);
    });

    it('专注锁对 Bearer 请求同样生效：只读身份可查，清空错题被拒，网关层拦截非白名单接口', async () => {
        const token = await loginAndBind();
        const lock = signKidModeToken({
            userId: 'parent-1', learnerId: 'child-a', learnerName: '小宝', authVersion: 0,
            exp: Math.floor(Date.now() / 1000) + 3600,
        });
        const headers = bearer(token, { cookie: `${KID_MODE_COOKIE_NAME}=${lock}` });

        const session = await MP_SESSION(new Request('http://localhost/api/mp/session', { headers }));
        expect(session.status).toBe(200);
        expect((await session.json()).kidModeLearnerId).toBe('child-a');

        const clear = await CLEAR_ERRORS(new Request('http://localhost/api/error-items/clear', { method: 'DELETE', headers }));
        expect(clear.status).toBe(403);
        expect(await database.errorItem.count({ where: { userId: 'parent-1' } })).toBe(1);

        const logout = await MP_LOGOUT(new Request('http://localhost/api/mp/session', { method: 'DELETE', headers }));
        expect(logout.status).toBe(403);

        const gated = await proxy(new NextRequest('http://localhost/api/parent/home', { headers }));
        expect(gated?.status).toBe(403);
        const allowed = await proxy(new NextRequest('http://localhost/api/review/due', { headers }));
        expect(allowed?.status).toBe(200);
    });
});

describe('/api/mp/analyze multipart 上传', () => {
    function multipart(token: string, file?: Blob, extra: Record<string, string> = {}, headers: Record<string, string> = {}) {
        const form = new FormData();
        if (file) form.append('file', file, 'question.png');
        for (const [key, value] of Object.entries(extra)) form.append(key, value);
        return new Request('http://localhost/api/mp/analyze', { method: 'POST', headers: bearer(token, headers), body: form });
    }

    function storedRequest(id: string, token?: string) {
        return GET_STORED_REQUEST(
            new Request(`http://localhost/api/requests/${id}`, { headers: token ? bearer(token) : {} }),
            { params: Promise.resolve({ id }) },
        );
    }

    it('多图逐张识别：带请求编号的识别结果可用 Bearer 令牌轮询取回，别人取不到', async () => {
        const token = await loginAndBind();
        mocks.analyzeImage
            .mockResolvedValueOnce({ questionText: '第一页题', answerText: '1', analysis: 'a', knowledgePoints: [], subject: '数学' })
            .mockResolvedValueOnce({ questionText: '第二页题', answerText: '2', analysis: 'b', knowledgePoints: [], subject: '数学' });
        const png = new Blob([Buffer.from(SAMPLE_PNG_BASE64, 'base64')], { type: 'image/png' });
        const ids = ['a'.repeat(32), 'b'.repeat(32)];
        for (const id of ids) {
            const res = await MP_ANALYZE(multipart(token, png, { language: 'zh' }, { 'x-request-id': id }));
            expect(res.status).toBe(200);
        }

        const first = await storedRequest(ids[0], token);
        expect(first.status).toBe(200);
        const firstBody = await first.json();
        expect(firstBody.state).toBe('done');
        expect(firstBody.status).toBe(200);
        expect(firstBody.body.questionText).toBe('第一页题');
        expect(firstBody.body.imageDataUrl).toMatch(/^data:image\/png;base64,/);
        expect((await (await storedRequest(ids[1], token)).json()).body.questionText).toBe('第二页题');

        // 没登录、别的账号、不存在的编号都拿不到
        expect((await storedRequest(ids[0])).status).toBe(401);
        const { body: stranger } = await wechatLogin('openid-stranger');
        expect((await storedRequest(ids[0], stranger.token)).status).toBe(404);
        expect((await storedRequest('c'.repeat(32), token)).status).toBe(404);
    });

    it('上传图片后返回识别结果与规范化后的原图', async () => {
        const token = await loginAndBind();
        mocks.analyzeImage.mockResolvedValue({ questionText: '1+1=?', answerText: '2', analysis: '加法', knowledgePoints: ['加法'], subject: '数学' });
        const png = new Blob([Buffer.from(SAMPLE_PNG_BASE64, 'base64')], { type: 'image/png' });
        const res = await MP_ANALYZE(multipart(token, png, { language: 'zh' }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.questionText).toBe('1+1=?');
        expect(body.imageDataUrl).toMatch(/^data:image\/png;base64,/);
        expect(mocks.analyzeImage.mock.calls[0][2]).toBe('zh');
    });

    it('缺文件、非 multipart、非图片、超大请求分别拒绝', async () => {
        const token = await loginAndBind();
        expect((await MP_ANALYZE(multipart(token))).status).toBe(400);
        expect((await MP_ANALYZE(new Request('http://localhost/api/mp/analyze', {
            method: 'POST', headers: bearer(token, { 'content-type': 'application/json' }), body: '{}',
        }))).status).toBe(400);
        const text = new Blob(['not an image'], { type: 'image/png' });
        expect((await MP_ANALYZE(multipart(token, text))).status).toBe(400);
        expect((await MP_ANALYZE(new Request('http://localhost/api/mp/analyze', {
            method: 'POST',
            headers: bearer(token, { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(30 * 1024 * 1024) }),
            body: 'x',
        }))).status).toBe(413);
        expect(mocks.analyzeImage).not.toHaveBeenCalled();
    });

    async function pagePng(width: number, height: number, shade: number) {
        const sharp = (await import('sharp')).default;
        const buffer = await sharp({ create: { width, height, channels: 3, background: { r: shade, g: shade, b: shade } } }).png().toBuffer();
        return buffer.toString('base64');
    }

    async function widthOf(base64: string) {
        const sharp = (await import('sharp')).default;
        return (await sharp(Buffer.from(base64, 'base64')).metadata()).width;
    }

    it('跨页题：几张图按顺序一次识别，只计 1 次用量，返回拼好的原图和跨页判断', async () => {
        const token = await loginAndBind();
        mocks.analyzeImage.mockResolvedValue({
            questionText: '跨页题', answerText: '1', analysis: 'a', knowledgePoints: [], subject: '物理',
            continuity: { startsMidQuestion: false, endsIncomplete: true },
        });
        const pages = [await pagePng(40, 60, 10), await pagePng(50, 60, 120), await pagePng(60, 60, 240)];
        const usageBefore = await database.aiUsage.count();
        const res = await MP_ANALYZE(new Request('http://localhost/api/mp/analyze', {
            method: 'POST',
            headers: bearer(token, { 'content-type': 'application/json', 'x-request-id': 'd'.repeat(32) }),
            body: JSON.stringify({ images: pages, language: 'zh' }),
        }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.questionText).toBe('跨页题');
        expect(body.pageCount).toBe(3);
        expect(body.continuity).toEqual({ startsMidQuestion: false, endsIncomplete: true });
        expect(body.imageDataUrl).toMatch(/^data:image\/jpeg;base64,/);
        // 拼图包含三页：小图不放大，统一宽度后上下拼接（含两道 16px 间隔）
        const sharp = (await import('sharp')).default;
        const composite = await sharp(Buffer.from(body.imageDataUrl.split(',')[1], 'base64')).metadata();
        expect([composite.width, composite.height]).toEqual([60, 90 + 72 + 60 + 32]);

        expect(mocks.analyzeImage).toHaveBeenCalledTimes(1);
        const call = mocks.analyzeImage.mock.calls[0];
        expect(await widthOf(call[0])).toBe(40);
        expect(call[7]).toHaveLength(2);
        expect(await widthOf(call[7][0].base64)).toBe(50);
        expect(await widthOf(call[7][1].base64)).toBe(60);
        expect(await database.aiUsage.count()).toBe(usageBefore + 1);

        // 断线后同样可以按编号取回
        const stored = await GET_STORED_REQUEST(
            new Request(`http://localhost/api/requests/${'d'.repeat(32)}`, { headers: bearer(token) }),
            { params: Promise.resolve({ id: 'd'.repeat(32) }) },
        );
        expect((await stored.json()).body.pageCount).toBe(3);
    });

    it('跨页题：multipart 重复 file 字段也按顺序合成一次识别', async () => {
        const token = await loginAndBind();
        mocks.analyzeImage.mockResolvedValue({ questionText: '两页题', answerText: '1', analysis: 'a', knowledgePoints: [], subject: '数学' });
        const form = new FormData();
        form.append('file', new Blob([Buffer.from(await pagePng(30, 40, 0), 'base64')], { type: 'image/png' }), 'a.png');
        form.append('file', new Blob([Buffer.from(await pagePng(70, 40, 200), 'base64')], { type: 'image/png' }), 'b.png');
        const res = await MP_ANALYZE(new Request('http://localhost/api/mp/analyze', { method: 'POST', headers: bearer(token), body: form }));
        expect(res.status).toBe(200);
        expect((await res.json()).pageCount).toBe(2);
        const call = mocks.analyzeImage.mock.calls[0];
        expect(await widthOf(call[0])).toBe(30);
        expect(call[7].map((image: { mimeType: string }) => image.mimeType)).toEqual(['image/png']);
    });

    it('跨页题最多 3 张，坏图整组拒绝且不计用量', async () => {
        const token = await loginAndBind();
        const page = await pagePng(20, 20, 50);
        const usageBefore = await database.aiUsage.count();
        const post = (images: unknown) => MP_ANALYZE(new Request('http://localhost/api/mp/analyze', {
            method: 'POST', headers: bearer(token, { 'content-type': 'application/json' }), body: JSON.stringify({ images }),
        }));
        const tooMany = await post([page, page, page, page]);
        expect(tooMany.status).toBe(400);
        expect((await tooMany.json()).message).toBe('TOO_MANY_IMAGES');
        expect((await post([page, Buffer.from('not an image').toString('base64')])).status).toBe(400);
        expect((await post([])).status).toBe(400);
        expect((await post([page, 42])).status).toBe(400);
        expect(mocks.analyzeImage).not.toHaveBeenCalled();
        expect(await database.aiUsage.count()).toBe(usageBefore);
    });

    it('未登录不能上传', async () => {
        const res = await MP_ANALYZE(new Request('http://localhost/api/mp/analyze', { method: 'POST', body: new FormData() }));
        expect(res.status).toBe(401);
    });
});
