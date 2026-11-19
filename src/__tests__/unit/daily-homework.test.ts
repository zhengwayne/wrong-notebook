import { describe, expect, it } from 'vitest';
import { computeHomeworkStreak } from '@/lib/daily-homework';

describe('daily-homework 连续打卡天数计算', () => {
    it('今天已完成时从今天起向前回溯连续天数', () => {
        const active = ['2026-11-17', '2026-11-18', '2026-11-19'];
        expect(computeHomeworkStreak(active, '2026-11-19')).toBe(3);
    });

    it('今天尚未打卡但昨天已打卡时保留截至昨天的连续记录（不提前清零）', () => {
        const active = ['2026-11-16', '2026-11-17', '2026-11-18'];
        expect(computeHomeworkStreak(active, '2026-11-19')).toBe(3);
    });

    it('今天与昨天均未打卡时连续天数归零，跨月边界计算准确', () => {
        expect(computeHomeworkStreak(['2026-11-16', '2026-11-17'], '2026-11-19')).toBe(0);
        expect(computeHomeworkStreak(['2026-10-30', '2026-10-31', '2026-11-01'], '2026-11-01')).toBe(3);
    });
});
