import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { GRADE_SEMESTERS } from '@/lib/grade-options';
import { parseLastPractice } from '@/lib/last-practice';
import { MAX_MASTERY_THRESHOLD, MIN_MASTERY_THRESHOLD } from '@/lib/mastery-status';
import { GRADE_RECOGNITION_MODES } from '@/lib/question-grade';
import { THEME_PREFERENCES } from '@/lib/theme';

const PREFERENCE_SCHEMAS = {
    gradeRecognitionMode: z.enum(GRADE_RECOGNITION_MODES),
    fixedGradeSemester: z.enum(GRADE_SEMESTERS).nullable(),
    confirmBeforeImport: z.boolean(),
    questionDuplicateThreshold: z.number().min(1).max(100),
    masteryThreshold: z.number().int().min(MIN_MASTERY_THRESHOLD).max(MAX_MASTERY_THRESHOLD),
    enableGeogebra: z.boolean(),
    enableSvgAnimation: z.boolean(),
    themePreference: z.enum(THEME_PREFERENCES),
    variantPipelineEnabled: z.boolean(),
};

export function parseUserPreferences(source: Record<string, unknown> | undefined | null): Prisma.UserUpdateInput {
    const preferences: Prisma.UserUpdateInput = {};
    if (!source) return preferences;
    for (const [key, schema] of Object.entries(PREFERENCE_SCHEMAS)) {
        const parsed = schema.safeParse(source[key]);
        if (parsed.success) {
            Object.assign(preferences, { [key]: parsed.data });
        }
    }
    return preferences;
}

export function asOptionalString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

export function asRequiredString(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

export function asOptionalNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asOptionalBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

export function asJsonText(value: unknown): string | null {
    if (value == null) return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
}

export function safeParseDate(value: unknown): Date | undefined {
    if (typeof value !== 'string' || !value) return undefined;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
}

export function safeMasteryProbability(val: unknown): number | null {
    return typeof val === 'number' && Number.isFinite(val) && val >= 0 && val <= 1 ? val : null;
}

export function safeLastPractice(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const practice = parseLastPractice(raw);
    return practice ? JSON.stringify(practice) : null;
}

export function safeMasteryLevel(val: unknown): number {
    const n = typeof val === 'number' ? val : parseInt(String(val), 10);
    if (Number.isNaN(n) || n < 0 || n > 2) return 0;
    return n;
}

export function mapStringArrayIds(raw: unknown, idMap: Map<string, string>): string {
    try {
        const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
        if (!Array.isArray(parsed)) return '[]';
        return JSON.stringify(
            parsed.flatMap((id) => (typeof id === 'string' && idMap.has(id) ? [idMap.get(id)!] : [])),
        );
    } catch {
        return '[]';
    }
}

export function mapNullableStringArrayIds(raw: unknown, idMap: Map<string, string>): string | null {
    if (raw == null) return null;
    try {
        const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(parsed)) return null;
        return JSON.stringify(
            parsed.flatMap((id) => (typeof id === 'string' && idMap.has(id) ? [idMap.get(id)!] : [])),
        );
    } catch {
        return null;
    }
}
