/**
 * /api/logs/frontend 集成测试：登录校验与日志数量、长度限制
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    userFindUnique: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), box: vi.fn(), divider: vi.fn() },
}));

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: mocks.userFindUnique } } }));
vi.mock('@/lib/logger', () => ({ createLogger: vi.fn(() => mocks.logger) }));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/logs/frontend/route';
import { frontendLogLimiter } from '@/lib/rate-limit';

function makeRequest(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/logs/frontend', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('POST /api/logs/frontend', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        frontendLogLimiter.reset('user-1');
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user-1', email: 'u@localhost' }, expires: '2099-01-01' });
        mocks.userFindUnique.mockResolvedValue({ id: 'user-1', email: 'u@localhost', role: 'user', isActive: true, authVersion: 0 });
    });

    it('未登录时返回 401，不写日志', async () => {
        mocks.getServerSession.mockResolvedValue(null);

        const response = await POST(makeRequest({ level: 'error', prefix: '[x]', message: 'spam' }));

        expect(response.status).toBe(401);
        expect(mocks.logger.error).not.toHaveBeenCalled();
    });

    it('记录日志时带上当前用户 ID，前端 context 隔离在 extra 中且不覆盖顶层元数据', async () => {
        await POST(makeRequest({ level: 'warn', prefix: '[x]', message: 'hello', context: { userId: 'fake', source: 'spoofed', foo: 'bar' } }));

        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'user-1',
                source: 'frontend',
                extra: { userId: 'fake', source: 'spoofed', foo: 'bar' },
            }),
            'hello',
        );
    });

    it('单次最多记录 50 条日志', async () => {
        const logs = Array.from({ length: 80 }, () => ({ level: 'info', prefix: '[x]', message: 'short' }));

        const response = await POST(makeRequest({ logs }));

        expect(response.status).toBe(200);
        expect((await response.json()).count).toBe(50);
        expect(mocks.logger.info).toHaveBeenCalledTimes(50);
    });

    it('单条消息截断到 2000 字符，超长 context 序列化在 2048B 内截断', async () => {
        const response = await POST(makeRequest({
            level: 'info',
            prefix: '[x]',
            message: 'a'.repeat(5000),
            context: { detail: 'b'.repeat(4000) },
        }));

        expect(response.status).toBe(200);
        expect(mocks.logger.info).toHaveBeenCalledTimes(1);
        expect(mocks.logger.info.mock.calls[0][1]).toHaveLength(2000);
        expect(mocks.logger.info.mock.calls[0][0].extra).toMatchObject({ truncated: true });
    });

    it('请求体超过 65536 字节流式截断并返回 413', async () => {
        const response = await POST(makeRequest({
            level: 'info',
            prefix: '[x]',
            message: 'x'.repeat(70000),
        }));

        expect(response.status).toBe(413);
        expect(mocks.logger.info).not.toHaveBeenCalled();
    });

    it('非法日志结构返回 400；超出每用户限流返回 429', async () => {
        const badRes = await POST(makeRequest({ level: 'debug', message: 123 }));
        expect(badRes.status).toBe(400);

        for (let i = 0; i < 60; i++) frontendLogLimiter.hit('user-1');
        const limitedRes = await POST(makeRequest({ level: 'info', prefix: '[x]', message: 'hi' }));
        expect(limitedRes.status).toBe(429);
    });
});
