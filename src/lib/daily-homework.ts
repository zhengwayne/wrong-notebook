export const HOMEWORK_CATEGORIES = ['written', 'recitation', 'dictation', 'review'] as const;
export type HomeworkCategory = (typeof HOMEWORK_CATEGORIES)[number];

export const HOMEWORK_SUBJECTS = [
    'math',
    'chinese',
    'english',
    'physics',
    'chemistry',
    'biology',
    'history',
    'geography',
    'politics',
    'other',
] as const;
export type HomeworkSubjectKey = (typeof HOMEWORK_SUBJECTS)[number];

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateKey(value: string | null | undefined): value is string {
    return typeof value === 'string' && DATE_KEY_PATTERN.test(value);
}

export function shiftDateKey(dateKey: string, deltaDays: number): string {
    const [yearStr, monthStr, dayStr] = dateKey.split('-');
    const utc = new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1, Number(dayStr) + deltaDays));
    const y = utc.getUTCFullYear();
    const m = String(utc.getUTCMonth() + 1).padStart(2, '0');
    const d = String(utc.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * 计算孩子的连续学习打卡天数：
 * - 若今天已有打卡（已完成作业或练习记录），从今天起向前逐日回溯；
 * - 若今天尚未完成打卡但昨天已打卡，则保留截至昨天的连续天数，避免当天未完成前清零打击积极性。
 */
export function computeHomeworkStreak(activeDateKeys: Iterable<string>, todayKey: string): number {
    if (!isValidDateKey(todayKey)) return 0;
    const activeSet = new Set<string>();
    for (const key of activeDateKeys) {
        if (isValidDateKey(key)) activeSet.add(key);
    }

    let cursor = todayKey;
    if (!activeSet.has(cursor)) {
        const yesterday = shiftDateKey(todayKey, -1);
        if (!activeSet.has(yesterday)) {
            return 0;
        }
        cursor = yesterday;
    }

    let streak = 0;
    while (activeSet.has(cursor) && streak < 3660) {
        streak += 1;
        cursor = shiftDateKey(cursor, -1);
    }
    return streak;
}
