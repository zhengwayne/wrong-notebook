import type { Prisma, PrismaClient } from "@prisma/client";
import { isPersona, type Persona } from "@/lib/personas";

/**
 * 新手引导：每个身份几步，进度只看真实数据（不看点击）。
 * 文案在前端（网页 translations / 小程序），这里只给步骤 key、是否完成和少量说明数据。
 */
export const ONBOARDING_STEPS = {
    teacher: ["class", "task", "collect", "confirm"],
    parent: ["child", "paper", "confirm", "review"],
    self: ["capture", "collect", "review"],
} as const satisfies Record<Persona, readonly string[]>;

export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[Persona][number];

/** 完成后多久自动收起 */
export const ONBOARDING_AUTO_HIDE_MS = 3 * 24 * 60 * 60 * 1000;

/** 自学第 2 步：攒到几道错题 */
export const SELF_COLLECT_TARGET = 5;

export interface OnboardingStep {
    key: OnboardingStepKey;
    done: boolean;
    /** 说明数据：班级名、人数、任务 id 等，供“已完成”一栏和按钮跳转 */
    meta?: Record<string, string | number | null>;
}

export interface OnboardingStatus {
    persona: Persona;
    steps: OnboardingStep[];
    doneCount: number;
    total: number;
    completed: boolean;
    /** 第一次全部完成的时间 */
    completedAt: string | null;
    /** 用户手动收起的时间 */
    dismissedAt: string | null;
    /** 是否显示引导卡（未收起、未完成或完成不满 3 天） */
    visible: boolean;
    /** 当前该做的一步（全部完成为 null） */
    current: OnboardingStepKey | null;
}

export interface OnboardingState {
    dismissed?: Partial<Record<Persona, string | null>>;
    completedAt?: Partial<Record<Persona, string | null>>;
}

export function parseOnboardingState(raw: string | null | undefined): OnboardingState {
    if (!raw) return {};
    try {
        const value = JSON.parse(raw) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) return {};
        const pick = (v: unknown): Partial<Record<Persona, string | null>> => {
            const out: Partial<Record<Persona, string | null>> = {};
            if (!v || typeof v !== "object") return out;
            for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
                if (isPersona(k) && (typeof val === "string" || val === null)) out[k] = val;
            }
            return out;
        };
        const obj = value as Record<string, unknown>;
        return { dismissed: pick(obj.dismissed), completedAt: pick(obj.completedAt) };
    } catch {
        return {};
    }
}

type Db = PrismaClient | Prisma.TransactionClient;

const selfLearnerWhere = (userId: string): Prisma.ErrorItemWhereInput => ({
    userId,
    OR: [{ learnerId: null }, { learner: { kind: "self" } }],
});

const childLearnerWhere = (userId: string): Prisma.ErrorItemWhereInput => ({
    userId,
    learner: { kind: "child", archivedAt: null },
});

async function teacherSteps(db: Db, userId: string): Promise<OnboardingStep[]> {
    const [cls, studentCount, task, submissionCount, confirmedCount] = await Promise.all([
        db.gradingClass.findFirst({
            where: { userId, students: { some: {} } },
            orderBy: { createdAt: "asc" },
            select: { id: true, name: true, _count: { select: { students: true } } },
        }),
        db.gradingStudent.count({ where: { class: { userId } } }),
        db.gradingTask.findFirst({
            where: { userId, OR: [{ taskMode: "quick" }, { questions: { some: {} } }] },
            orderBy: { createdAt: "desc" },
            select: { id: true, title: true },
        }),
        db.gradingSubmission.count({ where: { task: { userId } } }),
        db.gradingSubmission.count({ where: { task: { userId }, status: "confirmed" } }),
    ]);
    const latestWithPapers = submissionCount > 0
        ? await db.gradingSubmission.findFirst({ where: { task: { userId } }, orderBy: { createdAt: "desc" }, select: { taskId: true } })
        : null;
    return [
        { key: "class", done: Boolean(cls), meta: cls ? { classId: cls.id, className: cls.name, students: cls._count.students, totalStudents: studentCount } : undefined },
        { key: "task", done: Boolean(task), meta: task ? { taskId: task.id, title: task.title } : undefined },
        { key: "collect", done: submissionCount > 0, meta: { count: submissionCount, taskId: latestWithPapers?.taskId ?? task?.id ?? null } },
        { key: "confirm", done: confirmedCount > 0, meta: { count: confirmedCount, taskId: latestWithPapers?.taskId ?? task?.id ?? null } },
    ];
}

async function parentSteps(db: Db, userId: string): Promise<OnboardingStep[]> {
    const [child, paperCount, pending, itemCount, reviewed] = await Promise.all([
        db.learner.findFirst({ where: { userId, kind: "child", archivedAt: null }, orderBy: { order: "asc" }, select: { id: true, name: true } }),
        db.parentPaper.count({ where: { userId } }),
        db.parentPaper.findFirst({ where: { userId, status: { in: ["pending_confirmation", "recognizing", "pending_recognition"] } }, orderBy: { createdAt: "desc" }, select: { id: true, learnerId: true } }),
        db.errorItem.count({ where: childLearnerWhere(userId) }),
        db.practiceRecord.count({ where: { userId, result: { not: null }, errorItem: childLearnerWhere(userId) } }),
    ]);
    return [
        { key: "child", done: Boolean(child), meta: child ? { learnerId: child.id, name: child.name } : undefined },
        { key: "paper", done: paperCount > 0 || itemCount > 0, meta: { count: paperCount, learnerId: child?.id ?? null } },
        { key: "confirm", done: itemCount > 0, meta: { count: itemCount, paperId: pending?.id ?? null, learnerId: pending?.learnerId ?? child?.id ?? null } },
        { key: "review", done: reviewed > 0, meta: { count: reviewed, learnerId: child?.id ?? null } },
    ];
}

async function selfSteps(db: Db, userId: string): Promise<OnboardingStep[]> {
    const [itemCount, reviewed] = await Promise.all([
        db.errorItem.count({ where: selfLearnerWhere(userId) }),
        db.practiceRecord.count({ where: { userId, result: { not: null }, errorItem: selfLearnerWhere(userId) } }),
    ]);
    return [
        { key: "capture", done: itemCount > 0, meta: { count: itemCount } },
        { key: "collect", done: itemCount >= SELF_COLLECT_TARGET, meta: { count: Math.min(itemCount, SELF_COLLECT_TARGET), target: SELF_COLLECT_TARGET } },
        { key: "review", done: reviewed > 0, meta: { count: reviewed } },
    ];
}

export async function computeOnboardingSteps(db: Db, userId: string, persona: Persona): Promise<OnboardingStep[]> {
    if (persona === "teacher") return teacherSteps(db, userId);
    if (persona === "parent") return parentSteps(db, userId);
    return selfSteps(db, userId);
}

/** 由步骤和保存的状态得出展示状态；第一次全部完成时返回需要写回的 completedAt */
export function summarizeOnboarding(
    persona: Persona,
    steps: OnboardingStep[],
    state: OnboardingState,
    now = new Date(),
): { status: OnboardingStatus; newCompletedAt: string | null } {
    const doneCount = steps.filter((s) => s.done).length;
    const completed = doneCount === steps.length;
    let completedAt = state.completedAt?.[persona] ?? null;
    let newCompletedAt: string | null = null;
    if (completed && !completedAt) {
        completedAt = now.toISOString();
        newCompletedAt = completedAt;
    }
    const dismissedAt = state.dismissed?.[persona] ?? null;
    const autoHidden = completed && completedAt != null && now.getTime() - new Date(completedAt).getTime() > ONBOARDING_AUTO_HIDE_MS;
    const current = steps.find((s) => !s.done)?.key ?? null;
    return {
        status: {
            persona,
            steps,
            doneCount,
            total: steps.length,
            completed,
            completedAt: completed ? completedAt : null,
            dismissedAt,
            visible: !dismissedAt && !autoHidden,
            current,
        },
        newCompletedAt,
    };
}

export async function getOnboardingStatus(db: Db, userId: string, persona: Persona, now = new Date()): Promise<OnboardingStatus> {
    const [user, steps] = await Promise.all([
        db.user.findUnique({ where: { id: userId }, select: { onboardingState: true } }),
        computeOnboardingSteps(db, userId, persona),
    ]);
    const state = parseOnboardingState(user?.onboardingState);
    const { status, newCompletedAt } = summarizeOnboarding(persona, steps, state, now);
    if (newCompletedAt) {
        const next: OnboardingState = { ...state, completedAt: { ...state.completedAt, [persona]: newCompletedAt } };
        await db.user.update({ where: { id: userId }, data: { onboardingState: JSON.stringify(next) } }).catch(() => undefined);
    }
    return status;
}

/** 收起或重新打开；重新打开时也清掉完成时间，让完成态重新显示 3 天 */
export async function setOnboardingDismissed(db: Db, userId: string, persona: Persona, dismissed: boolean, now = new Date()): Promise<void> {
    const user = await db.user.findUnique({ where: { id: userId }, select: { onboardingState: true } });
    const state = parseOnboardingState(user?.onboardingState);
    const next: OnboardingState = {
        dismissed: { ...state.dismissed, [persona]: dismissed ? now.toISOString() : null },
        completedAt: dismissed ? { ...state.completedAt } : { ...state.completedAt, [persona]: null },
    };
    await db.user.update({ where: { id: userId }, data: { onboardingState: JSON.stringify(next) } });
}
