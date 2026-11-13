/**
 * 按知识点更新掌握模型：BKT 更新观察，再用简单的可提取性衰减决定是否到期。
 * 公式与参数均在本文件内写明，不依赖外部 SRS 库。
 */
import { REVIEW_INTERVALS } from "@/lib/review-schedule";
import { getDayRange, shiftCalendarDate } from "@/lib/date-time";
import type { KnowledgeMasteryState, MasteryEvidence } from "./types";

/** 经典 BKT 默认参数（公开文献常用量级，不做个性化拟合） */
export const BKT = {
    pL0: 0.3,
    pTransit: 0.12,
    pGuess: 0.2,
    pSlip: 0.1,
} as const;

/** 证据少于该次数时，掌握分设上限，避免一次碰巧做对就判已掌握（DeepTutor 低置信度上限的思路） */
export const LOW_EVIDENCE_CAP = 0.55;
export const LOW_EVIDENCE_COUNT = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function clamp01(value: number): number {
    if (Number.isNaN(value)) return 0;
    return Math.min(1, Math.max(0, value));
}

/**
 * 一次对/错观察后的 BKT 后验，再加学习转移。
 * weight < 1 时，在更新前后验之间线性插值（用于部分正确）。
 */
export function updateBkt(pKnown: number, correct: boolean, weight = 1): number {
    const pL = clamp01(pKnown);
    const pCorrect = pL * (1 - BKT.pSlip) + (1 - pL) * BKT.pGuess;
    const pWrong = 1 - pCorrect;
    let posterior: number;
    if (correct) {
        posterior = pCorrect <= 0 ? pL : (pL * (1 - BKT.pSlip)) / pCorrect;
    } else {
        posterior = pWrong <= 0 ? pL : (pL * BKT.pSlip) / pWrong;
    }
    const blended = pL + (posterior - pL) * clamp01(weight);
    const learned = blended + (1 - blended) * BKT.pTransit;
    return clamp01(learned);
}

/**
 * 可提取性：R = (1 + days / S)^(-0.5)。
 * 这是公开的幂衰减形式，不是 ts-fsrs 的拟合权重实现。
 */
export function retrievability(stabilityDays: number, daysSince: number): number {
    const stability = Math.max(0.5, stabilityDays);
    const days = Math.max(0, daysSince);
    return clamp01((1 + days / stability) ** -0.5);
}

export function updateStability(stabilityDays: number, correct: boolean, pKnown: number): number {
    const current = Math.max(0.5, stabilityDays);
    if (correct) {
        return Math.min(180, current * (1.4 + pKnown));
    }
    return Math.max(0.5, current * 0.5);
}

export function masteryScore(state: Pick<KnowledgeMasteryState, "pKnown" | "retrievability" | "evidenceCount">): number {
    const raw = clamp01(state.pKnown * state.retrievability);
    if (state.evidenceCount < LOW_EVIDENCE_COUNT) {
        return Math.min(raw, LOW_EVIDENCE_CAP);
    }
    return raw;
}

export function dueFromIntervals(lastObservedAt: Date | null, consecutiveCorrect: number, timeZone: string, now = new Date()): Date | null {
    const stage = Math.max(0, consecutiveCorrect);
    if (stage >= REVIEW_INTERVALS.length) return null;
    const start = lastObservedAt ?? now;
    return getDayRange(shiftCalendarDate(start, timeZone, REVIEW_INTERVALS[stage]), timeZone).start;
}

export interface TraceMasteryOptions {
    now?: Date;
    timeZone?: string;
}

/**
 * 按时间顺序回放某知识点的全部证据，得到当前掌握快照。
 */
export function traceKnowledgeMastery(
    knowledgePoint: string,
    evidence: MasteryEvidence[],
    options: TraceMasteryOptions = {},
): KnowledgeMasteryState {
    const now = options.now ?? new Date();
    const timeZone = options.timeZone ?? "Asia/Taipei";
    const rows = evidence
        .filter((item) => item.knowledgePoint === knowledgePoint)
        .sort((a, b) => a.at.getTime() - b.at.getTime() || a.source.localeCompare(b.source));

    let pKnown: number = BKT.pL0;
    let stabilityDays = 1;
    let consecutiveCorrect = 0;
    let lastCorrect: boolean | null = null;
    let lastObservedAt: Date | null = null;

    for (const row of rows) {
        const daysSince = lastObservedAt ? (row.at.getTime() - lastObservedAt.getTime()) / MS_PER_DAY : 0;
        const currentR = retrievability(stabilityDays, daysSince);
        // 先按遗忘衰减再更新，避免把很久以前的高掌握直接带到今天
        pKnown = clamp01(pKnown * (0.5 + 0.5 * currentR));
        pKnown = updateBkt(pKnown, row.correct, row.weight ?? 1);
        stabilityDays = updateStability(stabilityDays, row.correct, pKnown);
        lastCorrect = row.correct;
        lastObservedAt = row.at;
        consecutiveCorrect = row.correct ? consecutiveCorrect + 1 : 0;
    }

    const daysSince = lastObservedAt ? (now.getTime() - lastObservedAt.getTime()) / MS_PER_DAY : 0;
    const r = lastObservedAt ? retrievability(stabilityDays, daysSince) : 1;
    const evidenceCount = rows.length;
    const state: KnowledgeMasteryState = {
        knowledgePoint,
        pKnown,
        retrievability: r,
        stabilityDays,
        evidenceCount,
        lastCorrect,
        lastObservedAt,
        dueAt: dueFromIntervals(lastObservedAt, consecutiveCorrect, timeZone, now),
        score: 0,
    };
    state.score = masteryScore(state);
    return state;
}

export function buildMasteryMap(evidence: MasteryEvidence[], options: TraceMasteryOptions = {}): Map<string, KnowledgeMasteryState> {
    const points = [...new Set(evidence.map((item) => item.knowledgePoint).filter(Boolean))];
    const map = new Map<string, KnowledgeMasteryState>();
    for (const point of points) {
        map.set(point, traceKnowledgeMastery(point, evidence, options));
    }
    return map;
}

export function evidenceHash(evidence: MasteryEvidence[]): string {
    const rows = evidence
        .map((item) => `${item.source}:${item.itemId ?? ""}:${item.knowledgePoint}:${item.correct ? 1 : 0}:${item.at.toISOString()}:${item.weight ?? 1}`)
        .sort();
    // 短哈希：不引入 crypto 依赖也可在边缘运行；碰撞风险对本用途可接受
    let hash = 0;
    const text = `${rows.length}|${rows.join("|")}`;
    for (let i = 0; i < text.length; i++) {
        hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    return `${rows.length}:${(hash >>> 0).toString(16)}`;
}
