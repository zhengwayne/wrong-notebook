/**
 * 学习路径应用服务：从错题、复习、批改与变式练习收集证据，更新掌握快照，
 * 并在证据变化时自动重排未锁定步骤。
 */
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getAppTimeZone } from "@/lib/config";
import { evaluateDueCandidates } from "@/lib/due-items";
import { getItemTags } from "@/lib/item-tags";
import { LEARNER_KIND } from "@/lib/learners";
import { createLogger } from "@/lib/logger";
import { DEFAULT_MASTERY_THRESHOLD, masteryStatusOf } from "@/lib/mastery-status";
import {
    DEFAULT_REVIEW_ALGORITHM,
    aggregateKnowledgeRetrievability,
    isReviewAlgorithmVersion,
    replayItemMemory,
    type ItemMemorySnapshot,
    type ReviewAlgorithmVersion,
} from "@/lib/memory-model";
import { prisma } from "@/lib/prisma";
import { buildClassWeaknesses, buildWeaknessProfile, classTopicBrief, type ProfileItem } from "@/lib/variant/weakness-profile";
import { buildMasteryMap, evidenceHash, traceKnowledgeMastery } from "./mastery-model";
import { planLearningPath, todaySteps } from "./planner";
import { buildPrerequisiteGraph, orderKnowledgePoints, type PrerequisiteGraph, type PrerequisiteTag } from "./prerequisites";
import { SELF_STUDENT_KEY, stepFingerprint, type EvidenceSource, type MasteryEvidence, type PreservedStep, type StepStatus, type StepType } from "./types";

const logger = createLogger("learning-path");

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
    kind: "self" | "child" | "student";
    learnerId: string | null;
}

export async function resolveStudent(userId: string, studentKey?: string | null): Promise<ResolvedStudent | null> {
    const key = studentKey || SELF_STUDENT_KEY;
    if (key === SELF_STUDENT_KEY) {
        const [subjects, selfLearner] = await Promise.all([
            prisma.subject.findMany({ where: { userId }, select: { id: true, name: true } }),
            prisma.learner.findFirst({ where: { userId, kind: LEARNER_KIND.self }, select: { id: true } }),
        ]);
        const subjectIds = subjects
            .filter((subject) => !subject.name.includes("·"))
            .map((subject) => subject.id);
        return {
            studentKey: SELF_STUDENT_KEY,
            studentName: "我",
            classId: null,
            subjectIds,
            kind: "self",
            learnerId: selfLearner?.id ?? null,
        };
    }

    const student = await prisma.gradingStudent.findFirst({
        where: { id: key, class: { userId } },
        include: { class: { select: { id: true, name: true } }, learner: { select: { id: true } } },
    });
    if (student) {
        return {
            studentKey: student.id,
            studentName: student.name,
            classId: student.classId,
            subjectIds: [],
            kind: "student",
            learnerId: student.learner?.id ?? null,
        };
    }

    // 兼容 Learner.id：家长的孩子用 Learner.id 作为 studentKey；老师学生若传入 Learner.id 则回落到花名册 id
    const learner = await prisma.learner.findFirst({ where: { id: key, userId, archivedAt: null } });
    if (!learner) return null;
    if (learner.kind === "student" && learner.gradingStudentId) {
        return resolveStudent(userId, learner.gradingStudentId);
    }
    if (learner.kind === "self") {
        return resolveStudent(userId, SELF_STUDENT_KEY);
    }
    const itemSubjects = await prisma.errorItem.findMany({
        where: { userId, learnerId: learner.id, subjectId: { not: null } },
        select: { subjectId: true },
        distinct: ["subjectId"],
    });
    const subjectIds = itemSubjects.map((row) => row.subjectId).filter((id): id is string => !!id);
    return {
        studentKey: learner.id,
        studentName: learner.name,
        classId: null,
        subjectIds,
        kind: "child",
        learnerId: learner.id,
    };
}

function itemWhereForStudent(userId: string, student: ResolvedStudent) {
    if (student.kind === "child" || student.kind === "student") {
        if (!student.learnerId) return null;
        return { userId, learnerId: student.learnerId };
    }
    return {
        userId,
        OR: [
            { learner: { kind: LEARNER_KIND.self } },
            { learnerId: null, subjectId: null },
            { learnerId: null, subject: { NOT: { name: { contains: "·" } } } },
        ],
    };
}

const ITEM_WITH_EVIDENCE_SELECT = {
    id: true,
    shortId: true,
    subjectId: true,
    learnerId: true,
    errorType: true,
    createdAt: true,
    masteryProbability: true,
    knowledgePoints: true,
    questionText: true,
    analysis: true,
    wrongAnswerText: true,
    mistakeAnalysis: true,
    tags: { select: { name: true, parentId: true } },
    practiceRecords: {
        // 不在嵌套 relation 上使用 result: { not: null } 否定条件，避免 SQLite 题目数超过拆批上限时触发 Prisma P2029
        select: { id: true, result: true, isCorrect: true, createdAt: true, source: true, questionText: true, learnerId: true },
    },
} as const;

type LoadedErrorItem = Prisma.ErrorItemGetPayload<{ select: typeof ITEM_WITH_EVIDENCE_SELECT }>;

function filterNonNullPracticeRecords(items: LoadedErrorItem[]): LoadedErrorItem[] {
    return items.map((item) => ({
        ...item,
        practiceRecords: item.practiceRecords.filter((record) => record.result !== null),
    }));
}

const GRADING_SUBMISSION_EVIDENCE_SELECT = {
    studentId: true,
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
} as const;

type LoadedGradingSubmission = Prisma.GradingSubmissionGetPayload<{ select: typeof GRADING_SUBMISSION_EVIDENCE_SELECT }>;

async function loadItems(userId: string, student: ResolvedStudent): Promise<LoadedErrorItem[]> {
    const where = itemWhereForStudent(userId, student);
    if (!where) return [];
    const items = await prisma.errorItem.findMany({
        where,
        select: ITEM_WITH_EVIDENCE_SELECT,
        orderBy: { createdAt: "desc" },
    });
    return filterNonNullPracticeRecords(items);
}

function toProfileItems(items: LoadedErrorItem[], threshold: number): ProfileItem[] {
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

function gradingSubmissionsToEvidence(submissions: LoadedGradingSubmission[]): MasteryEvidence[] {
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

function assembleStudentEvidence(
    items: LoadedErrorItem[],
    gradingSubmissions: LoadedGradingSubmission[],
    threshold: number,
    timeZone: string,
    now: Date,
    algorithmVersion: ReviewAlgorithmVersion = DEFAULT_REVIEW_ALGORITHM,
    scopeLearnerId?: string | null,
): {
    evidence: MasteryEvidence[];
    items: LoadedErrorItem[];
    dueItemIds: string[];
    profileItems: ProfileItem[];
    memoriesByPoint: Map<string, ItemMemorySnapshot[]>;
} {
    const evidence: MasteryEvidence[] = [];
    const dueCandidates: Array<{
        id: string;
        createdAt: Date;
        practiceRecords: { result: string | null; createdAt: Date }[];
        points: string[];
    }> = [];

    for (const item of items) {
        const points = getItemTags(item);
        const names = points.length > 0 ? points : ["（未标注知识点）"];
        for (const point of names) {
            evidence.push({ knowledgePoint: point, correct: false, at: item.createdAt, source: "error", itemId: item.id });
        }
        const scopedRecords = scopeLearnerId === undefined
            ? item.practiceRecords
            : item.practiceRecords.filter((r) => (r.learnerId ?? null) === scopeLearnerId);
        for (const record of scopedRecords) {
            const ok = isCorrectResult(record.result, record.isCorrect);
            if (ok === null) continue;
            const source: EvidenceSource = record.source === "practice" || record.source === "exam" ? "variant_practice" : "review";
            for (const point of names) {
                evidence.push({ knowledgePoint: point, correct: ok, at: record.createdAt, source, itemId: record.id });
            }
        }
        dueCandidates.push({
            id: item.id,
            createdAt: item.createdAt,
            practiceRecords: scopedRecords,
            points: names,
        });
    }

    const dueItemIds = evaluateDueCandidates(dueCandidates, { timeZone, date: now, algorithmVersion }).map((entry) => entry.id);
    const memoriesByPoint = new Map<string, ItemMemorySnapshot[]>();
    if (algorithmVersion === "fsrs-v1") {
        for (const candidate of dueCandidates) {
            const snapshot = replayItemMemory(candidate.createdAt, candidate.practiceRecords, timeZone);
            for (const point of candidate.points) {
                const list = memoriesByPoint.get(point) ?? [];
                list.push(snapshot);
                memoriesByPoint.set(point, list);
            }
        }
    }

    evidence.push(...gradingSubmissionsToEvidence(gradingSubmissions));
    return { evidence, items, dueItemIds, profileItems: toProfileItems(items, threshold), memoriesByPoint };
}

function buildMasteryWithMemory(
    evidence: MasteryEvidence[],
    memoriesByPoint: Map<string, ItemMemorySnapshot[]>,
    algorithmVersion: ReviewAlgorithmVersion,
    timeZone: string,
    now: Date,
) {
    const mastery = buildMasteryMap(evidence, { timeZone, now });
    if (algorithmVersion !== "fsrs-v1") return mastery;
    for (const [point, state] of mastery.entries()) {
        const pointMemories = memoriesByPoint.get(point);
        if (!pointMemories || pointMemories.length === 0) continue;
        state.retrievability = aggregateKnowledgeRetrievability(pointMemories, now);
        state.score = Math.min(1, Math.max(0, state.pKnown * state.retrievability));
    }
    return mastery;
}

function computeEvidenceHashValue(evidence: MasteryEvidence[], algorithmVersion: ReviewAlgorithmVersion): string {
    const raw = evidenceHash(evidence);
    const input = algorithmVersion === DEFAULT_REVIEW_ALGORITHM ? raw : `${algorithmVersion}:${raw}`;
    return createHash("sha1").update(input).digest("hex");
}

export async function collectEvidence(userId: string, student: ResolvedStudent) {
    const userRow = await prisma.user.findUnique({
        where: { id: userId },
        select: { masteryThreshold: true, reviewAlgorithmVersion: true },
    });
    const threshold = userRow?.masteryThreshold ?? DEFAULT_MASTERY_THRESHOLD;
    const algorithmVersion = isReviewAlgorithmVersion(userRow?.reviewAlgorithmVersion)
        ? userRow.reviewAlgorithmVersion
        : DEFAULT_REVIEW_ALGORITHM;
    const scopeLearnerId = student.kind === "self" ? null : student.learnerId;
    const [items, submissions] = await Promise.all([
        loadItems(userId, student),
        student.studentKey === SELF_STUDENT_KEY
            ? Promise.resolve<LoadedGradingSubmission[]>([])
            : prisma.gradingSubmission.findMany({
                where: { studentId: student.studentKey, task: { userId }, status: { in: ["graded", "confirmed"] } },
                select: GRADING_SUBMISSION_EVIDENCE_SELECT,
            }),
    ]);
    return {
        ...assembleStudentEvidence(items, submissions, threshold, getAppTimeZone(), new Date(), algorithmVersion, scopeLearnerId),
        algorithmVersion,
    };
}

async function loadTagGraph(userId: string): Promise<PrerequisiteGraph> {
    const tags = await prisma.knowledgeTag.findMany({
        where: { OR: [{ isSystem: true }, { userId }] },
        select: { id: true, name: true, parentId: true },
    });
    const byId = new Map(tags.map((tag) => [tag.id, tag]));
    const rows: PrerequisiteTag[] = tags.map((tag) => ({
        name: tag.name,
        parentName: tag.parentId ? byId.get(tag.parentId)?.name ?? null : null,
    }));
    return buildPrerequisiteGraph(rows);
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

export interface SourceQuestionSummary {
    id: string;
    shortId: string | null;
    questionText: string;
    wrongAnswerText: string | null;
    mistakeAnalysis: string | null;
    knowledgePoints: string[];
}

export function toSourceQuestion(item: {
    id: string;
    shortId?: string | null;
    questionText?: string | null;
    wrongAnswerText?: string | null;
    mistakeAnalysis?: string | null;
    tags?: { name: string }[] | null;
    knowledgePoints?: string | null;
}): SourceQuestionSummary {
    return {
        id: item.id,
        shortId: item.shortId ?? null,
        questionText: item.questionText ?? "",
        wrongAnswerText: item.wrongAnswerText ?? null,
        mistakeAnalysis: item.mistakeAnalysis ?? null,
        knowledgePoints: getItemTags(item),
    };
}

export function attachSourceQuestions<T extends { steps: Array<{ errorItemIds: string[] }>; today: Array<{ errorItemIds: string[] }> }>(
    path: T,
    items: Array<Parameters<typeof toSourceQuestion>[0]>,
): T & { steps: Array<T["steps"][number] & { sourceQuestions: SourceQuestionSummary[] }>; today: Array<T["today"][number] & { sourceQuestions: SourceQuestionSummary[] }> } {
    const byId = new Map(items.map((item) => [item.id, toSourceQuestion(item)]));
    const decorate = <S extends { errorItemIds: string[] }>(step: S) => ({
        ...step,
        sourceQuestions: step.errorItemIds
            .map((id) => byId.get(id))
            .filter((question): question is SourceQuestionSummary => Boolean(question)),
    });
    return {
        ...path,
        steps: path.steps.map(decorate),
        today: path.today.map(decorate),
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

/** 展示层按学科/错题本过滤，不改动数据库中已持久化的全科路径与 evidenceHash */
function filterPathBySubjectId(view: LearningPathView, items: LoadedErrorItem[], subjectId?: string | null): LearningPathView {
    if (!subjectId) return view;
    const subjectItems = items.filter((item) => item.subjectId === subjectId);
    const allowedItemIds = new Set(subjectItems.map((item) => item.id));
    const allowedPoints = new Set(subjectItems.flatMap((item) => getItemTags(item)));
    const filterStepList = <S extends { errorItemIds: string[]; knowledgePoints: string[] }>(list: S[]): S[] =>
        list
            .filter((step) => (
                step.errorItemIds.length > 0
                    ? step.errorItemIds.some((id) => allowedItemIds.has(id))
                    : step.knowledgePoints.some((point) => allowedPoints.has(point))
            ))
            .map((step) => (
                step.errorItemIds.length > 0
                    ? { ...step, errorItemIds: step.errorItemIds.filter((id) => allowedItemIds.has(id)) }
                    : step
            ));

    return {
        ...view,
        steps: filterStepList(view.steps),
        today: filterStepList(view.today),
        mastery: view.mastery.filter((item) => allowedPoints.has(item.knowledgePoint)),
    };
}

async function persistMasteryBatchInTx(
    tx: Prisma.TransactionClient,
    entries: Array<{ userId: string; studentKey: string; mastery: ReturnType<typeof buildMasteryMap> }>,
) {
    if (entries.length === 0) return;
    const keys = entries.map((entry) => entry.studentKey);
    const userId = entries[0].userId;
    await tx.knowledgeMastery.deleteMany({
        where: { userId, studentKey: { in: keys } },
    });
    const rows = entries.flatMap((entry) =>
        [...entry.mastery.values()].map((state) => ({
            userId: entry.userId,
            studentKey: entry.studentKey,
            knowledgePoint: state.knowledgePoint,
            pKnown: state.pKnown,
            retrievability: state.retrievability,
            stabilityDays: state.stabilityDays,
            evidenceCount: state.evidenceCount,
            lastCorrect: state.lastCorrect,
            lastObservedAt: state.lastObservedAt,
            dueAt: state.dueAt,
        })),
    );
    if (rows.length > 0) {
        await tx.knowledgeMastery.createMany({ data: rows });
    }
}

type PersistedLearningPath = Prisma.LearningPathGetPayload<{ include: { steps: { orderBy: { position: "asc" } } } }>;

async function saveReplannedPathInTx(
    tx: Prisma.TransactionClient,
    userId: string,
    student: ResolvedStudent,
    existing: PersistedLearningPath | null,
    evidenceHashValue: string,
    planned: ReturnType<typeof planLearningPath>,
): Promise<PersistedLearningPath> {
    const stepRows = planned.steps.map((step, position) => ({
        ...(step.id ? { id: step.id } : {}),
        ...serializeStep(step, position),
    }));

    if (!existing) {
        return tx.learningPath.create({
            data: {
                userId,
                studentKey: student.studentKey,
                studentName: student.studentName,
                classId: student.classId,
                evidenceHash: evidenceHashValue,
                planReason: planned.planReason,
                ...(stepRows.length > 0 ? { steps: { create: stepRows } } : {}),
            },
            include: { steps: { orderBy: { position: "asc" } } },
        });
    }

    await tx.learningPathStep.deleteMany({ where: { pathId: existing.id } });
    return tx.learningPath.update({
        where: { id: existing.id },
        data: {
            studentName: student.studentName,
            classId: student.classId,
            version: existing.version + 1,
            status: "active",
            evidenceHash: evidenceHashValue,
            planReason: planned.planReason,
            plannedAt: new Date(),
            ...(stepRows.length > 0 ? { steps: { create: stepRows } } : {}),
        },
        include: { steps: { orderBy: { position: "asc" } } },
    });
}

function buildPlanInput(
    items: LoadedErrorItem[],
    profile: ReturnType<typeof buildWeaknessProfile>,
    mastery: ReturnType<typeof buildMasteryMap>,
    dueItemIds: string[],
    graph: PrerequisiteGraph,
    existing: PersistedLearningPath | null,
    language: "zh" | "en",
) {
    const weakNames = profile.weaknesses.map((item) => item.knowledgePoint);
    const priority = new Map(profile.weaknesses.map((item) => [item.knowledgePoint, item.score]));
    const orderedPoints = orderKnowledgePoints(weakNames, graph, priority);
    return planLearningPath({
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
        language,
    });
}

export function scheduleLearningPathReplan(userId: string, language: "zh" | "en" = "zh", studentKey?: string | null) {
    setTimeout(() => {
        void getOrReplanPath(userId, { language, studentKey, force: true }).catch((error) => {
            logger.debug({ error, userId, studentKey }, "Failed to replan learning path in background");
        });
    }, 0);
}

export async function getOrReplanPath(userId: string, options: {
    studentKey?: string | null;
    subjectId?: string | null;
    language: "zh" | "en";
    force?: boolean;
}): Promise<{ path: LearningPathView; student: ResolvedStudent; replanned: boolean } | null> {
    const student = await resolveStudent(userId, options.studentKey);
    if (!student) return null;
    if (student.studentKey === SELF_STUDENT_KEY) {
        student.studentName = options.language === "en" ? "Me" : "我";
    }

    const { evidence, items, dueItemIds, profileItems, memoriesByPoint, algorithmVersion } = await collectEvidence(userId, student);
    const timeZone = getAppTimeZone();
    const mastery = buildMasteryWithMemory(evidence, memoriesByPoint, algorithmVersion, timeZone, new Date());
    const evidenceHashValue = computeEvidenceHashValue(evidence, algorithmVersion);

    const existing = await prisma.learningPath.findUnique({
        where: { userId_studentKey: { userId, studentKey: student.studentKey } },
        include: { steps: { orderBy: { position: "asc" } } },
    });

    // 命中缓存时直接返回视图，保持只读（数据库零写入）
    if (!options.force && existing && existing.evidenceHash === evidenceHashValue) {
        const filtered = filterPathBySubjectId(presentPath(existing, mastery), items, options.subjectId);
        return { path: attachSourceQuestions(filtered, items), student, replanned: false };
    }

    const profile = buildWeaknessProfile(profileItems);
    const graph = await loadTagGraph(userId);
    const planned = buildPlanInput(items, profile, mastery, dueItemIds, graph, existing, options.language);
    const saved = await prisma.$transaction(async (tx) => {
        await persistMasteryBatchInTx(tx, [{ userId, studentKey: student.studentKey, mastery }]);
        return saveReplannedPathInTx(tx, userId, student, existing, evidenceHashValue, planned);
    });
    const filtered = filterPathBySubjectId(presentPath(saved, mastery), items, options.subjectId);
    return { path: attachSourceQuestions(filtered, items), student, replanned: true };
}

async function loadSourceItemsByIds(ids: string[]) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return [];
    return prisma.errorItem.findMany({
        where: { id: { in: unique } },
        select: {
            id: true,
            shortId: true,
            questionText: true,
            wrongAnswerText: true,
            mistakeAnalysis: true,
            knowledgePoints: true,
            tags: { select: { name: true, parentId: true } },
        },
    });
}

export class StepPatchError extends Error {
    readonly code: "KID_MODE_RESTRICTED" | "VARIANT_RUN_NOT_FOUND";
    constructor(code: "KID_MODE_RESTRICTED" | "VARIANT_RUN_NOT_FOUND") {
        super(code);
        this.name = "StepPatchError";
        this.code = code;
    }
}

export async function patchStep(userId: string, stepId: string, patch: {
    action: "lock" | "unlock" | "skip" | "complete" | "start" | "move" | "note" | "attach_run";
    direction?: "up" | "down";
    teacherNote?: string | null;
    variantRunId?: string | null;
}, options?: { expectedStudentKey?: string }) {
    const step = await prisma.learningPathStep.findFirst({
        where: { id: stepId, path: { userId } },
        include: { path: { include: { steps: { orderBy: { position: "asc" } } } } },
    });
    if (!step) return null;
    if (options?.expectedStudentKey && step.path.studentKey !== options.expectedStudentKey) {
        throw new StepPatchError("KID_MODE_RESTRICTED");
    }
    if (patch.action === "attach_run" && patch.variantRunId) {
        const ownedRun = await prisma.variantRun.findFirst({
            where: { id: patch.variantRunId, userId },
            select: { id: true },
        });
        if (!ownedRun) {
            throw new StepPatchError("VARIANT_RUN_NOT_FOUND");
        }
    }

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
    const sourceItems = await loadSourceItemsByIds(refreshed.steps.flatMap((stepRow) => parseJsonArray(stepRow.errorItemIds)));
    return attachSourceQuestions(presentPath(refreshed, mastery), sourceItems);
}

interface ClassStudentSeed {
    id: string;
    name: string;
    studentNo: string | null;
}

async function prepareClassStudents(
    userId: string,
    classId: string | null,
    rawStudents: ClassStudentSeed[],
) {
    const studentIds = rawStudents.map((s) => s.id);
    const [userRow, studentLearners, allSubmissions, existingPaths] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { masteryThreshold: true, reviewAlgorithmVersion: true } }),
        prisma.learner.findMany({ where: { userId, gradingStudentId: { in: studentIds } }, select: { id: true, gradingStudentId: true } }),
        prisma.gradingSubmission.findMany({
            where: { studentId: { in: studentIds }, task: { userId }, status: { in: ["graded", "confirmed"] } },
            select: GRADING_SUBMISSION_EVIDENCE_SELECT,
        }),
        prisma.learningPath.findMany({
            where: { userId, studentKey: { in: studentIds } },
            include: { steps: { orderBy: { position: "asc" } } },
        }),
    ]);

    const threshold = userRow?.masteryThreshold ?? DEFAULT_MASTERY_THRESHOLD;
    const algorithmVersion = isReviewAlgorithmVersion(userRow?.reviewAlgorithmVersion)
        ? userRow.reviewAlgorithmVersion
        : DEFAULT_REVIEW_ALGORITHM;
    const learnerByStudentId = new Map(studentLearners.map((l) => [l.gradingStudentId!, l.id]));
    const pathByStudentId = new Map(existingPaths.map((p) => [p.studentKey, p]));
    const submissionsByStudentId = new Map<string, LoadedGradingSubmission[]>();
    for (const sub of allSubmissions) {
        if (!sub.studentId) continue;
        const list = submissionsByStudentId.get(sub.studentId) ?? [];
        list.push(sub);
        submissionsByStudentId.set(sub.studentId, list);
    }

    const allLearnerIds = [...new Set(
        rawStudents
            .map((student) => learnerByStudentId.get(student.id))
            .filter((lid): lid is string => typeof lid === "string" && lid.length > 0),
    )];
    const allItems = allLearnerIds.length === 0
        ? []
        : filterNonNullPracticeRecords(await prisma.errorItem.findMany({
            where: {
                userId,
                learnerId: { in: allLearnerIds },
            },
            select: ITEM_WITH_EVIDENCE_SELECT,
            orderBy: { createdAt: "desc" },
        }));

    const itemsByLearnerId = new Map<string, LoadedErrorItem[]>();
    for (const item of allItems) {
        if (item.learnerId) {
            const list = itemsByLearnerId.get(item.learnerId) ?? [];
            list.push(item);
            itemsByLearnerId.set(item.learnerId, list);
        }
    }

    const timeZone = getAppTimeZone();
    const now = new Date();
    const preparedStudents: Array<{
        student: ClassStudentSeed;
        resolved: ResolvedStudent;
        mastery: ReturnType<typeof buildMasteryMap>;
        existing: PersistedLearningPath | null;
        evidenceHashValue: string;
        profile: ReturnType<typeof buildWeaknessProfile>;
        items: LoadedErrorItem[];
        dueItemIds: string[];
    }> = [];
    const profiles: Array<{ studentKey: string; profile: ReturnType<typeof buildWeaknessProfile> }> = [];

    for (const student of rawStudents) {
        const learnerId = learnerByStudentId.get(student.id) ?? null;
        const resolved: ResolvedStudent = {
            studentKey: student.id,
            studentName: student.name,
            classId,
            subjectIds: [],
            kind: "student",
            learnerId,
        };

        const studentItems = learnerId ? (itemsByLearnerId.get(learnerId) ?? []) : [];

        const submissions = submissionsByStudentId.get(student.id) ?? [];
        const { evidence, dueItemIds, profileItems, memoriesByPoint } = assembleStudentEvidence(
            studentItems,
            submissions,
            threshold,
            timeZone,
            now,
            algorithmVersion,
            learnerId,
        );
        const mastery = buildMasteryWithMemory(evidence, memoriesByPoint, algorithmVersion, timeZone, now);
        const evidenceHashValue = computeEvidenceHashValue(evidence, algorithmVersion);
        const existing = pathByStudentId.get(student.id) ?? null;
        const profile = buildWeaknessProfile(profileItems);

        if (profileItems.length > 0) {
            profiles.push({ studentKey: student.id, profile });
        }

        preparedStudents.push({
            student,
            resolved,
            mastery,
            existing,
            evidenceHashValue,
            profile,
            items: studentItems,
            dueItemIds,
        });
    }

    return { preparedStudents, profiles };
}

/** 老师首页只读班级学情总览：一次批量加载全部学生证据与学习路径（接入 fsrs-v1），零 N+1 查询 */
export async function computeClassMasteryOverview(
    userId: string,
    classId: string | null,
    rawStudents: ClassStudentSeed[],
) {
    if (rawStudents.length === 0) {
        return {
            profiles: [] as Array<{ studentKey: string; profile: ReturnType<typeof buildWeaknessProfile> }>,
            masteryByStudent: new Map<string, Map<string, number>>(),
            students: [] as Array<{
                studentId: string;
                name: string;
                studentNo: string | null;
                weakCount: number;
                averageMastery: number;
                nextStep: { id?: string; title: string; type: string } | null;
            }>,
        };
    }

    const { preparedStudents, profiles } = await prepareClassStudents(userId, classId, rawStudents);
    const masteryByStudent = new Map<string, Map<string, number>>();
    const students = preparedStudents.map((entry) => {
        const studentScoreMap = new Map<string, number>();
        for (const [kp, mRow] of entry.mastery.entries()) {
            studentScoreMap.set(kp, mRow.score);
        }
        masteryByStudent.set(entry.student.id, studentScoreMap);
        const scores = [...entry.mastery.values()].map((row) => row.score);
        const path = entry.existing ? presentPath(entry.existing, entry.mastery) : null;
        const weak = (path?.mastery ?? [...entry.mastery.values()].map((row) => ({ score: row.score })))
            .filter((row) => row.score < 0.7);
        return {
            studentId: entry.student.id,
            name: entry.student.name,
            studentNo: entry.student.studentNo,
            weakCount: weak.length,
            averageMastery: scores.length
                ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 100) / 100
                : 1,
            nextStep: path?.today[0] ?? path?.steps.find((step) => step.status === "pending" || step.status === "in_progress") ?? null,
        };
    });

    return { profiles, masteryByStudent, students };
}

/** 班级学习总览：整班一次批量加载证据、路径与提交记录，在内存中计算，避免每名学生 N+1 查询 */
export async function listClassPaths(userId: string, classId: string, language: "zh" | "en") {
    const cls = await prisma.gradingClass.findFirst({
        where: { id: classId, userId },
        include: { students: { orderBy: { order: "asc" } } },
    });
    if (!cls) return null;
    if (cls.students.length === 0) {
        return {
            classId: cls.id,
            className: cls.name,
            students: [],
            classWeaknesses: [],
            topicBrief: classTopicBrief([]),
        };
    }

    const [graph, { preparedStudents, profiles }] = await Promise.all([
        loadTagGraph(userId),
        prepareClassStudents(userId, cls.id, cls.students),
    ]);

    // 所有需要新建或重排的学生在单事务中统一物化，缓存命中的学生不写库
    const needUpdate = preparedStudents.filter((entry) => !entry.existing || entry.existing.evidenceHash !== entry.evidenceHashValue);
    const updatedByStudentKey = new Map<string, PersistedLearningPath>();
    if (needUpdate.length > 0) {
        await prisma.$transaction(async (tx) => {
            await persistMasteryBatchInTx(
                tx,
                needUpdate.map((entry) => ({ userId, studentKey: entry.resolved.studentKey, mastery: entry.mastery })),
            );
            for (const entry of needUpdate) {
                const planned = buildPlanInput(entry.items, entry.profile, entry.mastery, entry.dueItemIds, graph, entry.existing, language);
                const saved = await saveReplannedPathInTx(
                    tx,
                    userId,
                    entry.resolved,
                    entry.existing,
                    entry.evidenceHashValue,
                    planned,
                );
                updatedByStudentKey.set(entry.student.id, saved);
            }
        }, { timeout: 60000 });
    }

    const students = preparedStudents.map((entry) => {
        const persisted = updatedByStudentKey.get(entry.student.id) ?? entry.existing!;
        const view = attachSourceQuestions(presentPath(persisted, entry.mastery), entry.items);
        const weak = view.mastery.filter((item) => item.score < 0.7);
        return {
            studentId: entry.student.id,
            name: entry.student.name,
            studentNo: entry.student.studentNo,
            pathId: view.id,
            version: view.version,
            weakCount: weak.length,
            averageMastery: view.mastery.length
                ? Math.round((view.mastery.reduce((sum, item) => sum + item.score, 0) / view.mastery.length) * 100) / 100
                : 1,
            nextStep: view.today[0] ?? view.steps.find((step) => step.status === "pending" || step.status === "in_progress") ?? null,
        };
    });

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
