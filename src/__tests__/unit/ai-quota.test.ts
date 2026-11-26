import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    aiUsage: { count: vi.fn(), create: vi.fn() },
    config: { aiDailyLimit: 3 } as { aiDailyLimit?: number },
}));

vi.mock('@/lib/prisma', () => ({ prisma: { aiUsage: mocks.aiUsage } }));
vi.mock('@/lib/config', () => ({ getAppConfig: () => mocks.config, getAppTimeZone: () => 'Asia/Shanghai' }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { countTodayAiUsage, reserveAiQuota, runWithAiQuota } from '@/lib/ai-quota';

describe('reserveAiQuota（无完整数据库时）', () => {
    beforeEach(() => vi.clearAllMocks());

    it('统计不可用时放行且不计数，不影响正常使用', async () => {
        const quota = await reserveAiQuota({ id: 'kid', role: 'user' }, 'analyze');
        expect(quota.limited).toBeNull();
        expect(quota.id).toBeNull();
        await quota.confirm();
        await quota.release();
        expect(mocks.aiUsage.create).not.toHaveBeenCalled();
    });

    it('runWithAiQuota：成功按判定结算，抛错时退回并继续抛出', async () => {
        const quota = { settle: vi.fn(async () => {}), release: vi.fn(async () => {}) } as unknown as Parameters<typeof runWithAiQuota>[0];
        expect(await runWithAiQuota(quota, async () => ({ n: 0 }), (r) => r.n > 0)).toEqual({ n: 0 });
        expect(quota.settle).toHaveBeenCalledWith(false);
        await expect(runWithAiQuota(quota, async () => { throw new Error('AI_TIMEOUT_ERROR'); })).rejects.toThrow('AI_TIMEOUT_ERROR');
        expect(quota.release).toHaveBeenCalledTimes(1);
    });
});

describe('countTodayAiUsage', () => {
    it('按应用时区的今天只统计已确认（成功）的调用', async () => {
        mocks.aiUsage.count.mockResolvedValue(5);

        // 北京时间 2026-10-20 01:00
        expect(await countTodayAiUsage('kid', new Date('2026-10-19T17:00:00Z'))).toBe(5);
        expect(mocks.aiUsage.count).toHaveBeenCalledWith({
            where: { userId: 'kid', status: 'confirmed', createdAt: { gte: new Date('2026-10-19T16:00:00Z'), lt: new Date('2026-10-20T16:00:00Z') } },
        });
    });
});
