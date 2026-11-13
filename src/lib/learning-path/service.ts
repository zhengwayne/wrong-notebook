/**
 * 学习路径应用服务：从错题、复习、批改与变式练习收集证据，更新掌握快照，
 * 并在证据变化时自动重排未锁定步骤。
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getAppTimeZone } from "@/lib/config";
import { getItemTags } from "@/lib/item-tags";
import { getReviewPlan, isReviewDue } from "@/lib/review-schedule";
import { buildClassWeaknesses, buildWeaknessProfile, classTopicBrief, type ProfileItem } from "@/lib/variant/weakness-profile";
import { findStudentSubjectIds } from "@/lib/variant/service";
import { DEFAULT_MASTERY_THRESHOLD, masteryStatusOf } from "@/lib/mastery-status";
import { buildMasteryMap, evidenceHash, traceKnowledgeMastery } from "./mastery-model";
import { addPrerequisiteEdge, buildPrerequisiteGraph, orderKnowledgePoints, type PrerequisiteTag } from "./prerequisites";
import { planLearningPath, todaySteps } from "./planner";
import { SELF_STUDENT_KEY, stepFingerprint, type EvidenceSource, type MasteryEvidence, type PreservedStep, type StepStatus, type StepType } from "./types";

function parseJsonArray(value: string | null | undefined): string[] {
    if (!value) return [];
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map((item) => String(item).trim()).filter(Boolean) : [];
    } catch {
        return [];
    }
}

function isCorrectResult(result: string | null | undefined, isCorrect?: boolean | null): boolean | null {
    if (result === "correct") return true;
    if (result === "wrong") return false;
    if (typeof isCorrect === "boolean") return isCorrect;
    return null;
}

export interface ResolvedStudent {
    studentKey: string;
    studentName: string;
    classId: string | null;
    subjectIds: string[];
}

export async function resolveStudent(userId: string, studentKey?: string | null, subjectId?: string | null): Promise<ResolvedStudent | null> {
    const key = studentKey || SELF_STUDENT_KEY;
    if (key === SELF_STUDENT_KEY) {
        const subjects = await prisma.subject.findMany({
            where: { userId, ...(subjectId ? { id: subjectId } : {}) },
            select: { id: true, name: true },
        });
        return { studentKey: SELF_STUDENT_KEY, studentName: "我", classId: null, subjectIds: subjects.map((item) => item.id) };
    }
    const student = await prisma.gradingStudent.findFirst({
        where: { id: key, class: { userId } },
        include: { class: { select: { id: true, name: true } } },
    });
    if (!student) return null;
    const subjectIds = await findStudentSubjectIds(userId, student.name);
    const filtered = subjectId ? subjectIds.filter((id) => id === subjectId) : subjectIds;
    return { studentKey: student.id, studentName: student.name, classId: student.classId, subjectIds: filtered };
}

async function loadItems(userId: string, subjectIds: string[]) {
    if (subjectIds.length === 0) return [];
    return prisma.errorItem.findMany({
        where: { userId, subjectId: { in: subjectIds } },
        include: {
            tags: { select: { name: true, parentId: true } },
            practiceRecords: {
                where: { result: { not: null } },
                select: { id: true, result: true, isCorrect: true, createdAt: true, source: true, questionText: true },
            },
        },
        orderBy: { createdAt: "desc" },
    });
}

function toProfileItems(items: Awaited<ReturnType<typeof loadItems>>, threshold: number): ProfileItem[] {
    return items.map((item) => {
        const last = item.practiceRecords.reduce<Date | null>((latest, record) => {
            return !latest || record.createdAt > latest ? record.createdAt : latest;
        }, null);
        return {
            id: item.id,
            knowledgePoints: getItemTags(item),
            errorType: item.errorType,
            createdAt: item.createdAt,
            lastPracticedAt: last,
            practiceCount: item.practiceRecords.length,
            wrongPracticeCount: item.practiceRecords.filter((record) => record.isCorrect === false || record.result === "wrong").length,
            masteryProbability: item.masteryProbability,
            masteryStatus: masteryStatusOf(item.practiceRecords.length, item.masteryProbability, threshold),
        };
    });
}

async function loadGradingEvidence(userId: string, studentKey: string): Promise<MasteryEvidence[]> {
    if (studentKey === SELF_STUDENT_KEY) return [];
    const submissions = await prisma.gradingSubmission.findMany({
        where: { studentId: studentKey, task: { userId }, status: { in: ["graded", "confirmed"] } },
        select: {
            results: {
                select: {
                    id: true,
                    verdict: true,
                    score: true,
                    keyQuestion: { select: { knowledgePoints: true, maxScore: true } },
                },
            },
            confirmedAt: true,
            updatedAt: true,
        },
    });
    const evidence: MasteryEvidence[] = [];
    for (const submission of submissions) {
        const at = submission.confirmedAt ?? submission.updatedAt;
        for (const result of submission.results) {
            const points = parseJsonArray(result.keyQuestion.knowledgePoints);
            if (points.length === 0) continue;
            const verdict = result.verdict;
            const correct = verdict === "correct";
            const weight = verdict === "partial" && result.keyQuestion.maxScore
                ? Math.max(0.25, Math.min(0.8, result.score / result.keyQuestion.maxScore))
                : 1;
            const isCorrect = verdict === "partial" ? weight >= 0.8 : correct;
            for (const point of points) {
                evidence.push({
                    knowledgePoint: point,
                    correct: isCorrect,
                    at,
                    source: "grading",
                    itemId: result.id,
                    weight: verdict === "partial" ? weight : 1,
                });
            }
        }
    }
    return evidence;
}

export async function collectEvidence(userId: string, student: ResolvedStudent): Promise<{
    evidence: MasteryEvidence[];
    items: Awaited<ReturnType<typeof loadItems>>;
    dueItemIds: string[];
    profileItems: ProfileItem[];
}> {
    const threshold = (await prisma.user.findUnique({ where: { id: userId }, select: { masteryThreshold: true } }))?.masteryThreshold ?? DEFAULT_MASTERY_THRESHOLD;
    const items = await loadItems(userId, student.subjectIds);
    const evidence: MasteryEvidence[] = [];
    const timeZone = getAppTimeZone();
    const now = new Date();
    const dueItemIds: string[] = [];

    for (const item of items) {
        const points = getItemTags(item);
        const names = points.length > 0 ? points : ["（未标注知识点）"];
        for (const point of names) {
            evidence.push({ knowledgePoint: point, correct: false, at: item.createdAt, source: "error", itemId: item.id });
        }
        for (const record of item.practiceRecords) {
            const ok = isCorrectResult(record.result, record.isCorrect);
            if (ok === null) continue;
            const source: EvidenceSource = record.source === "practice" || record.source === "exam" ? "variant_practice" : "review";
            for (const point of names) {
                evidence.push({ knowledgePoint: point, correct: ok, at: record.createdAt, source, itemId: record.id });
            }
        }
        const plan = getReviewPlan(item.createdAt, item.practiceRecords, timeZone);
        if (isReviewDue(plan, timeZone, now)) dueItemIds.push(item.id);
    }

    evidence.push(...await loadGradingEvidence(userId, student.studentKey));
    return { evidence, items, dueItemIds, profileItems: toProfileItems(items, threshold) };
}

async function loadTagGraph(userId: string): Promise<ReturnType<typeof buildPrerequisiteGraph>> {
    const tags = await prisma.knowledgeTag.findMany({
        where: { OR: [{ isSystem: true }, { userId }] },
        select: { id: true, name: true, parentId: true },
    });
    const byId = new Map(tags.map((tag) => [tag.id, tag]));
    const rows: PrerequisiteTag[] = tags.map((tag) => ({
        name: tag.name,
        parentName: tag.parentId ? byId.get(tag.parentId)?.name ?? null : null,
    }));
    const graph = buildPrerequisiteGraph(rows);
    // 同题共现的弱启发：先出现的知识点视为后出现者的弱先修，仅当不会成环
    return graph;
}

function attachCooccurrenceEdges(
    graph: ReturnType<typeof buildPrerequisiteGraph>,
    items: Awaited<ReturnType<typeof loadItems>>,
) {
    for (const item of items) {
        const points = getItemTags(item);
        if (points.length < 2) continue;
        // 按标签名字顺序建立弱边，避免随机方向；失败则跳过
        const sorted = [...points].sort((a, b) => a.localeCompare(b, "zh"));
        for (let i = 0; i < sorted.length - 1; i++) {
            addPrerequisiteEdge(graph, sorted[i], sorted[i + 1]);
        }
    }
}

function serializeStep(step: PreservedStep, position: number) {
    return {
        position,
        type: step.type,
        title: step.title,
        reason: step.reason,
        knowledgePoints: JSON.stringify(step.knowledgePoints),
        errorItemIds: JSON.stringify(step.errorItemIds),
        variantRunId: step.variantRunId ?? null,
        status: step.status,
        locked: step.locked,
        dueAt: step.dueAt ?? null,
        href: step.href ?? null,
        teacherNote: step.teacherNote ?? null,
        completedAt: step.completedAt ?? null,
    };
}

function toPreserved(step: {
    id: string;
    type: string;
    title: string;
    reason: string;
    knowledgePoints: string;
    errorItemIds: string | null;
    href: string | null;
    dueAt: Date | null;
    status: string;
    locked: boolean;
    teacherNote: string | null;
    completedAt: Date | null;
    variantRunId: string | null;
}): PreservedStep {
    const knowledgePoints = parseJsonArray(step.knowledgePoints);
    const errorItemIds = parseJsonArray(step.errorItemIds);
    return {
        id: step.id,
        type: step.type as StepType,
        title: step.title,
        reason: step.reason,
        knowledgePoints,
        errorItemIds,
        href: step.href,
        dueAt: step.dueAt,
        status: step.status as StepStatus,
        locked: step.locked,
        teacherNote: step.teacherNote,
        completedAt: step.completedAt,
        variantRunId: step.variantRunId,
        fingerprint: stepFingerprint(step.type as StepType, knowledgePoints, step.type === "spaced_review" || step.type === "checkpoint" ? [] : errorItemIds.slice(0, 1)),
    };
}

export function presentPath(path: {
    id: string;
    studentKey: string;
    studentName: string;
    classId: string | null;
    version: number;
    status: string;
    evidenceHash: string;
    planReason: string | null;
    plannedAt: Date;
    updatedAt: Date;
    steps: Array<Parameters<typeof toPreserved>[0] & { position: number; variantRunId: string | null }>;
}, mastery: ReturnType<typeof buildMasteryMap>) {
    const steps = [...path.steps].sort((a, b) => a.position - b.position).map((step) => {
        const preserved = toPreserved(step);
        return {
            ...preserved,
            position: step.position,
            variantRunId: step.variantRunId,
        };
    });
    return {
        id: path.id,
        studentKey: path.studentKey,
        studentName: path.studentName,
        classId: path.classId,
        version: path.version,
        status: path.status,
        evidenceHash: path.evidenceHash,
        planReason: path.planReason,
        plannedAt: path.plannedAt.toISOString(),
        updatedAt: path.updatedAt.toISOString(),
        steps,
        today: todaySteps(steps).map((step) => ({
            ...step,
            position: steps.find((item) => item.fingerprint === step.fingerprint && item.id === step.id)?.position ?? 0,
        })),
        mastery: [...mastery.values()].sort((a, b) => a.score - b.score).map((item) => ({
            ...item,
            lastObservedAt: item.lastObservedAt?.toISOString() ?? null,
            dueAt: item.dueAt?.toISOString() ?? null,
        })),
    };
}

export type LearningPathView = ReturnType<typeof presentPath>;

async function persistMastery(userId: string, studentKey: string, mastery: ReturnType<typeof buildMasteryMap>) {
    for (const state of mastery.values()) {
        await prisma.knowledgeMastery.upsert({
            where: { userId_studentKey_knowledgePoint: { userId, studentKey, knowledgePoint: state.knowledgePoint } },
            create: {
                userId,
                studentKey,
                knowledgePoint: state.knowledgePoint,
                pKnown: state.pKnown,
                retrievability: state.retrievability,
                stabilityDays: state.stabilityDays,
                evidenceCount: state.evidenceCount,
                lastCorrect: state.lastCorrect,
                lastObservedAt: state.lastObservedAt,
                dueAt: state.dueAt,
            },
            update: {
                pKnown: state.pKnown,
                retrievability: state.retrievability,
                stabilityDays: state.stabilityDays,
                evidenceCount: state.evidenceCount,
                lastCorrect: state.lastCorrect,
                lastObservedAt: state.lastObservedAt,
                dueAt: state.dueAt,
            },
        });
    }
}

export async function getOrReplanPath(userId: string, options: {
    studentKey?: string | null;
    subjectId?: string | null;
    language: "zh" | "en";
    force?: boolean;
}): Promise<{ path: LearningPathView; student: ResolvedStudent; replanned: boolean } | null> {
    const student = await resolveStudent(userId, options.studentKey, options.subjectId);
    if (!student) return null;
    if (student.studentKey === SELF_STUDENT_KEY) {
        student.studentName = options.language === "en" ? "Me" : "我";
    }

    const { evidence, items, dueItemIds, profileItems } = await collectEvidence(userId, student);
    const timeZone = getAppTimeZone();
    const mastery = buildMasteryMap(evidence, { timeZone });
    const evidenceHashValue = createHash("sha1").update(evidenceHash(evidence)).digest("hex");
    const profile = buildWeaknessProfile(profileItems);
    const graph = await loadTagGraph(userId);
    attachCooccurrenceEdges(graph, items);
    const weakNames = profile.weaknesses.map((item) => item.knowledgePoint);
    const priority = new Map(profile.weaknesses.map((item) => [item.knowledgePoint, item.score]));
    const orderedPoints = orderKnowledgePoints(weakNames, graph, priority);

    const existing = await prisma.learningPath.findUnique({
        where: { userId_studentKey: { userId, studentKey: student.studentKey } },
        include: { steps: { orderBy: { position: "asc" } } },
    });

    await persistMastery(userId, student.studentKey, mastery);

    const shouldReplan = Boolean(options.force || !existing || existing.evidenceHash !== evidenceHashValue);
    if (!shouldReplan && existing) {
        return { path: presentPath(existing, mastery), student, replanned: false };
    }

    const planned = planLearningPath({
        weaknesses: profile.weaknesses,
        mastery,
        dueItemIds,
        itemMeta: new Map(items.map((item) => [item.id, {
            knowledgePoints: getItemTags(item),
            questionText: item.questionText,
            analysis: item.analysis,
        }])),
        orderedPoints,
        preserved: existing ? existing.steps.map(toPreserved) : [],
        language: options.language,
    });

    const saved = await prisma.$transaction(async (tx) => {
        const path = existing
            ? await tx.learningPath.update({
                where: { id: existing.id },
                data: {
                    studentName: student.studentName,
                    classId: student.classId,
                    version: existing.version + 1,
                    status: "active",
                    evidenceHash: evidenceHashValue,
                    planReason: planned.planReason,
                    plannedAt: new Date(),
                },
            })
            : await tx.learningPath.create({
                data: {
                    userId,
                    studentKey: student.studentKey,
                    studentName: student.studentName,
                    classId: student.classId,
                    evidenceHash: evidenceHashValue,
                    planReason: planned.planReason,
                },
            });

        await tx.learningPathStep.deleteMany({ where: { pathId: path.id } });
        if (planned.steps.length > 0) {
            await tx.learningPathStep.createMany({
                data: planned.steps.map((step, position) => ({
                    ...(step.id ? { id: step.id } : {}),
                    pathId: path.id,
                    ...serializeStep(step, position),
                })),
            });
        }
        return tx.learningPath.findUniqueOrThrow({
            where: { id: path.id },
            include: { steps: { orderBy: { position: "asc" } } },
        });
    });

    return { path: presentPath(saved, mastery), student, replanned: true };
}

export async function patchStep(userId: string, stepId: string, patch: {
    action: "lock" | "unlock" | "skip" | "complete" | "start" | "move" | "note" | "attach_run";
    direction?: "up" | "down";
    teacherNote?: string | null;
    variantRunId?: string | null;
}) {
    const step = await prisma.learningPathStep.findFirst({
        where: { id: stepId, path: { userId } },
        include: { path: { include: { steps: { orderBy: { position: "asc" } } } } },
    });
    if (!step) return null;

    if (patch.action === "move") {
        const steps = step.path.steps;
        const index = steps.findIndex((item) => item.id === step.id);
        const swapWith = patch.direction === "up" ? index - 1 : index + 1;
        if (index < 0 || swapWith < 0 || swapWith >= steps.length) {
            return step.path;
        }
        const other = steps[swapWith];
        await prisma.$transaction([
            prisma.learningPathStep.update({ where: { id: step.id }, data: { position: other.position } }),
            prisma.learningPathStep.update({ where: { id: other.id }, data: { position: step.position } }),
        ]);
    } else {
        const data: {
            locked?: boolean;
            status?: StepStatus;
            completedAt?: Date | null;
            teacherNote?: string | null;
            variantRunId?: string | null;
        } = {};
        if (patch.action === "lock") data.locked = true;
        if (patch.action === "unlock") data.locked = false;
        if (patch.action === "skip") {
            data.status = "skipped";
            data.completedAt = new Date();
        }
        if (patch.action === "complete") {
            data.status = "completed";
            data.completedAt = new Date();
        }
        if (patch.action === "start" && step.status === "pending") data.status = "in_progress";
        if (patch.action === "note" && patch.teacherNote !== undefined) data.teacherNote = patch.teacherNote;
        if (patch.action === "attach_run" && patch.variantRunId) data.variantRunId = patch.variantRunId;
        await prisma.learningPathStep.update({ where: { id: step.id }, data });
    }

    const refreshed = await prisma.learningPath.findUniqueOrThrow({
        where: { id: step.pathId },
        include: { steps: { orderBy: { position: "asc" } } },
    });
    const masteryRows = await prisma.knowledgeMastery.findMany({ where: { userId, studentKey: refreshed.studentKey } });
    const mastery = new Map(masteryRows.map((row) => [row.knowledgePoint, {
        knowledgePoint: row.knowledgePoint,
        pKnown: row.pKnown,
        retrievability: row.retrievability,
        stabilityDays: row.stabilityDays,
        evidenceCount: row.evidenceCount,
        lastCorrect: row.lastCorrect,
        lastObservedAt: row.lastObservedAt,
        dueAt: row.dueAt,
        score: 0,
    }]));
    for (const state of mastery.values()) {
        state.score = Math.min(1, Math.max(0, state.pKnown * state.retrievability));
    }
    return presentPath(refreshed, mastery);
}

export async function listClassPaths(userId: string, classId: string, language: "zh" | "en") {
    const cls = await prisma.gradingClass.findFirst({
        where: { id: classId, userId },
        include: { students: { orderBy: { order: "asc" } } },
    });
    if (!cls) return null;
    const students = [];
    for (const student of cls.students) {
        const result = await getOrReplanPath(userId, { studentKey: student.id, language });
        if (!result) continue;
        const weak = result.path.mastery.filter((item) => item.score < 0.7);
        students.push({
            studentId: student.id,
            name: student.name,
            studentNo: student.studentNo,
            pathId: result.path.id,
            version: result.path.version,
            weakCount: weak.length,
            averageMastery: result.path.mastery.length
                ? Math.round((result.path.mastery.reduce((sum, item) => sum + item.score, 0) / result.path.mastery.length) * 100) / 100
                : 1,
            nextStep: result.path.today[0] ?? result.path.steps.find((step) => step.status === "pending" || step.status === "in_progress") ?? null,
        });
    }
    const profiles = [];
    for (const row of cls.students) {
        const resolved = await resolveStudent(userId, row.id);
        if (!resolved || resolved.subjectIds.length === 0) continue;
        const { profileItems } = await collectEvidence(userId, resolved);
        if (profileItems.length === 0) continue;
        profiles.push({ studentKey: row.id, profile: buildWeaknessProfile(profileItems) });
    }
    const common = buildClassWeaknesses(profiles);
    return {
        classId: cls.id,
        className: cls.name,
        students,
        classWeaknesses: common,
        topicBrief: classTopicBrief(common),
    };
}

/** 仅用于单测：导出内部纯计算辅助 */
export const learningPathInternals = {
    parseJsonArray,
    toPreserved,
    traceKnowledgeMastery,
};
