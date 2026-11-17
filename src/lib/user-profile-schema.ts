import { z } from "zod";
import { MAX_MASTERY_THRESHOLD, MIN_MASTERY_THRESHOLD } from "@/lib/mastery-status";
import { THEME_PREFERENCES } from "@/lib/theme";
import { GRADE_RECOGNITION_MODES } from "@/lib/question-grade";
import { GRADE_SEMESTERS } from "@/lib/grade-options";

/** 用户资料与偏好更新校验模型（独立导出以避免 Next.js 路由导出约束冲突） */
export const userUpdateSchema = z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    password: z.string().optional(),
    educationStage: z.string().optional(),
    enrollmentYear: z.number().optional().nullable(),
    gradeRecognitionMode: z.enum(GRADE_RECOGNITION_MODES).optional(),
    fixedGradeSemester: z.enum(GRADE_SEMESTERS).nullable().optional(),
    confirmBeforeImport: z.boolean().optional(),
    enableGeogebra: z.boolean().optional(),
    enableSvgAnimation: z.boolean().optional(),
    variantPipelineEnabled: z.boolean().optional(),
    themePreference: z.enum(THEME_PREFERENCES).optional(),
    questionDuplicateThreshold: z.number().min(1).max(100).multipleOf(0.01).optional(),
    masteryThreshold: z.number().int().min(MIN_MASTERY_THRESHOLD).max(MAX_MASTERY_THRESHOLD).optional(),
});

export type UserUpdateInput = z.infer<typeof userUpdateSchema>;
