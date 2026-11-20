/**
 * 耗时请求响应暂存：withRecoverableResponse 与 GET /api/requests/:id
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
    user: { findUnique: vi.fn() },
    session: { user: { email: 'user@example.com' }, expires: '2099-01-01' } as { user: { email: string; authVersion?: number }; expires: string } | null,
}));

vi.mock('@/lib/prisma', () => ({ prisma: { user: mocks.user } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(() => Promise.resolve(mocks.session)) }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

import { GET } from '@/app/api/requests/[id]/route';
import { KID_MODE_COOKIE_NAME, signKidModeToken } from '@/lib/kid-mode-lock';
import { resetRecoverableResponsesForTest, withRecoverableResponse } from '@/lib/recoverable-response';

const id = 'a'.repeat(32);
const lookup = (requestId = id) => GET(new Request('http://localhost'), { params: Promise.resolve({ id: requestId }) });
const call = (handler: (req: Request) => Promise<Response>, headers: Record<string, string> = { 'X-Request-Id': id }) =>
    withRecoverableResponse(handler)(new Request('http://localhost', { method: 'POST', headers }));

describe('耗时请求响应暂存', () => {
    beforeEach(() => {
        resetRecoverableResponsesForTest();
        mocks.session = { user: { email: 'user@example.com' }, expires: '2099-01-01' };
        mocks.user.findUnique.mockResolvedValue({ id: 'user-1' });
    });

    it('带异步请求编号时暂存 running 与 done，跨用户访问不可见（对应 404）', async () => {
        let finish!: () => void;
        const pending = call(() => new Promise((resolve) => { finish = () => resolve(NextResponse.json({ svgAnimation: '<svg/>' })); }));

        expect(await (await lookup()).json()).toEqual({ state: 'running' });

        finish();
        const response = await pending;
        expect(await response.json()).toEqual({ svgAnimation: '<svg/>' });
        expect(await (await lookup()).json()).toEqual({ state: 'done', status: 200, body: { svgAnimation: '<svg/>' } });
    });

    it('保存错误响应，供前端按原错误处理', async () => {
        await call(async () => NextResponse.json({ message: 'NO_VALID_NARRATION' }, { status: 400 }));
        expect(await (await lookup()).json()).toEqual({ state: 'done', status: 400, body: { message: 'NO_VALID_NARRATION' } });
    });

    it('同账户的孩子与家长各自取回相同编号的响应', async () => {
        const cookie = (learnerId: string) => `${KID_MODE_COOKIE_NAME}=${signKidModeToken({
            userId: 'user-1', learnerId, learnerName: learnerId, authVersion: 0, exp: Math.floor(Date.now() / 1000) + 60,
        })}`;
        const read = (learnerId: string) => GET(new Request('http://localhost', { headers: { cookie: cookie(learnerId) } }),
            { params: Promise.resolve({ id }) });
        await call(async () => NextResponse.json({ source: 'parent' }));
        await call(async () => NextResponse.json({ source: 'child-a' }), { 'X-Request-Id': id, cookie: cookie('child-a') });
        expect((await (await read('child-a')).json()).body.source).toBe('child-a');
        expect((await read('child-b')).status).toBe(404);
        expect((await (await lookup()).json()).body.source).toBe('parent');
    });

    it('没有或无效的请求编号时不暂存；处理函数抛错时删除登记', async () => {
        await call(async () => NextResponse.json({}), {});
        await call(async () => NextResponse.json({}), { 'X-Request-Id': 'not-valid' });
        expect((await lookup()).status).toBe(404);

        await expect(call(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect((await lookup()).status).toBe(404);
        expect((await lookup('../x')).status).toBe(404);
    });

    it('轮换会话版本后，旧专注锁无法取回孩子先前的响应', async () => {
        const cookie = `${KID_MODE_COOKIE_NAME}=${signKidModeToken({
            userId: 'user-1', learnerId: 'child-a', learnerName: 'A', authVersion: 0, exp: Math.floor(Date.now() / 1000) + 60,
        })}`;
        await call(async () => NextResponse.json({ source: 'child' }), { 'X-Request-Id': id, cookie });

        mocks.session = { user: { email: 'user@example.com', authVersion: 1 }, expires: '2099-01-01' };
        mocks.user.findUnique.mockResolvedValue({ id: 'user-1', authVersion: 1 });
        const response = await GET(new Request('http://localhost', { headers: { cookie } }), { params: Promise.resolve({ id }) });
        expect(response.status).toBe(404);
    });

    it('未登录不能查询，跨用户访问返回 404', async () => {
        await call(async () => NextResponse.json({ ok: true }));

        // 另一位用户查询，应返回 404 不泄露响应存在性
        mocks.user.findUnique.mockResolvedValueOnce({ id: 'user-2' });
        expect((await lookup()).status).toBe(404);

        // 本人可读取
        mocks.user.findUnique.mockResolvedValueOnce({ id: 'user-1' });
        expect((await lookup()).status).toBe(200);

        mocks.session = null;
        expect((await lookup()).status).toBe(401);
    });
});
