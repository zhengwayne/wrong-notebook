/**
 * /api/openclaw/batch-upload 安全加固集成测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SAMPLE_PNG_BASE64 } from '../helpers/sample-images';

const mocks = vi.hoisted(() => ({
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    subject: { findUnique: vi.fn() },
    learner: { findUnique: vi.fn(), findMany: vi.fn() },
    compare: vi.fn(),
    fetch: vi.fn(),
    errorItemCreate: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    prisma: {
        user: mocks.user,
        subject: mocks.subject,
        learner: mocks.learner,
        errorItem: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
        knowledgeTag: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({ id: 'tag-1' })) },
        aiProvenance: { create: vi.fn(async () => ({ id: 'prov-1' })) },
        $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
            user: mocks.user,
            subject: mocks.subject,
            errorItem: {
                findUnique: vi.fn(async () => null),
                findFirst: vi.fn(async () => null),
                findMany: vi.fn(async () => []),
                create: mocks.errorItemCreate,
            },
            knowledgeTag: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({ id: 'tag-1' })) },
        })),
    },
}));

vi.mock('bcryptjs', () => ({ compare: mocks.compare }));
vi.mock('@/lib/logger', () => ({
    createLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));
vi.mock('@/lib/background-tasks', () => ({
    startBackgroundTask: vi.fn(() => ({
        id: 'task-1',
        setProgress: vi.fn(),
        succeed: vi.fn(),
        fail: vi.fn(),
    })),
}));
vi.mock('@/lib/mastery', () => ({ scheduleMasteryEvaluation: vi.fn() }));
vi.mock('@/lib/learning-path/service', () => ({ scheduleLearningPathReplan: vi.fn() }));
vi.mock('@/lib/import-question-grade', () => ({
    prepareImportGrade: vi.fn(async () => ({ gradeSemester: '七年级上', response: null })),
}));

import { POST } from '@/app/api/openclaw/batch-upload/route';
import { loginAccountLimiter, loginIpLimiter } from '@/lib/rate-limit';

const validImages = [{ base64: SAMPLE_PNG_BASE64, mimeType: 'image/png', filename: 'q.png' }];

function makeReq(body: unknown, headers: Record<string, string> = {}) {
    return new Request('http://localhost/api/openclaw/batch-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

describe('POST /api/openclaw/batch-upload 安全加固', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', mocks.fetch);
        loginAccountLimiter.reset('u@example.com');
        loginAccountLimiter.reset('missing@example.com');
        loginIpLimiter.reset('8.8.8.8');
        mocks.errorItemCreate.mockResolvedValue({ id: 'item-1', tags: [], subject: null });
        mocks.learner.findMany.mockResolvedValue([]);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('apikey 模式缺少 OPENCLAW_INTEGRATION_API_KEY 时直接拒绝 (503)，不回退密码认证', async () => {
        vi.stubEnv('OPENCLAW_AUTH_MODE', 'apikey');
        vi.stubEnv('OPENCLAW_INTEGRATION_API_KEY', '');

        const res = await POST(makeReq({ userEmail: 'u@example.com', images: validImages }));
        expect(res.status).toBe(503);
        expect(mocks.user.findUnique).not.toHaveBeenCalled();
    });

    it('apikey 模式校验密钥与 userEmail 有效性并拦截禁用用户', async () => {
        vi.stubEnv('OPENCLAW_AUTH_MODE', 'apikey');
        vi.stubEnv('OPENCLAW_INTEGRATION_API_KEY', 'secret-key-123');

        const badKeyRes = await POST(makeReq({ userEmail: 'u@example.com', images: validImages }, { 'x-api-key': 'wrong' }));
        expect(badKeyRes.status).toBe(401);

        const badEmailRes = await POST(makeReq({ userEmail: { evil: true }, images: validImages }, { 'x-api-key': 'secret-key-123' }));
        expect(badEmailRes.status).toBe(400);

        mocks.user.findUnique.mockResolvedValueOnce({ id: 'u1', email: 'u@example.com', isActive: false });
        const disabledRes = await POST(makeReq({ userEmail: 'U@Example.COM', images: validImages }, { 'x-api-key': 'secret-key-123' }));
        expect(disabledRes.status).toBe(403);
        expect(mocks.user.findUnique).toHaveBeenCalledWith({ where: { email: 'u@example.com' } });
    });

    it('credentials 模式统一返回 401 防枚举，触发限流返 429 并拦截禁用账号', async () => {
        vi.stubEnv('OPENCLAW_AUTH_MODE', 'credentials');
        vi.stubEnv('TRUST_PROXY', 'true');

        mocks.user.findUnique.mockResolvedValue(null);
        mocks.user.findFirst.mockResolvedValue(null);
        const missingRes = await POST(makeReq({ username: 'missing@example.com', password: 'pw', images: validImages }, { 'x-real-ip': '8.8.8.8' }));
        expect(missingRes.status).toBe(401);

        mocks.user.findUnique.mockResolvedValue({ id: 'u1', email: 'u@example.com', password: 'hash', isActive: true });
        mocks.compare.mockResolvedValue(false);
        for (let i = 0; i < 5; i++) {
            const wrongRes = await POST(makeReq({ username: 'u@example.com', password: 'wrong', images: validImages }));
            expect(wrongRes.status).toBe(401);
        }
        const lockedRes = await POST(makeReq({ username: 'U@Example.com', password: 'right', images: validImages }));
        expect(lockedRes.status).toBe(429);

        loginAccountLimiter.reset('u@example.com');
        mocks.user.findUnique.mockResolvedValue({ id: 'u1', email: 'u@example.com', password: 'hash', isActive: false });
        mocks.compare.mockResolvedValue(true);
        const disabledRes = await POST(makeReq({ username: 'u@example.com', password: 'right', images: validImages }));
        expect(disabledRes.status).toBe(403);
    });

    it('跨账户 subjectId 拒绝写入 (403)，单图超时不再压死为 3000ms', async () => {
        vi.stubEnv('OPENCLAW_AUTH_MODE', 'apikey');
        vi.stubEnv('OPENCLAW_INTEGRATION_API_KEY', 'secret-key-123');
        vi.stubEnv('OPENCLAW_TIMEOUT', '30000');

        mocks.user.findUnique.mockResolvedValue({ id: 'u1', email: 'u@example.com', isActive: true, gradeRecognitionMode: 'fixed', fixedGradeSemester: '七年级上' });
        mocks.subject.findUnique.mockResolvedValueOnce({ id: 'nb-other', userId: 'u2' });

        const crossRes = await POST(makeReq({
            userEmail: 'u@example.com',
            subjectId: 'nb-other',
            images: validImages,
        }, { 'x-api-key': 'secret-key-123' }));
        expect(crossRes.status).toBe(403);
        expect(mocks.fetch).not.toHaveBeenCalled();

        // 单张图成功请求不再因 Math.min(3000, timeout) 短路成 3s
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        mocks.subject.findUnique.mockResolvedValue({ id: 'nb-own', userId: 'u1', name: '数学' });
        mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
            success: true,
            data: { questionText: '1+1=?', answerText: '2', analysis: '相加', knowledgePoints: [] },
        }), { status: 200 }));

        const okRes = await POST(makeReq({
            userEmail: 'u@example.com',
            subjectId: 'nb-own',
            images: validImages,
        }, { 'x-api-key': 'secret-key-123' }));
        expect(okRes.status).toBe(201);
        const timerMs = setTimeoutSpy.mock.calls.map((call) => Number(call[1])).filter((n) => n >= 3000);
        expect(timerMs).toContain(30000);
        setTimeoutSpy.mockRestore();
    });
});
