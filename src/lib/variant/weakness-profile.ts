/**
 * 根据学生错题本（知识点、错因、掌握与复习状态、新旧程度）生成弱点画像，
 * 并据此选题、安排由易到难的练习，以及汇总班级共性薄弱点。
 */
import { masteryStatusOf, type MasteryStatus, DEFAULT_MASTERY_THRESHOLD } from '@/lib/mastery-status';
import { DIFFICULTIES, type VariantDifficulty } from './schemas';

const HALF_LIFE_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ProfileItem {
    id: string;
    knowledgePoints: string[];
    errorType?: string | null;
    createdAt: Date | string;
    lastPracticedAt?: Date | string | null;
    practiceCount: number;
    wrongPracticeCount?: number;
    masteryProbability?: number | null;
    masteryStatus?: MasteryStatus;
}

export interface KnowledgeWeakness {
    knowledgePoint: string;
    score: number;
    itemCount: number;
    unmasteredCount: number;
    recentCount: number;
    errorTypes: Record<string, number>;
    representativeItemIds: string[];
}

export interface WeaknessProfile {
    itemCount: number;
    weaknesses: KnowledgeWeakness[];
    errorTypeSummary: Record<string, number>;
    suggestedDifficulty: VariantDifficulty;
    analyzedAt: string;
}

export interface PracticeSlot {
    knowledgePoint: string;
    difficulty: VariantDifficulty;
    sourceItemId: string;
}

export interface ClassWeakness {
    knowledgePoint: string;
    studentCount: number;
    averageScore: number;
    totalItems: number;
}

function toDate(value: Date | string | null | undefined): Date | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function recencyWeight(date: Date, now: Date): number {
    const days = Math.max(0, (now.getTime() - date.getTime()) / MS_PER_DAY);
    return Math.pow(2, -days / HALF_LIFE_DAYS);
}

function statusWeight(status: MasteryStatus): number {
    if (status === 'new') return 1.2;
    if (status === 'reviewing') return 1;
    return 0.25;
}

function pointsOf(item: ProfileItem): string[] {
    const unique = [...new Set(item.knowledgePoints.map((name) => name.trim()).filter(Boolean))];
    return unique.length > 0 ? unique : ['（未标注知识点）'];
}

/** 为一名学生的错题列表生成弱点画像（纯函数，便于单测） */
export function buildWeaknessProfile(
    items: ProfileItem[],
    options: { now?: Date; masteryThreshold?: number; recentDays?: number } = {},
): WeaknessProfile {
    const now = options.now ?? new Date();
    const threshold = options.masteryThreshold ?? DEFAULT_MASTERY_THRESHOLD;
    const recentDays = options.recentDays ?? HALF_LIFE_DAYS;
    const buckets = new Map<string, KnowledgeWeakness & { weighted: Array<{ id: string; weight: number }> }>();
    const errorTypeSummary: Record<string, number> = {};
    let unmastered = 0;

    for (const item of items) {
        const status = item.masteryStatus ?? masteryStatusOf(item.practiceCount, item.masteryProbability, threshold);
        if (status !== 'mastered') unmastered += 1;
        const created = toDate(item.createdAt) ?? now;
        const last = toDate(item.lastPracticedAt);
        const fresh = recencyWeight(last && last > created ? last : created, now);
        const wrongBoost = 1 + Math.min(3, item.wrongPracticeCount ?? 0) * 0.25;
        const weight = statusWeight(status) * fresh * wrongBoost;
        const errorType = item.errorType?.trim() || '未标注';
        errorTypeSummary[errorType] = (errorTypeSummary[errorType] || 0) + 1;
        const isRecent = (now.getTime() - created.getTime()) / MS_PER_DAY <= recentDays;

        for (const point of pointsOf(item)) {
            const bucket = buckets.get(point) ?? {
                knowledgePoint: point, score: 0, itemCount: 0, unmasteredCount: 0, recentCount: 0,
                errorTypes: {}, representativeItemIds: [], weighted: [],
            };
            bucket.score += weight;
            bucket.itemCount += 1;
            if (status !== 'mastered') bucket.unmasteredCount += 1;
            if (isRecent) bucket.recentCount += 1;
            bucket.errorTypes[errorType] = (bucket.errorTypes[errorType] || 0) + 1;
            bucket.weighted.push({ id: item.id, weight });
            buckets.set(point, bucket);
        }
    }

    const weaknesses = [...buckets.values()]
        .map(({ weighted, ...rest }) => ({
            ...rest,
            score: Math.round(rest.score * 100) / 100,
            representativeItemIds: [...weighted].sort((a, b) => b.weight - a.weight).slice(0, 3).map((item) => item.id),
        }))
        .sort((a, b) => b.score - a.score || b.unmasteredCount - a.unmasteredCount);

    const ratio = items.length === 0 ? 1 : unmastered / items.length;
    const suggestedDifficulty: VariantDifficulty = ratio >= 0.7 ? 'easy' : ratio >= 0.4 ? 'medium' : ratio >= 0.2 ? 'hard' : 'harder';

    return { itemCount: items.length, weaknesses, errorTypeSummary, suggestedDifficulty, analyzedAt: now.toISOString() };
}

function ramp(count: number, start: VariantDifficulty): VariantDifficulty[] {
    const startIndex = DIFFICULTIES.indexOf(start);
    return Array.from({ length: count }, (_, index) => {
        const step = count <= 1 ? 0 : Math.round((index * (DIFFICULTIES.length - 1 - startIndex)) / (count - 1));
        return DIFFICULTIES[Math.min(DIFFICULTIES.length - 1, startIndex + step)];
    });
}

/**
 * 按弱点从高到低分配练习空位，难度从建议起点逐渐升高；
 * 同一知识点的来源题尽量轮换，避免连续用同一道原题。
 */
export function selectPracticeSlots(
    profile: WeaknessProfile,
    items: ProfileItem[],
    count: number,
    options: { startDifficulty?: VariantDifficulty; maxPoints?: number } = {},
): PracticeSlot[] {
    const target = Math.max(0, Math.min(8, Math.floor(count)));
    if (target === 0 || profile.weaknesses.length === 0) return [];
    const start = options.startDifficulty ?? profile.suggestedDifficulty;
    const points = profile.weaknesses.slice(0, options.maxPoints ?? 5);
    const difficulties = ramp(target, start);
    const used = new Map<string, number>();
    const itemById = new Map(items.map((item) => [item.id, item]));

    return difficulties.map((difficulty, index) => {
        const weakness = points[index % points.length];
        const candidates = weakness.representativeItemIds
            .concat(items.filter((item) => pointsOf(item).includes(weakness.knowledgePoint)).map((item) => item.id))
            .filter((id, pos, list) => list.indexOf(id) === pos && itemById.has(id));
        const sourceItemId = candidates.sort((a, b) => (used.get(a) || 0) - (used.get(b) || 0))[0] || items[0]?.id || '';
        used.set(sourceItemId, (used.get(sourceItemId) || 0) + 1);
        return { knowledgePoint: weakness.knowledgePoint, difficulty, sourceItemId };
    });
}

export interface StudentProfileInput {
    studentKey: string;
    profile: WeaknessProfile;
}

/** 班级共性薄弱点：按覆盖学生数、平均弱点分排序 */
export function buildClassWeaknesses(students: StudentProfileInput[], minStudents = 2): ClassWeakness[] {
    const map = new Map<string, { scores: number[]; items: number; students: Set<string> }>();
    for (const student of students) {
        for (const weakness of student.profile.weaknesses) {
            const bucket = map.get(weakness.knowledgePoint) ?? { scores: [], items: 0, students: new Set() };
            bucket.scores.push(weakness.score);
            bucket.items += weakness.itemCount;
            bucket.students.add(student.studentKey);
            map.set(weakness.knowledgePoint, bucket);
        }
    }
    return [...map.entries()]
        .map(([knowledgePoint, bucket]) => ({
            knowledgePoint,
            studentCount: bucket.students.size,
            averageScore: Math.round((bucket.scores.reduce((sum, value) => sum + value, 0) / bucket.scores.length) * 100) / 100,
            totalItems: bucket.items,
        }))
        .filter((item) => item.studentCount >= minStudents)
        .sort((a, b) => b.studentCount - a.studentCount || b.averageScore - a.averageScore);
}

/** 由班级共性薄弱点生成专题课题的输入摘要（再交给 AI 写标题与提纲） */
export function classTopicBrief(weaknesses: ClassWeakness[], top = 3): { knowledgePoints: string[]; reason: string } {
    const picked = weaknesses.slice(0, top);
    return {
        knowledgePoints: picked.map((item) => item.knowledgePoint),
        reason: picked.map((item) => `${item.knowledgePoint}（${item.studentCount} 名学生，平均弱点分 ${item.averageScore}）`).join('；'),
    };
}
