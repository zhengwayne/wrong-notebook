/**
 * 老师首页：按班级汇总收卷情况与统计，并提供学生档案。
 * 统计只使用该班学生的批改结果和已精确关联到该生 Learner ID 的错题，
 * 不会按姓名兜底而把同名学生或老师账户本人的错题混进全班。
 */
import { prisma } from '@/lib/prisma';
import { getItemTags } from '@/lib/item-tags';
import { LEARNER_KIND } from '@/lib/learners';
import { collectEvidence, getOrReplanPath, presentPath, resolveStudent } from '@/lib/learning-path/service';
import { buildMasteryMap } from '@/lib/learning-path/mastery-model';
import { buildClassWeaknesses, buildWeaknessProfile, classTopicBrief } from '@/lib/variant/weakness-profile';
import { getAppTimeZone } from '@/lib/config';
import {
    UNLABELED_CAUSE,
    UNLABELED_POINT,
    aggregateClassCollection,
    frequentErrorCauses,
    knowledgeErrorRatesFromResults,
    type ClassCollectionStatus,
    type ErrorCauseCount,
    type KnowledgeErrorRate,
} from '@/lib/home-aggregates';

const RECENT_ITEM_LIMIT = 8;

function parseJsonArray(value: string | null | undefined): string[] {
    if (!value) return [];
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map((item) => String(item).trim()).filter(Boolean) : [];
    } catch {
        return [];
    }
}

async function listOwnedClasses(userId: string) {
    return prisma.gradingClass.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        include: {
            students: { orderBy: { order: 'asc' }, select: { id: true, name: true, studentNo: true, order: true } },
        },
    });
}

async function collectionFor(userId: string, classes: Awaited<ReturnType<typeof listOwnedClasses>>): Promise<ClassCollectionStatus[]> {
    const classIds = classes.map((cls) => cls.id);
    const rosterSize = new Map(classes.map((cls) => [cls.id, cls.students.length]));
    const tasks = classIds.length === 0
        ? []
        : await prisma.gradingTask.findMany({
            where: { userId, classId: { in: classIds } },
            orderBy: { createdAt: 'desc' },
            include: {
                _count: { select: { submissions: true } },
                submissions: { select: { status: true } },
            },
        });
    return aggregateClassCollection(
        classes.map((cls) => ({ id: cls.id, name: cls.name, studentCount: cls.students.length })),
        tasks.map((task) => ({
            id: task.id,
            title: task.title,
            subjectName: task.subjectName,
            createdAt: task.createdAt,
            classId: task.classId,
            studentCount: rosterSize.get(task.classId) ?? 0,
            submissionCount: task._count.submissions,
            confirmedCount: task.submissions.filter((submission) => submission.status === 'confirmed').length,
        })),
    );
}

async function classItemScope(userId: string, students: Array<{ id: string }>) {
    const learners = students.length === 0
        ? []
        : await prisma.learner.findMany({
            where: { userId, kind: LEARNER_KIND.student, gradingStudentId: { in: students.map((student) => student.id) } },
            select: { id: true, gradingStudentId: true },
        });
    return { learnerIds: learners.map((row) => row.id), learners };
}

function studentKeyForItem(
    item: { learnerId: string | null },
    learners: Array<{ id: string; gradingStudentId: string | null }>,
): string | null {
    return learners.find((row) => row.id === item.learnerId)?.gradingStudentId ?? null;
}

async function classStats(userId: string, cls: Awaited<ReturnType<typeof listOwnedClasses>>[number]) {
    const studentIds = cls.students.map((student) => student.id);
    const { learnerIds, learners } = await classItemScope(userId, cls.students);

    const submissions = studentIds.length === 0
        ? []
        : await prisma.gradingSubmission.findMany({
            where: {
                studentId: { in: studentIds },
                status: { in: ['graded', 'confirmed'] },
                task: { userId },
            },
            select: {
                studentId: true,
                results: {
                    select: {
                        verdict: true,
                        keyQuestion: { select: { knowledgePoints: true } },
                    },
                },
            },
        });

    const gradedResults = submissions.flatMap((submission) =>
        submission.results.map((result) => ({
            knowledgePoints: parseJsonArray(result.keyQuestion.knowledgePoints),
            verdict: result.verdict,
            studentId: submission.studentId,
        })),
    );
    const errorRates = knowledgeErrorRatesFromResults(gradedResults, UNLABELED_POINT);

    const items = learnerIds.length === 0
        ? []
        : await prisma.errorItem.findMany({
            where: { userId, learnerId: { in: learnerIds } },
            include: { tags: { select: { name: true, parentId: true } } },
            orderBy: { createdAt: 'desc' },
        });

    const scopedItems = items.filter((item) => studentKeyForItem(item, learners));
    const causes = frequentErrorCauses(
        scopedItems.map((item) => ({
            errorType: item.errorType,
            studentKey: studentKeyForItem(item, learners),
        })),
        UNLABELED_CAUSE,
    );

    const profiles = [];
    const students = [];
    for (const student of cls.students) {
        const resolved = await resolveStudent(userId, student.id);
        if (!resolved) {
            students.push({
                studentId: student.id,
                name: student.name,
                studentNo: student.studentNo,
                weakCount: 0,
                averageMastery: 1,
                nextStep: null as { id?: string; title: string; type: string } | null,
            });
            continue;
        }
        const { profileItems, evidence } = await collectEvidence(userId, resolved);
        const profile = buildWeaknessProfile(profileItems);
        if (profileItems.length > 0) {
            profiles.push({ studentKey: student.id, profile });
        }
        const mastery = buildMasteryMap(evidence, { timeZone: getAppTimeZone() });
        const scores = [...mastery.values()].map((row) => row.score);
        const existing = await prisma.learningPath.findUnique({
            where: { userId_studentKey: { userId, studentKey: student.id } },
            include: { steps: { orderBy: { position: 'asc' } } },
        });
        const path = existing ? presentPath(existing, mastery) : null;
        const weak = (path?.mastery ?? [...mastery.values()].map((row) => ({ score: row.score }))).filter((row) => row.score < 0.7);
        students.push({
            studentId: student.id,
            name: student.name,
            studentNo: student.studentNo,
            weakCount: weak.length,
            averageMastery: scores.length
                ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 100) / 100
                : 1,
            nextStep: path?.today[0] ?? path?.steps.find((step) => step.status === 'pending' || step.status === 'in_progress') ?? null,
        });
    }

    const weaknesses = buildClassWeaknesses(profiles);
    return {
        classId: cls.id,
        className: cls.name,
        errorRates,
        frequentCauses: causes,
        classWeaknesses: weaknesses,
        topicBrief: classTopicBrief(weaknesses),
        students,
    };
}

export interface TeacherHomePayload {
    classes: ClassCollectionStatus[];
    selectedClassId: string | null;
    stats: Awaited<ReturnType<typeof classStats>> | null;
}

export async function getTeacherHome(
    userId: string,
    classId?: string | null,
): Promise<TeacherHomePayload> {
    const classes = await listOwnedClasses(userId);
    const collection = await collectionFor(userId, classes);
    const selected = classId
        ? classes.find((cls) => cls.id === classId) ?? null
        : (classes[0] ?? null);
    if (classId && !selected) {
        return { classes: collection, selectedClassId: null, stats: null };
    }
    return {
        classes: collection,
        selectedClassId: selected?.id ?? null,
        stats: selected ? await classStats(userId, selected) : null,
    };
}

export async function getTeacherStudentProfile(userId: string, studentId: string, language: 'zh' | 'en') {
    const student = await prisma.gradingStudent.findFirst({
        where: { id: studentId, class: { userId } },
        include: { class: { select: { id: true, name: true } } },
    });
    if (!student) return null;

    const result = await getOrReplanPath(userId, { studentKey: student.id, language });
    const learner = await prisma.learner.findUnique({
        where: { gradingStudentId: student.id },
        select: { id: true },
    });
    const recentItems = !learner
        ? []
        : await prisma.errorItem.findMany({
            where: { userId, learnerId: learner.id },
            include: { tags: { select: { name: true } } },
            orderBy: { createdAt: 'desc' },
            take: RECENT_ITEM_LIMIT,
        });

    const profileItems = result
        ? (await collectEvidence(userId, result.student)).profileItems
        : [];
    const profile = buildWeaknessProfile(profileItems);

    return {
        studentId: student.id,
        name: student.name,
        studentNo: student.studentNo,
        classId: student.class.id,
        className: student.class.name,
        mastery: result?.path.mastery ?? [],
        weakPoints: profile.weaknesses,
        frequentCauses: frequentErrorCauses(
            profileItems.map((item) => ({ errorType: item.errorType, studentKey: student.id })),
            UNLABELED_CAUSE,
        ) as ErrorCauseCount[],
        recentWrong: recentItems.map((item) => ({
            id: item.id,
            questionText: item.questionText,
            errorType: item.errorType,
            knowledgePoints: getItemTags(item),
            createdAt: item.createdAt.toISOString(),
        })),
        path: result?.path ?? null,
        today: result?.path.today ?? [],
    };
}

export type { KnowledgeErrorRate, ErrorCauseCount, ClassCollectionStatus };
