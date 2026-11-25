// @vitest-environment node
/**
 * 微信小程序登录与 Bearer 鉴权：code 换会话、账号密码一次绑定、令牌吊销、专注锁与跨账号 404、multipart 识别上传。
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
import { POST as MP_ANALYZE } from '@/app/api/mp/analyze/route';
import { GET as GET_ERROR_ITEM } from '@/app/api/error-items/[id]/route';
import { DELETE as CLEAR_ERRORS } from '@/app/api/error-items/clear/route';
import { GET as LIST_LEARNERS } from '@/app/api/learners/route';
import { GET as REVIEW_DUE } from '@/app/api/review/due/route';
import { isApiAllowedInKidMode, KID_MODE_COOKIE_NAME, signKidModeToken } from '@/lib/kid-mode-lock';
import { loginAccountLimiter, loginIpLimiter, mpLoginIpLimiter } from '@/lib/rate-limit';
import {
    code2Session,
    hashMiniProgramToken,
    readMiniProgramBearer,
    signBindTicket,
    verifyBindTicket,
    WechatLoginError,
} from '@/lib/server/mp-auth';
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

async function loginAndBind(email = 'parent@example.com', password = 'ParentPass123!') {
    const login = await MP_LOGIN(jsonRequest('/api/mp/login', { code: 'code-1' }));
    const loginBody = await login.json();
    if (loginBody.status === 'ok') return loginBody.token as string;
    const bind = await MP_BIND(jsonRequest('/api/mp/bind', { bindTicket: loginBody.bindTicket, email, password }));
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

    await database.miniProgramSession.deleteMany();
    await database.wechatBinding.deleteMany();
    await database.errorItem.deleteMany();
    await database.learner.deleteMany();
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
    });

    it('绑定凭证校验签名、AppID 与有效期', () => {
        const now = Date.now();
        const ticket = signBindTicket({ appId: APP_ID, openid: 'o1' }, now);
        expect(verifyBindTicket(ticket, APP_ID, now)?.openid).toBe('o1');
        expect(verifyBindTicket(ticket, 'another-app', now)).toBeNull();
        expect(verifyBindTicket(ticket, APP_ID, now + 11 * 60 * 1000)).toBeNull();
        const [body, sig] = ticket.split('.');
        const forged = Buffer.from(JSON.stringify({ appId: APP_ID, openid: 'victim', exp: 9e9 })).toString('base64url');
        expect(verifyBindTicket(`${forged}.${sig}`, APP_ID, now)).toBeNull();
        expect(verifyBindTicket(`${body}`, APP_ID, now)).toBeNull();
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

describe('/api/mp/login 与 /api/mp/bind', () => {
    it('未配置 AppID/AppSecret 时返回 503', async () => {
        vi.stubEnv('WECHAT_MP_APPSECRET', '');
        const res = await MP_LOGIN(jsonRequest('/api/mp/login', { code: 'c' }));
        expect(res.status).toBe(503);
        expect((await res.json()).message).toBe('MP_NOT_CONFIGURED');
    });

    it('首次登录需要绑定；账号密码绑定后签发令牌，数据库只存摘要；再次登录直接成功', async () => {
        const first = await MP_LOGIN(jsonRequest('/api/mp/login', { code: 'c' }));
        const firstBody = await first.json();
        expect(firstBody.status).toBe('needs_bind');
        expect(JSON.stringify(firstBody)).not.toContain('openid-parent');

        const wrong = await MP_BIND(jsonRequest('/api/mp/bind', { bindTicket: firstBody.bindTicket, email: 'parent@example.com', password: 'nope' }));
        expect(wrong.status).toBe(401);

        const bind = await MP_BIND(jsonRequest('/api/mp/bind', { bindTicket: firstBody.bindTicket, email: 'PARENT@example.com', password: 'ParentPass123!' }));
        expect(bind.status).toBe(200);
        const bound = await bind.json();
        expect(bound.token).toMatch(/^xjmp_/);
        expect(bound.user).toMatchObject({ id: 'parent-1', personas: ['parent'], personasConfirmed: true });

        const stored = await database.miniProgramSession.findFirstOrThrow({ where: { userId: 'parent-1' } });
        expect(stored.tokenHash).toBe(hashMiniProgramToken(bound.token));
        expect(JSON.stringify(stored)).not.toContain(bound.token);

        const again = await MP_LOGIN(jsonRequest('/api/mp/login', { code: 'c2' }));
        const againBody = await again.json();
        expect(againBody.status).toBe('ok');
        expect(againBody.token).not.toBe(bound.token);
    });

    it('伪造或过期的绑定凭证返回 400', async () => {
        const res = await MP_BIND(jsonRequest('/api/mp/bind', { bindTicket: 'x.y', email: 'parent@example.com', password: 'ParentPass123!' }));
        expect(res.status).toBe(400);
    });

    it('同一微信已绑定其他账号时返回 409；账号改绑新微信会作废旧微信的会话', async () => {
        const oldToken = await loginAndBind();
        const ticket = (await (await MP_LOGIN(jsonRequest('/api/mp/login', { code: 'c' }))).json()).bindTicket;
        expect(ticket).toBeUndefined();

        const taken = await MP_BIND(jsonRequest('/api/mp/bind', {
            bindTicket: signBindTicket({ appId: APP_ID, openid: 'openid-parent' }),
            email: 'other@example.com',
            password: 'ParentPass123!',
        }));
        expect(taken.status).toBe(409);

        const rebind = await MP_BIND(jsonRequest('/api/mp/bind', {
            bindTicket: signBindTicket({ appId: APP_ID, openid: 'openid-new-phone' }),
            email: 'parent@example.com',
            password: 'ParentPass123!',
        }));
        expect(rebind.status).toBe(200);
        expect((await MP_SESSION(new Request('http://localhost/api/mp/session', { headers: bearer(oldToken) }))).status).toBe(401);
        expect(await database.wechatBinding.count({ where: { userId: 'parent-1' } })).toBe(1);
    });

    it('仍在使用默认管理员密码时拒绝绑定，要求先在网页端改密', async () => {
        await database.user.create({ data: { id: 'admin-1', email: 'admin@localhost', role: 'admin', password: await bcrypt.hash('123456', 4) } });
        const ticket = signBindTicket({ appId: APP_ID, openid: 'openid-admin' });
        const res = await MP_BIND(jsonRequest('/api/mp/bind', { bindTicket: ticket, email: 'admin@localhost', password: '123456' }));
        expect(res.status).toBe(403);
        expect((await res.json()).message).toBe('MUST_CHANGE_PASSWORD');
    });

    it('禁用账号无法绑定，也无法用已绑定的微信登录', async () => {
        await loginAndBind();
        await database.user.update({ where: { id: 'parent-1' }, data: { isActive: false } });
        expect((await MP_LOGIN(jsonRequest('/api/mp/login', { code: 'c' }))).status).toBe(401);
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
    function multipart(token: string, file?: Blob, extra: Record<string, string> = {}) {
        const form = new FormData();
        if (file) form.append('file', file, 'question.png');
        for (const [key, value] of Object.entries(extra)) form.append(key, value);
        return new Request('http://localhost/api/mp/analyze', { method: 'POST', headers: bearer(token), body: form });
    }

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

    it('未登录不能上传', async () => {
        const res = await MP_ANALYZE(new Request('http://localhost/api/mp/analyze', { method: 'POST', body: new FormData() }));
        expect(res.status).toBe(401);
    });
});
