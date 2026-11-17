/**
 * defineApiRoute / resolveActor / RequestContext 单元测试 (OPT-02)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    findUnique: vi.fn(),
}));

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: { findUnique: mocks.findUnique },
    },
}));

import { defineApiRoute } from '@/lib/server/api-route';
import { getRequestContext } from '@/lib/server/request-context';

describe('defineApiRoute 与请求上下文 (OPT-02)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({
            user: { id: 'u1', email: 'u1@example.com', role: 'user', authVersion: 1 },
            expires: '2099-01-01',
        });
        mocks.findUnique.mockResolvedValue({
            id: 'u1',
            email: 'u1@example.com',
            name: 'User 1',
            role: 'user',
            isActive: true,
            authVersion: 1,
        });
    });

    it('dbUser.authVersion 与 token 不匹配时返回 401 SESSION_REVOKED', async () => {
        mocks.findUnique.mockResolvedValueOnce({
            id: 'u1',
            email: 'u1@example.com',
            role: 'user',
            isActive: true,
            authVersion: 2,
        });
        const handler = vi.fn(() => NextResponse.json({ ok: true }));
        const route = defineApiRoute({ auth: 'user' }, handler);

        const res = await route(new Request('http://localhost/api/test'));
        const data = await res.json();

        expect(res.status).toBe(401);
        expect(data.code).toBe('SESSION_REVOKED');
        expect(handler).not.toHaveBeenCalled();
    });

    it('旧 token 无 authVersion 且数据库 authVersion > 0 时立即撤销返回 401 SESSION_REVOKED', async () => {
        mocks.getServerSession.mockResolvedValueOnce({
            user: { id: 'u1', email: 'u1@example.com', role: 'user' },
            expires: '2099-01-01',
        });
        mocks.findUnique.mockResolvedValueOnce({
            id: 'u1',
            email: 'u1@example.com',
            role: 'user',
            isActive: true,
            authVersion: 1,
        });
        const route = defineApiRoute({ auth: 'user' }, () => NextResponse.json({ ok: true }));

        const res = await route(new Request('http://localhost/api/test'));
        expect(res.status).toBe(401);
        expect((await res.json()).code).toBe('SESSION_REVOKED');
    });

    it('dbUser.isActive === false 时返回 401 ACCOUNT_DISABLED', async () => {
        mocks.findUnique.mockResolvedValueOnce({
            id: 'u1',
            email: 'u1@example.com',
            role: 'user',
            isActive: false,
            authVersion: 1,
        });
        const handler = vi.fn(() => NextResponse.json({ ok: true }));
        const route = defineApiRoute({ auth: 'user' }, handler);

        const res = await route(new Request('http://localhost/api/test'));
        const data = await res.json();

        expect(res.status).toBe(401);
        expect(data.code).toBe('ACCOUNT_DISABLED');
        expect(handler).not.toHaveBeenCalled();
    });

    it('通过 AsyncLocalStorage 注入 requestId 与 userId 到异步处理链路', async () => {
        let insideCtx: ReturnType<typeof getRequestContext> | undefined;
        const route = defineApiRoute({ auth: 'user' }, async () => {
            await Promise.resolve();
            insideCtx = getRequestContext();
            return NextResponse.json({ ok: true });
        });

        const res = await route(new Request('http://localhost/api/test', {
            headers: { 'x-request-id': 'req-trace-42' },
        }));

        expect(res.status).toBe(200);
        expect(insideCtx).toEqual({ requestId: 'req-trace-42', userId: 'u1' });
        expect(getRequestContext()).toBeUndefined();
    });

    it('maxBodyBytes 按实际流式读取字节上限拦截分块请求并返回 413，忽略伪造的 Content-Length', async () => {
        const handler = vi.fn(() => NextResponse.json({ ok: true }));
        const route = defineApiRoute({ auth: 'user', maxBodyBytes: 32 }, handler);

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"text":"1234567890'));
                controller.enqueue(new TextEncoder().encode('123456789012345678901234567890"}'));
                controller.close();
            },
        });
        const req = new Request('http://localhost/api/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': '10' },
            body: stream,
            // @ts-expect-error Node 22 Request streaming flag
            duplex: 'half',
        });

        const res = await route(req);
        const data = await res.json();

        expect(res.status).toBe(413);
        expect(data.code).toBe('PAYLOAD_TOO_LARGE');
        expect(handler).not.toHaveBeenCalled();
    });

    it('maxBodyBytes 限额内且未传 bodySchema 时，下游仍可读取 JSON；传 bodySchema 时校验并注入 ctx.body', async () => {
        const replayRoute = defineApiRoute({ auth: 'user', maxBodyBytes: 128 }, async (req) => {
            const payload = await req.json();
            return NextResponse.json(payload);
        });
        const okReplay = await replayRoute(new Request('http://localhost/api/test', {
            method: 'POST',
            body: JSON.stringify({ hello: 'world' }),
        }));
        expect(okReplay.status).toBe(200);
        expect(await okReplay.json()).toEqual({ hello: 'world' });

        const schemaRoute = defineApiRoute(
            { auth: 'user', maxBodyBytes: 128, bodySchema: z.object({ count: z.number().int().min(1) }) },
            (_req, { body }) => NextResponse.json({ doubled: body.count * 2 }),
        );
        const invalidRes = await schemaRoute(new Request('http://localhost/api/test', {
            method: 'POST',
            body: JSON.stringify({ count: 0 }),
        }));
        expect(invalidRes.status).toBe(400);
        expect((await invalidRes.json()).code).toBe('VALIDATION_ERROR');

        const validRes = await schemaRoute(new Request('http://localhost/api/test', {
            method: 'POST',
            body: JSON.stringify({ count: 3 }),
        }));
        expect(validRes.status).toBe(200);
        expect(await validRes.json()).toEqual({ doubled: 6 });
    });
});
