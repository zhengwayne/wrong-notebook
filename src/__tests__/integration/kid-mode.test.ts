// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    session: {
        user: { id: 'parent-1', email: 'parent@example.com', role: 'user', authVersion: 0 },
        expires: '2099-01-01',
    },
    token: {
        id: 'parent-1',
        email: 'parent@example.com',
        role: 'user',
        authVersion: 0,
        activePersona: 'parent',
        needsPersonaConfirmation: false,
    },
}));

vi.mock('@/lib/prisma', () => ({ get prisma() { return mocks.prisma; } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn(async () => mocks.token) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { POST as SET_PIN, GET as GET_PIN } from '@/app/api/parent/pin/route';
import { POST as ENABLE_KID_MODE, GET as GET_KID_MODE } from '@/app/api/parent/kid-mode/route';
import { POST as UNLOCK_KID_MODE } from '@/app/api/parent/kid-mode/unlock/route';
import { DELETE as CLEAR_ERRORS } from '@/app/api/error-items/clear/route';
import { GET as GET_ERROR_ITEM } from '@/app/api/error-items/[id]/route';
import { GET as GET_LEARNING_PATH } from '@/app/api/learning-path/route';
import { PATCH as PATCH_STEP } from '@/app/api/learning-path/steps/[id]/route';
import { proxy } from '@/proxy';
import { KID_MODE_COOKIE_NAME } from '@/lib/kid-mode-lock';
import bcrypt from 'bcryptjs';

let database: PrismaClient;
let directory: string;

function extractCookieToken(setCookieHeader: string | null): string {
    expect(setCookieHeader).toBeTruthy();
    const match = setCookieHeader!.match(new RegExp(`${KID_MODE_COOKIE_NAME}=([^;]+)`));
    expect(match?.[1]).toBeTruthy();
    return match![1];
}

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'wrong-notebook-kid-mode-'));
    const url = `file:${join(directory, 'test.db')}`;
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
    });
    database = new PrismaClient({ datasources: { db: { url } } });
    mocks.prisma = database;
}, 120000);

beforeEach(async () => {
    await database.learningPathStep.deleteMany();
    await database.learningPath.deleteMany();
    await database.knowledgeMastery.deleteMany();
    await database.errorItem.deleteMany();
    await database.learner.deleteMany();
    await database.user.deleteMany();

    const passwordHash = await bcrypt.hash('ParentPass123!', 10);
    await database.user.create({
        data: {
            id: 'parent-1',
            email: 'parent@example.com',
            password: passwordHash,
            personas: JSON.stringify(['parent']),
            activePersona: 'parent',
            personasConfirmedAt: new Date(),
        },
    });
    await database.user.create({
        data: {
            id: 'other-parent',
            email: 'other@example.com',
            password: 'hashed-password',
        },
    });
    await database.learner.create({
        data: { id: 'child-a', userId: 'parent-1', kind: 'child', name: '小宝' },
    });
    await database.learner.create({
        data: { id: 'child-b', userId: 'parent-1', kind: 'child', name: '二宝' },
    });
    await database.learner.create({
        data: { id: 'child-other', userId: 'other-parent', kind: 'child', name: '别人家孩子' },
    });
    await database.errorItem.create({
        data: {
            id: 'err-1',
            userId: 'parent-1',
            learnerId: 'child-a',
            originalImageUrl: 'data:image/png;base64,dGVzdA==',
            questionText: '1 + 1 = ?',
        },
    });
    await database.errorItem.create({
        data: {
            id: 'err-b',
            userId: 'parent-1',
            learnerId: 'child-b',
            originalImageUrl: 'data:image/png;base64,dGVzdA==',
            questionText: '2 + 2 = ?',
        },
    });
});

afterAll(async () => {
    await database?.$disconnect();
    if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('孩子专注做题受限模式集成测试', () => {
    it('设置 bcrypt 哈希 PIN、签发 HttpOnly 锁、拦截删题与页面跳转，并防爆破锁定 15 分钟', async () => {
        // 1. 初始未设置 PIN
        const pinStatus0 = await GET_PIN(new Request('http://127.0.0.1/api/parent/pin'));
        expect(await pinStatus0.json()).toEqual({ hasPin: false, lockedUntil: null });

        // 2. 设置 4 位 PIN "2580"，验证数据库不存明文
        const setPinRes = await SET_PIN(new Request('http://127.0.0.1/api/parent/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: '2580' }),
        }));
        expect(setPinRes.status).toBe(200);
        const dbUser = await database.user.findUniqueOrThrow({ where: { id: 'parent-1' } });
        expect(dbUser.parentPinHash).toBeTruthy();
        expect(dbUser.parentPinHash).not.toBe('2580');

        // 3. 越权开启他人孩子专注模式返回 404
        const idorRes = await ENABLE_KID_MODE(new Request('http://127.0.0.1/api/parent/kid-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ learnerId: 'child-other' }),
        }));
        expect(idorRes.status).toBe(404);

        // 4. 开启自家孩子专注模式，获取 HttpOnly 签名 Cookie
        const enableRes = await ENABLE_KID_MODE(new Request('http://127.0.0.1/api/parent/kid-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ learnerId: 'child-a' }),
        }));
        expect(enableRes.status).toBe(200);
        const setCookie = enableRes.headers.get('set-cookie');
        expect(setCookie).toContain('HttpOnly');
        const cookieToken = extractCookieToken(setCookie);
        const cookieHeader = `${KID_MODE_COOKIE_NAME}=${cookieToken}`;

        const statusRes = await GET_KID_MODE(new Request('http://127.0.0.1/api/parent/kid-mode', {
            headers: { cookie: cookieHeader },
        }));
        expect(await statusRes.json()).toMatchObject({
            active: true,
            learnerId: 'child-a',
            learnerName: '小宝',
            hasPin: true,
        });

        // 5. 锁定态下调用清空错题或修改 PIN 被服务端直接拒绝（403 KID_MODE_RESTRICTED）
        const clearBlocked = await CLEAR_ERRORS(new Request('http://127.0.0.1/api/error-items/clear', {
            method: 'DELETE',
            headers: { cookie: cookieHeader },
        }));
        expect(clearBlocked.status).toBe(403);
        expect(await clearBlocked.json()).toMatchObject({ code: 'KID_MODE_RESTRICTED' });
        expect(await database.errorItem.count({ where: { id: 'err-1' } })).toBe(1);

        const pinChangeBlocked = await SET_PIN(new Request('http://127.0.0.1/api/parent/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
            body: JSON.stringify({ pin: '9999', currentPin: '2580' }),
        }));
        expect(pinChangeBlocked.status).toBe(403);

        // 6. proxy 路由收敛：访问 /parent 被重定向至 /learn?studentKey=child-a，访问 /learn 放行
        const parentNavRes = await proxy(new NextRequest('http://127.0.0.1/parent', {
            headers: { cookie: `next-auth.session-token=fake; ${cookieHeader}` },
        }));
        expect(parentNavRes?.status).toBe(307);
        expect(parentNavRes?.headers.get('location')).toContain('/learn?studentKey=child-a');

        const learnNavRes = await proxy(new NextRequest('http://127.0.0.1/learn?studentKey=child-a', {
            headers: { cookie: `next-auth.session-token=fake; ${cookieHeader}` },
        }));
        expect(learnNavRes).toBeUndefined();

        // 7. 连续输错 5 次 PIN 触发 15 分钟防爆破锁定
        for (let attempt = 1; attempt <= 4; attempt++) {
            const wrongRes = await UNLOCK_KID_MODE(new Request('http://127.0.0.1/api/parent/kid-mode/unlock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
                body: JSON.stringify({ pin: '0000' }),
            }));
            expect(wrongRes.status).toBe(403);
        }
        const fifthWrongRes = await UNLOCK_KID_MODE(new Request('http://127.0.0.1/api/parent/kid-mode/unlock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
            body: JSON.stringify({ pin: '0000' }),
        }));
        expect(fifthWrongRes.status).toBe(429);

        // 锁定期内即使输入正确 PIN 也返回 429
        const lockedCorrectRes = await UNLOCK_KID_MODE(new Request('http://127.0.0.1/api/parent/kid-mode/unlock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
            body: JSON.stringify({ pin: '2580' }),
        }));
        expect(lockedCorrectRes.status).toBe(429);

        // 模拟 15 分钟锁定期结束，输入正确 PIN 成功解锁并清除 Cookie
        await database.user.update({
            where: { id: 'parent-1' },
            data: { parentPinLockedUntil: new Date(Date.now() - 1000) },
        });
        const unlockOkRes = await UNLOCK_KID_MODE(new Request('http://127.0.0.1/api/parent/kid-mode/unlock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
            body: JSON.stringify({ pin: '2580' }),
        }));
        expect(unlockOkRes.status).toBe(200);
        expect(unlockOkRes.headers.get('set-cookie')).toContain('Max-Age=0');
    });

    it('proxy 拦截非白名单 API、放行路线强绑定 child-a、并发错误 PIN 严格锁定，且可用账户密码重置 PIN', async () => {
        await SET_PIN(new Request('http://127.0.0.1/api/parent/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: '2580' }),
        }));
        const enableRes = await ENABLE_KID_MODE(new Request('http://127.0.0.1/api/parent/kid-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ learnerId: 'child-a' }),
        }));
        const cookieToken = extractCookieToken(enableRes.headers.get('set-cookie'));
        const cookieHeader = `${KID_MODE_COOKIE_NAME}=${cookieToken}`;

        // 1. proxy 拦截非白名单 API（包括仅使用 getCurrentUser 的 /api/exams）
        const apiBlocked = await proxy(new NextRequest('http://127.0.0.1/api/exams', {
            method: 'POST',
            headers: { cookie: `next-auth.session-token=fake; ${cookieHeader}` },
        }));
        expect(apiBlocked?.status).toBe(403);
        expect(await apiBlocked?.json()).toMatchObject({ code: 'KID_MODE_RESTRICTED' });

        // 无专注锁时 /api/exams 直接直通
        const apiAllowedWithoutLock = await proxy(new NextRequest('http://127.0.0.1/api/exams', {
            method: 'POST',
            headers: { cookie: 'next-auth.session-token=fake' },
        }));
        expect(apiAllowedWithoutLock?.status).toBe(200);
        expect(apiAllowedWithoutLock?.headers.get('x-middleware-next')).toBe('1');

        // 2. 锁定 child-a 时无法访问 child-b 错题与学习路径
        const errBRes = await GET_ERROR_ITEM(
            new Request('http://127.0.0.1/api/error-items/err-b', { headers: { cookie: cookieHeader } }),
            { params: Promise.resolve({ id: 'err-b' }) },
        );
        expect(errBRes.status).toBe(403);

        const pathRes = await GET_LEARNING_PATH(
            new Request('http://127.0.0.1/api/learning-path?studentKey=child-b&language=zh', { headers: { cookie: cookieHeader } }),
        );
        expect(pathRes.status).toBe(200);
        const pathData = await pathRes.json();
        expect(pathData.studentKey).toBe('child-a');

        if (pathData.steps?.[0]?.id) {
            const skipBlocked = await PATCH_STEP(
                new Request(`http://127.0.0.1/api/learning-path/steps/${pathData.steps[0].id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
                    body: JSON.stringify({ action: 'skip' }),
                }),
                { params: Promise.resolve({ id: pathData.steps[0].id }) },
            );
            expect(skipBlocked.status).toBe(403);
        }

        // 3. 并发 8 次错误 PIN 请求：串行锁确保第 5 次起必触发 429
        const burst = await Promise.all(
            Array.from({ length: 8 }, () => UNLOCK_KID_MODE(new Request('http://127.0.0.1/api/parent/kid-mode/unlock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
                body: JSON.stringify({ pin: '0000' }),
            }))),
        );
        const statuses = burst.map((r) => r.status);
        expect(statuses.filter((s) => s === 403)).toHaveLength(4);
        expect(statuses.filter((s) => s === 429)).toHaveLength(4);

        // 4. 忘记 PIN 且处于锁定期间时，可用账户登录密码重置 PIN
        const resetByPwd = await SET_PIN(new Request('http://127.0.0.1/api/parent/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: '1357', accountPassword: 'ParentPass123!' }),
        }));
        expect(resetByPwd.status).toBe(200);
    });
});
