import { clampScore } from "@/lib/grading";

export const GRADING_GRADE_LEVELS = ["excellent", "good", "pass", "needs_revision"] as const;
export type GradingGradeLevel = typeof GRADING_GRADE_LEVELS[number];

export const SCORING_MODES = ["numeric", "grade"] as const;
export type ScoringMode = typeof SCORING_MODES[number];

export const TASK_MODES = ["standard", "quick"] as const;
export type TaskMode = typeof TASK_MODES[number];

const GRADE_SCORE_RATIO: Record<GradingGradeLevel, number> = {
    excellent: 1,
    good: 0.85,
    pass: 0.65,
    needs_revision: 0.3,
};

/** 将得分与满分折算为四档日常作业等级（优 / 良 / 合格 / 待订正） */
export function scoreRatioToGradeLevel(score: number, maxScore: number): GradingGradeLevel {
    if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) {
        return "needs_revision";
    }
    const ratio = score / maxScore;
    if (ratio >= 0.9) return "excellent";
    if (ratio >= 0.75) return "good";
    if (ratio >= 0.6) return "pass";
    return "needs_revision";
}

/** 将老师点选的作业等级折算回半分精度的内部得分，兼容掌握度与班级均分统计 */
export function gradeLevelToScore(level: GradingGradeLevel, maxScore: number): number {
    if (!Number.isFinite(maxScore) || maxScore <= 0) return 0;
    const ratio = GRADE_SCORE_RATIO[level] ?? 0;
    return clampScore(maxScore * ratio, maxScore);
}
