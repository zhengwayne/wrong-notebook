import { describe, expect, it } from 'vitest';
import {
    aggregateKnowledgeRetrievability,
    computeItemDuePlan,
    computeItemRetrievability,
    evaluateDueRecallAccuracy,
    fsrsIntervalDays,
    isItemPlanDue,
    replayItemMemory,
} from '@/lib/memory-model';

const TZ = 'Asia/Shanghai';
const d = (iso: string) => new Date(iso);

describe('逐题记忆模型 (OPT-12b)', () => {
    it('未答错题与仅 not_attempted 记录不产生复习推进，dueAt 为建题当天起点', () => {
        const createdAt = d('2026-10-01T08:00:00+08:00');
        const empty = replayItemMemory(createdAt, [], TZ);
        const skippedOnly = replayItemMemory(createdAt, [
            { result: 'not_attempted', createdAt: d('2026-10-02T10:00:00+08:00') },
        ], TZ);

        expect(empty.reps).toBe(0);
        expect(empty.lapses).toBe(0);
        expect(empty.lastReviewAt).toBeNull();
        expect(empty.dueAt.toISOString()).toBe('2026-09-30T16:00:00.000Z');
        expect(skippedOnly).toEqual(empty);
    });

    it('连续答对使 stability 单调递增，间隔随熟练度拉长且封顶 365 天', () => {
        const createdAt = d('2026-01-01T08:00:00+08:00');
        const oneRight = replayItemMemory(createdAt, [
            { result: 'correct', createdAt: d('2026-01-01T12:00:00+08:00') },
        ], TZ);
        const twoRight = replayItemMemory(createdAt, [
            { result: 'correct', createdAt: d('2026-01-01T12:00:00+08:00') },
            { result: 'correct', createdAt: d('2026-01-05T12:00:00+08:00') },
        ], TZ);
        const threeRight = replayItemMemory(createdAt, [
            { result: 'correct', createdAt: d('2026-01-01T12:00:00+08:00') },
            { result: 'correct', createdAt: d('2026-01-05T12:00:00+08:00') },
            { result: 'correct', createdAt: d('2026-01-18T12:00:00+08:00') },
        ], TZ);

        expect(oneRight.reps).toBe(1);
        expect(twoRight.reps).toBe(2);
        expect(threeRight.reps).toBe(3);
        expect(twoRight.stability).toBeGreaterThan(oneRight.stability);
        expect(threeRight.stability).toBeGreaterThan(twoRight.stability);
        expect(threeRight.dueAt.getTime()).toBeGreaterThan(twoRight.dueAt.getTime());
        expect(fsrsIntervalDays(10000)).toBe(365);
    });

    it('答错触发 lapse 增加与稳定性收缩，同时乱序输入也可确定性重算', () => {
        const createdAt = d('2026-03-01T08:00:00+08:00');
        const records = [
            { result: 'correct', createdAt: d('2026-03-01T10:00:00+08:00') },
            { result: 'correct', createdAt: d('2026-03-05T10:00:00+08:00') },
            { result: 'wrong', createdAt: d('2026-03-10T10:00:00+08:00') },
        ];
        const beforeWrong = replayItemMemory(createdAt, records.slice(0, 2), TZ);
        const afterWrong = replayItemMemory(createdAt, records, TZ);
        const shuffledReplay = replayItemMemory(createdAt, [records[2], records[0], records[1]], TZ);

        expect(afterWrong.lapses).toBe(1);
        expect(afterWrong.stability).toBeLessThan(beforeWrong.stability);
        expect(afterWrong.difficulty).toBeGreaterThan(beforeWrong.difficulty);
        expect(shuffledReplay).toEqual(afterWrong);
    });

    it('知识点聚合可提取性平滑合并多道题目的当前记忆保留率', () => {
        const now = d('2026-05-10T12:00:00+08:00');
        expect(aggregateKnowledgeRetrievability([], now)).toBe(1);

        const freshR = computeItemRetrievability({ stability: 10, lastReviewAt: now }, now);
        const decayedR = computeItemRetrievability({
            stability: 2,
            lastReviewAt: d('2026-04-10T12:00:00+08:00'),
        }, now);
        expect(freshR).toBeCloseTo(1, 5);
        expect(decayedR).toBeLessThan(0.6);

        const agg = aggregateKnowledgeRetrievability([
            { stability: 10, lastReviewAt: now },
            { stability: 2, lastReviewAt: d('2026-04-10T12:00:00+08:00') },
        ], now);
        expect(agg).toBeCloseTo((freshR + decayedR) / 2, 5);
    });

    it('computeItemDuePlan 与 evaluateDueRecallAccuracy 支持两种算法灰度对照', () => {
        const createdAt = d('2026-02-01T08:00:00+08:00');
        const records = [
            { result: 'correct', createdAt: d('2026-02-01T12:00:00+08:00') },
            { result: 'correct', createdAt: d('2026-02-04T12:00:00+08:00') },
            { result: 'wrong', createdAt: d('2026-02-10T12:00:00+08:00') },
        ];

        const ebPlan = computeItemDuePlan(createdAt, records, TZ, 'ebbinghaus-v1');
        const fsrsPlan = computeItemDuePlan(createdAt, records, TZ, 'fsrs-v1');

        expect(ebPlan.stage).toBe(0);
        expect(fsrsPlan.stage).toBe(2);
        expect(fsrsPlan.memory?.lapses).toBe(1);
        expect(isItemPlanDue(fsrsPlan.nextReviewAt, TZ, d('2026-02-20T12:00:00+08:00'))).toBe(true);

        const ebEval = evaluateDueRecallAccuracy([{ createdAt, records }], TZ, 'ebbinghaus-v1');
        const fsrsEval = evaluateDueRecallAccuracy([{ createdAt, records }], TZ, 'fsrs-v1');
        expect(ebEval.algorithmVersion).toBe('ebbinghaus-v1');
        expect(fsrsEval.algorithmVersion).toBe('fsrs-v1');
        expect(ebEval.dueAttempts).toBeGreaterThan(0);
        expect(fsrsEval.dueAttempts).toBeGreaterThan(0);
    });
});
