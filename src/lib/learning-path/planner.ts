/**
 * 确定性学习路径规划：讲解原错题解析 → 针对性变式练习 → 到期间隔复习 → 检查点。
 * 新证据到来时只重排未锁定、未完成的步骤；教师锁定或已完成的步骤原样保留。
 */
import type { PlannedStep, PlannerInput, PreservedStep, StepType } from "./types";
import { stepFingerprint } from "./types";

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_CUTOFF = 0.7;

interface Copy {
    reviewTitle: (kp: string) => string;
    reviewReason: (kp: string) => string;
    practiceTitle: (kp: string) => string;
    practiceReason: (kp: string) => string;
    spacedTitle: (count: number) => string;
    spacedReason: (count: number) => string;
    checkpointTitle: string;
    checkpointReason: (kps: string[]) => string;
    planReason: (points: string[], replanned: boolean) => string;
}

const COPY: Record<"zh" | "en", Copy> = {
    zh: {
        reviewTitle: (kp) => `回顾「${kp}」解析`,
        reviewReason: (kp) => `先看原错题讲解，补齐「${kp}」的概念缺口，再进入练习。`,
        practiceTitle: (kp) => `针对「${kp}」做变式练习`,
        practiceReason: (kp) => `用已有审核流水线生成针对「${kp}」的变式题，需教师审核通过后才记入练习。`,
        spacedTitle: (count) => `间隔复习 ${count} 道到期题`,
        spacedReason: (count) => `有 ${count} 道题已到复习日，先巩固再往下学新的薄弱点。`,
        checkpointTitle: "今日检查点",
        checkpointReason: (kps) => `用一小次自测确认今天覆盖的知识点：${kps.join("、") || "相关内容"}。`,
        planReason: (points, replanned) =>
            `${replanned ? "根据最新错题与作答结果重新规划。" : "根据错题本薄弱点与先修关系生成路径。"}优先补齐：${points.slice(0, 5).join("、") || "暂无薄弱点"}。`,
    },
    en: {
        reviewTitle: (kp) => `Review the explanation of “${kp}”`,
        reviewReason: (kp) => `Revisit the original worked solution for “${kp}” before practicing.`,
        practiceTitle: (kp) => `Targeted variant practice for “${kp}”`,
        practiceReason: (kp) => `Generate variants for “${kp}” through the existing review pipeline. Only teacher-approved items count.`,
        spacedTitle: (count) => `Spaced review of ${count} due question(s)`,
        spacedReason: (count) => `${count} question(s) are due today. Review them before moving on.`,
        checkpointTitle: "Today’s checkpoint",
        checkpointReason: (kps) => `A short check on today’s topics: ${kps.join(", ") || "today’s work"}.`,
        planReason: (points, replanned) =>
            `${replanned ? "Replanned from the latest errors and results. " : "Planned from notebook weaknesses and prerequisites. "}Focus: ${points.slice(0, 5).join(", ") || "no open weaknesses"}.`,
    },
};

function asPreserved(step: PlannedStep, extra: Partial<PreservedStep> = {}): PreservedStep {
    return {
        type: step.type,
        title: step.title,
        reason: step.reason,
        knowledgePoints: step.knowledgePoints,
        errorItemIds: step.errorItemIds,
        href: step.href,
        dueAt: step.dueAt,
        status: "pending",
        locked: false,
        fingerprint: step.fingerprint,
        ...extra,
    };
}

function explanationHref(itemId?: string): string | undefined {
    return itemId ? `/error-items/${itemId}` : undefined;
}

function isStale(step: PreservedStep, latestEvidenceAt: Map<string, Date>): boolean {
    if (step.status !== "completed" || !step.completedAt) return false;
    return step.knowledgePoints.some((point) => {
        const at = latestEvidenceAt.get(point);
        return Boolean(at && at.getTime() > step.completedAt!.getTime());
    });
}

export interface PlanResult {
    steps: PreservedStep[];
    planReason: string;
    focusPoints: string[];
}

/**
 * 生成或重排学习路径。保留锁定步骤与仍有效的已完成步骤，再按先修顺序补齐缺失的讲解/变式，
 * 必要时加入到期复习和收尾检查点。
 */
export function planLearningPath(input: PlannerInput): PlanResult {
    const copy = COPY[input.language];
    const now = input.now ?? new Date();
    const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
    const cutoff = input.masteryCutoff ?? DEFAULT_CUTOFF;
    const latestEvidenceAt = new Map<string, Date>();
    for (const [point, state] of input.mastery) {
        if (state.lastObservedAt) latestEvidenceAt.set(point, state.lastObservedAt);
    }

    const kept: PreservedStep[] = [];
    const occupied = new Set<string>();
    for (const step of input.preserved) {
        const stale = isStale(step, latestEvidenceAt);
        if (step.locked || (step.status === "completed" && !stale) || step.status === "in_progress") {
            kept.push(step);
            occupied.add(step.fingerprint);
            continue;
        }
        if (step.status === "completed" && stale) {
            // 完成后又出现新错/新结果：旧完成步保留作记录，但允许再规划同类型步骤
            kept.push(step);
        }
    }

    const weakPoints = input.orderedPoints.filter((point) => {
        const mastery = input.mastery.get(point);
        const weakness = input.weaknesses.find((item) => item.knowledgePoint === point);
        if (!weakness) return false;
        return (mastery?.score ?? 0) < cutoff || weakness.unmasteredCount > 0;
    });

    const planned: PlannedStep[] = [];
    const covered: string[] = [];

    const tryPush = (type: StepType, knowledgePoints: string[], errorItemIds: string[], title: string, reason: string, href?: string, dueAt?: Date | null) => {
        const fingerprint = stepFingerprint(type, knowledgePoints, type === "review_explanation" || type === "variant_practice" ? errorItemIds.slice(0, 1) : []);
        if (occupied.has(fingerprint)) return false;
        planned.push({ type, title, reason, knowledgePoints, errorItemIds, href, dueAt: dueAt ?? null, fingerprint });
        occupied.add(fingerprint);
        return true;
    };

    if (input.dueItemIds.length > 0) {
        const ids = input.dueItemIds.slice(0, 5);
        const points = [...new Set(ids.flatMap((id) => input.itemMeta.get(id)?.knowledgePoints ?? []))];
        tryPush("spaced_review", points, ids, copy.spacedTitle(ids.length), copy.spacedReason(ids.length), "/review", now);
    }

    for (const point of weakPoints) {
        if (kept.length + planned.length >= maxSteps - 1) break;
        const weakness = input.weaknesses.find((item) => item.knowledgePoint === point);
        const itemId = weakness?.representativeItemIds[0];
        const ids = itemId ? [itemId] : [];
        if (tryPush("review_explanation", [point], ids, copy.reviewTitle(point), copy.reviewReason(point), explanationHref(itemId))) {
            covered.push(point);
        }
        if (kept.length + planned.length >= maxSteps - 1) break;
        if (tryPush("variant_practice", [point], ids, copy.practiceTitle(point), copy.practiceReason(point), itemId ? `/practice?itemId=${itemId}` : "/variants")) {
            if (!covered.includes(point)) covered.push(point);
        }
    }

    const checkpointPoints = covered.slice(0, 5);
    if (checkpointPoints.length > 0 || planned.length > 0 || input.dueItemIds.length > 0) {
        const points = checkpointPoints.length > 0 ? checkpointPoints : weakPoints.slice(0, 3);
        tryPush("checkpoint", points, [], copy.checkpointTitle, copy.checkpointReason(points), "/practice");
    }

    const merged = [...kept, ...planned.map((step) => asPreserved(step))]
        .slice(0, Math.max(maxSteps, kept.length))
        .map((step, index) => ({ ...step, positionHint: index }));

    const focus = weakPoints.slice(0, 5);
    return {
        steps: merged,
        planReason: copy.planReason(focus, input.preserved.length > 0),
        focusPoints: focus,
    };
}

export function todaySteps(steps: Array<PreservedStep & { dueAt?: Date | null }>, now = new Date()): PreservedStep[] {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    const open = steps.filter((step) => step.status !== "completed" && step.status !== "skipped");
    const due = open.filter((step) => !step.dueAt || step.dueAt.getTime() <= end.getTime());
    return due.length > 0 ? due : open.slice(0, 4);
}
