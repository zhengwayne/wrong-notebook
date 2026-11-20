/**
 * 老师/家长首页用的纯汇总：班级收卷情况、知识点错误率、高频错因、练习趋势。
 * 统计只使用传入的班级或学生数据，避免把账户本人的错题曲线混进去。
 */
import { isWrong } from '@/lib/grading';
import { formatDateTime } from '@/lib/date-time';

export const UNLABELED_POINT = '（未标注知识点）';
export const UNLABELED_CAUSE = '未标注';

export interface ClassTaskSnapshot {
    id: string;
    title: string;
    subjectName: string;
    createdAt: Date | string;
    classId: string;
    studentCount: number;
    submissionCount: number;
    confirmedCount: number;
}

export interface ClassCollectionStatus {
    id: string;
    name: string;
    studentCount: number;
    taskCount: number;
    latestTask: {
        id: string;
        title: string;
        subjectName: string;
        createdAt: string;
        studentCount: number;
        submissionCount: number;
        confirmedCount: number;
    } | null;
}

export function toIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** 按班级汇总名册人数与最近一次收卷的已交 / 已确认人数 */
export function aggregateClassCollection(
    classes: Array<{ id: string; name: string; studentCount: number }>,
    tasks: ClassTaskSnapshot[],
): ClassCollectionStatus[] {
    const byClass = new Map<string, ClassTaskSnapshot[]>();
    for (const task of tasks) {
        const list = byClass.get(task.classId) ?? [];
        list.push(task);
        byClass.set(task.classId, list);
    }
    return classes.map((cls) => {
        const classTasks = (byClass.get(cls.id) ?? []).slice().sort((a, b) => {
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        });
        const latest = classTasks[0];
        return {
            id: cls.id,
            name: cls.name,
            studentCount: cls.studentCount,
            taskCount: classTasks.length,
            latestTask: latest
                ? {
                    id: latest.id,
                    title: latest.title,
                    subjectName: latest.subjectName,
                    createdAt: toIso(latest.createdAt),
                    studentCount: latest.studentCount,
                    submissionCount: latest.submissionCount,
                    confirmedCount: latest.confirmedCount,
                }
                : null,
        };
    });
}

export interface GradedKnowledgeResult {
    knowledgePoints: string[];
    verdict: string;
    studentId: string | null;
}

export interface KnowledgeErrorRate {
    knowledgePoint: string;
    answered: number;
    wrong: number;
    errorRate: number;
    studentCount: number;
}

/** 按知识点统计错误率；只计入传入的批改结果（已按班级/学生过滤） */
export function knowledgeErrorRatesFromResults(
    results: GradedKnowledgeResult[],
    unlabeled = UNLABELED_POINT,
): KnowledgeErrorRate[] {
    const map = new Map<string, { answered: number; wrong: number; students: Set<string> }>();
    for (const result of results) {
        const points = result.knowledgePoints.map((name) => name.trim()).filter(Boolean);
        const names = points.length > 0 ? points : [unlabeled];
        const wrong = isWrong(result.verdict);
        const studentKey = result.studentId || '';
        for (const name of names) {
            const bucket = map.get(name) ?? { answered: 0, wrong: 0, students: new Set() };
            bucket.answered += 1;
            if (wrong) bucket.wrong += 1;
            if (studentKey) bucket.students.add(studentKey);
            map.set(name, bucket);
        }
    }
    return [...map.entries()]
        .map(([knowledgePoint, bucket]) => ({
            knowledgePoint,
            answered: bucket.answered,
            wrong: bucket.wrong,
            errorRate: bucket.answered ? Math.round((bucket.wrong / bucket.answered) * 1000) / 10 : 0,
            studentCount: bucket.students.size,
        }))
        .filter((item) => item.wrong > 0)
        .sort((a, b) => b.errorRate - a.errorRate || b.wrong - a.wrong || b.studentCount - a.studentCount);
}

export interface ErrorCauseCount {
    cause: string;
    count: number;
    studentCount: number;
}

export function frequentErrorCauses(
    items: Array<{ errorType?: string | null; studentKey?: string | null }>,
    unlabeled = UNLABELED_CAUSE,
): ErrorCauseCount[] {
    const map = new Map<string, { count: number; students: Set<string> }>();
    for (const item of items) {
        const cause = item.errorType?.trim() || unlabeled;
        const bucket = map.get(cause) ?? { count: 0, students: new Set() };
        bucket.count += 1;
        if (item.studentKey) bucket.students.add(item.studentKey);
        map.set(cause, bucket);
    }
    return [...map.entries()]
        .map(([cause, bucket]) => ({
            cause,
            count: bucket.count,
            studentCount: bucket.students.size,
        }))
        .sort((a, b) => b.count - a.count || b.studentCount - a.studentCount);
}

export interface PracticeTrendDay {
    date: string;
    attempted: number;
    correct: number;
}

function isCorrectResult(result?: string | null, isCorrect?: boolean | null): boolean | null {
    if (result === 'correct') return true;
    if (result === 'wrong') return false;
    if (typeof isCorrect === 'boolean') return isCorrect;
    return null;
}

/** 最近若干天的练习次数与正确次数，按当地日期补齐空天 */
export function practiceTrendFromRecords(
    records: Array<{ createdAt: Date | string; result?: string | null; isCorrect?: boolean | null }>,
    options: { days?: number; timeZone?: string; now?: Date } = {},
): PracticeTrendDay[] {
    const days = options.days ?? 14;
    const timeZone = options.timeZone ?? 'Asia/Taipei';
    const now = options.now ?? new Date();
    const buckets = new Map<string, PracticeTrendDay>();
    const dayKeys: string[] = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
        const date = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
        const key = formatDateTime(date, 'yyyy-MM-dd', timeZone);
        dayKeys.push(key);
        buckets.set(key, { date: key, attempted: 0, correct: 0 });
    }
    for (const record of records) {
        const at = record.createdAt instanceof Date ? record.createdAt : new Date(record.createdAt);
        if (Number.isNaN(at.getTime())) continue;
        const key = formatDateTime(at, 'yyyy-MM-dd', timeZone);
        const bucket = buckets.get(key);
        if (!bucket) continue;
        const ok = isCorrectResult(record.result, record.isCorrect);
        if (ok === null) continue;
        bucket.attempted += 1;
        if (ok) bucket.correct += 1;
    }
    return dayKeys.map((key) => buckets.get(key)!);
}

/** 老师本人科目：排除「学生名·学科」这类花名册学生错题本 */
export function personalSubjectIds(
    subjects: Array<{ id: string; name: string }>,
    studentNames: string[],
    isStudentNotebook: (notebookName: string, studentName: string) => boolean,
): string[] {
    return subjects
        .filter((subject) => !studentNames.some((name) => isStudentNotebook(subject.name, name)))
        .map((subject) => subject.id);
}
