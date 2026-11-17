/**
 * 逐题记忆模型（FSRS 风格）：完全基于公开默认参数与幂律遗忘曲线的纯 TypeScript 实现（无外部 SRS 依赖）。
 * PracticeRecord 为唯一证据来源，所有状态可随时由作答历史确定性重算。
 */
import { getDayRange, shiftCalendarDate } from "@/lib/date-time";
import { getReviewPlan, isReviewDue, type ReviewRecord } from "@/lib/review-schedule";

export const REVIEW_ALGORITHM_VERSIONS = ["ebbinghaus-v1", "fsrs-v1"] as const;
export type ReviewAlgorithmVersion = (typeof REVIEW_ALGORITHM_VERSIONS)[number];
export const DEFAULT_REVIEW_ALGORITHM: ReviewAlgorithmVersion = "ebbinghaus-v1";

/** FSRS 风格幂律衰减常数：R(t, S) = (1 + (19/81) * t / S)^(-0.5)，t = S 时恰有 R = 0.9 */
const FSRS_FACTOR = 19 / 81;
const FSRS_DECAY = -0.5;
export const FSRS_TARGET_RETENTION = 0.9;
export const MAX_FSRS_INTERVAL_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ItemMemorySnapshot {
    stability: number;
    difficulty: number;
    lastReviewAt: Date | null;
    dueAt: Date;
    reps: number;
    lapses: number;
    algorithmVersion: "fsrs-v1";
}

function clamp(value: number, min: number, max: number): number {
    if (Number.isNaN(value)) return min;
    return Math.min(max, Math.max(min, value));
}

export function isReviewAlgorithmVersion(value: unknown): value is ReviewAlgorithmVersion {
    return typeof value === "string" && (REVIEW_ALGORITHM_VERSIONS as readonly string[]).includes(value);
}

/** 幂律可提取性 R(t, S) = (1 + (19/81) * t / S)^(-0.5) */
export function computeItemRetrievability(
    memory: Pick<ItemMemorySnapshot, "stability" | "lastReviewAt">,
    now = new Date(),
): number {
    if (!memory.lastReviewAt) return 0;
    const elapsedDays = Math.max(0, (now.getTime() - memory.lastReviewAt.getTime()) / MS_PER_DAY);
    const stability = Math.max(0.5, memory.stability);
    return clamp((1 + FSRS_FACTOR * (elapsedDays / stability)) ** FSRS_DECAY, 0, 1);
}

/** 由目标保留率 R* 推算下次间隔天数（R* = 0.9 时恰等于 S），限制在 1–365 天 */
export function fsrsIntervalDays(stability: number, targetRetention = FSRS_TARGET_RETENTION): number {
    const retention = clamp(targetRetention, 0.5, 0.99);
    const rawDays = Math.max(0.5, stability) * (((retention ** (1 / FSRS_DECAY)) - 1) / FSRS_FACTOR);
    return Math.min(MAX_FSRS_INTERVAL_DAYS, Math.max(1, Math.round(rawDays)));
}

function stepFsrsMemory(
    prev: ItemMemorySnapshot,
    outcome: "correct" | "wrong",
    at: Date,
    timeZone: string,
): ItemMemorySnapshot {
    const elapsedDays = prev.lastReviewAt
        ? Math.max(0, (at.getTime() - prev.lastReviewAt.getTime()) / MS_PER_DAY)
        : 0;
    const r = prev.lastReviewAt
        ? clamp((1 + FSRS_FACTOR * (elapsedDays / Math.max(0.5, prev.stability))) ** FSRS_DECAY, 0, 1)
        : 0.5;

    let nextDifficulty: number;
    let nextStability: number;
    let nextReps = prev.reps;
    let nextLapses = prev.lapses;

    if (outcome === "correct") {
        // 均值回归 + 温和降难，避免一次碰对就把高难题降到底
        nextDifficulty = clamp(prev.difficulty - 0.35 + (5 - prev.difficulty) * 0.08, 1, 10);
        if (prev.reps === 0) {
            nextStability = clamp(4 - 0.25 * (nextDifficulty - 1), 1.5, 5);
        } else {
            const difficultyFactor = Math.max(1.15, (11 - nextDifficulty) * 0.22);
            const spacingBonus = 1 + (1 - r);
            nextStability = Math.min(MAX_FSRS_INTERVAL_DAYS, prev.stability * (1 + 0.45 * difficultyFactor * spacingBonus));
        }
        nextReps += 1;
    } else {
        nextDifficulty = clamp(prev.difficulty + 0.8, 1, 10);
        nextStability = Math.max(0.5, Math.min(prev.stability * 0.4, 2));
        nextLapses += 1;
    }

    const intervalDays = fsrsIntervalDays(nextStability);
    const dueAt = getDayRange(shiftCalendarDate(at, timeZone, intervalDays), timeZone).start;

    return {
        stability: Math.round(nextStability * 1000) / 1000,
        difficulty: Math.round(nextDifficulty * 1000) / 1000,
        lastReviewAt: at,
        dueAt,
        reps: nextReps,
        lapses: nextLapses,
        algorithmVersion: "fsrs-v1",
    };
}

/**
 * 以 PracticeRecord 为唯一证据，确定性重算单道错题的 FSRS 风格记忆状态。
 * 未作答（not_attempted）的记录不改变记忆状态。
 */
export function replayItemMemory(itemCreatedAt: Date, records: ReviewRecord[], timeZone: string): ItemMemorySnapshot {
    const answered = records
        .filter((record): record is ReviewRecord & { result: "correct" | "wrong" } =>
            record.result === "correct" || record.result === "wrong",
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    let state: ItemMemorySnapshot = {
        stability: 1,
        difficulty: 5,
        lastReviewAt: null,
        dueAt: getDayRange(itemCreatedAt, timeZone).start,
        reps: 0,
        lapses: 0,
        algorithmVersion: "fsrs-v1",
    };

    for (const record of answered) {
        state = stepFsrsMemory(state, record.result, record.createdAt, timeZone);
    }
    return state;
}

/** 由知识点关联的多道错题聚合并计算平均可提取性 */
export function aggregateKnowledgeRetrievability(
    memories: Array<Pick<ItemMemorySnapshot, "stability" | "lastReviewAt">>,
    now = new Date(),
): number {
    if (memories.length === 0) return 1;
    const total = memories.reduce((sum, item) => sum + computeItemRetrievability(item, now), 0);
    return clamp(total / memories.length, 0, 1);
}

/** 统一计算单道错题在指定调度算法下的到期计划（纯函数，不读写数据库） */
export function computeItemDuePlan(
    itemCreatedAt: Date,
    records: ReviewRecord[],
    timeZone: string,
    algorithmVersion: ReviewAlgorithmVersion,
): { stage: number; nextReviewAt: Date | null; memory?: ItemMemorySnapshot } {
    if (algorithmVersion === "fsrs-v1") {
        const memory = replayItemMemory(itemCreatedAt, records, timeZone);
        return {
            stage: memory.reps,
            nextReviewAt: memory.dueAt,
            memory,
        };
    }
    return getReviewPlan(itemCreatedAt, records, timeZone);
}

export function isItemPlanDue(
    nextReviewAt: Date | null,
    timeZone: string,
    now = new Date(),
): boolean {
    return isReviewDue({ stage: 0, nextReviewAt }, timeZone, now);
}

export interface DueRecallEvaluation {
    algorithmVersion: ReviewAlgorithmVersion;
    dueAttempts: number;
    dueCorrect: number;
    recallAccuracy: number | null;
}

/**
 * 灰度对比度量：仅按作答历史回放到期时点之后的实际回忆正确率，不设预期达标数值。
 */
export function evaluateDueRecallAccuracy(
    items: Array<{ createdAt: Date; records: ReviewRecord[] }>,
    timeZone: string,
    algorithmVersion: ReviewAlgorithmVersion,
): DueRecallEvaluation {
    let dueAttempts = 0;
    let dueCorrect = 0;

    for (const item of items) {
        const answered = item.records
            .filter((record): record is ReviewRecord & { result: "correct" | "wrong" } =>
                record.result === "correct" || record.result === "wrong",
            )
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        const history: ReviewRecord[] = [];
        for (const attempt of answered) {
            const plan = computeItemDuePlan(item.createdAt, history, timeZone, algorithmVersion);
            if (isItemPlanDue(plan.nextReviewAt, timeZone, attempt.createdAt)) {
                dueAttempts += 1;
                if (attempt.result === "correct") dueCorrect += 1;
            }
            history.push(attempt);
        }
    }

    return {
        algorithmVersion,
        dueAttempts,
        dueCorrect,
        recallAccuracy: dueAttempts > 0 ? Math.round((dueCorrect / dueAttempts) * 1000) / 1000 : null,
    };
}
