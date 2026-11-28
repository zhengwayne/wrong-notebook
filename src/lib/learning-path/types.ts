/**
 * 学习路径领域类型。
 *
 * 设计借鉴（只吸收思路，不复制代码）：
 * - HKUDS/DeepTutor（Apache-2.0）：Mastery Path 的阶段门（讲解 → 练习 → 错因诊断 → 间隔复习 → 完成）、
 *   按知识点跟踪掌握、近期加权与低证据置信度上限、有新证据时再规划。
 * - 经典 BKT（Corbett & Anderson）：每知识点 P(L) 的贝叶斯更新，参数公开、实现短小。
 * - FSRS / ts-fsrs（MIT，open-spaced-repetition/ts-fsrs）：可提取性随时间衰减、答对提升稳定性、
 *   答错降低稳定性；本仓库不引入依赖、不复制其权重与源码，只用公开的衰减直觉，
 *   到期档位仍沿用本项目已有的 1/2/4/7/15/30 天间隔（src/lib/review-schedule.ts）。
 * - KnowledgeTag 邻接表作为先修 DAG，Kahn 拓扑排序决定薄弱点顺序（与 noesis-core、plcourse
 *   等 MIT 项目的技能图思路一致，独立实现）。
 *
 * 规划本身是确定性的：不调用 AI。已有错题解析直接复用；教师可手工调序/锁定步骤。
 * AI 仅用于可选的「建议顺序」，且有每日次数上限。
 */
export const SELF_STUDENT_KEY = "self";

export const STEP_TYPES = ["review_explanation", "variant_practice", "spaced_review", "checkpoint"] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const STEP_STATUSES = ["pending", "in_progress", "completed", "skipped"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const EVIDENCE_SOURCES = ["error", "review", "grading", "variant_practice"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export interface MasteryEvidence {
    knowledgePoint: string;
    correct: boolean;
    at: Date;
    source: EvidenceSource;
    itemId?: string;
    /** 部分正确等不完全证据，0~1，默认 1 */
    weight?: number;
}

export interface KnowledgeMasteryState {
    knowledgePoint: string;
    pKnown: number;
    retrievability: number;
    stabilityDays: number;
    evidenceCount: number;
    lastCorrect: boolean | null;
    lastObservedAt: Date | null;
    dueAt: Date | null;
    /** pKnown × retrievability，并在证据不足时加置信度上限 */
    score: number;
}

export interface PlannedStep {
    type: StepType;
    title: string;
    reason: string;
    knowledgePoints: string[];
    errorItemIds: string[];
    href?: string;
    dueAt?: Date | null;
    fingerprint: string;
}

export interface PreservedStep {
    id?: string;
    type: StepType;
    title: string;
    reason: string;
    knowledgePoints: string[];
    errorItemIds: string[];
    href?: string | null;
    dueAt?: Date | null;
    status: StepStatus;
    locked: boolean;
    teacherNote?: string | null;
    completedAt?: Date | null;
    variantRunId?: string | null;
    fingerprint: string;
}

export interface PlannerInput {
    weaknesses: Array<{
        knowledgePoint: string;
        score: number;
        unmasteredCount: number;
        representativeItemIds: string[];
    }>;
    mastery: Map<string, KnowledgeMasteryState>;
    dueItemIds: string[];
    itemMeta: Map<string, { knowledgePoints: string[]; questionText?: string | null; analysis?: string | null }>;
    orderedPoints: string[];
    preserved: PreservedStep[];
    language: "zh" | "en";
    now?: Date;
    maxSteps?: number;
    masteryCutoff?: number;
}

export function stepFingerprint(type: StepType, knowledgePoints: string[], errorItemIds: string[] = []): string {
    const points = [...knowledgePoints].map((name) => name.trim()).filter(Boolean).sort().join(",");
    const items = [...errorItemIds].sort().join(",");
    return `${type}:${points}:${items}`;
}
