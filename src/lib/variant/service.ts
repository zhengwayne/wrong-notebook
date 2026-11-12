/**
 * 变式审核流程的持久化与编排：启动流水线、写入审核队列、批准后进入练习/试卷、学情画像与对比。
 */
import { prisma } from '@/lib/prisma';
import { consumeAiQuota, type QuotaUser } from '@/lib/ai-quota';
import { getAIService } from '@/lib/ai';
import type { DifficultyLevel } from '@/lib/ai/types';
import { trackBackgroundTask } from '@/lib/background-tasks';
import { serializeLastPractice } from '@/lib/last-practice';
import { DEFAULT_MASTERY_THRESHOLD, masteryStatusOf } from '@/lib/mastery-status';
import { createLogger } from '@/lib/logger';
import { generateUniqueShortId } from '@/lib/short-id';
import { createVariantAi, suggestTopic } from './ai-adapter';
import { isStudentNotebook } from './notebooks';
import { MAX_AI_CALLS_PER_RUN, MAX_GENERATE_RETRIES, MAX_VARIANTS_PER_RUN, runVariantPipeline, type PipelineInput, type PipelineResult, type StageLog, type TokenUsage } from './pipeline';
import type { VariantDifficulty, VariantItemStatus, VariantRunKind } from './schemas';
import { buildClassWeaknesses, buildWeaknessProfile, classTopicBrief, selectPracticeSlots, type ProfileItem, type WeaknessProfile } from './weakness-profile';

const logger = createLogger('variant-service');

export const MAX_CLASS_BATCH = 20;

const KNOWN_SUBJECTS = ["数学", "物理", "化学", "生物", "英语", "语文", "历史", "地理", "政治", "其他"] as const;

function subjectLabel(name?: string | null): string {
    return name && (KNOWN_SUBJECTS as readonly string[]).includes(name) ? name : "其他";
}


type DbItem = Awaited<ReturnType<typeof loadNotebookItems>>[number];

function parseTags(item: { tags: { name: string }[]; knowledgePoints: string | null }): string[] {
    if (item.tags.length > 0) return item.tags.map((tag) => tag.name);
    try {
        const parsed = JSON.parse(item.knowledgePoints || '[]');
        return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : [];
    } catch {
        return [];
    }
}

async function loadNotebookItems(userId: string, subjectIds: string[]) {
    if (subjectIds.length === 0) return [];
    return prisma.errorItem.findMany({
        where: { userId, subjectId: { in: subjectIds } },
        include: {
            tags: { select: { name: true } },
            practiceRecords: { where: { result: { not: null } }, select: { result: true, isCorrect: true, createdAt: true, questionText: true } },
        },
        orderBy: { createdAt: 'desc' },
    });
}

function toProfileItems(items: DbItem[], threshold: number): ProfileItem[] {
    return items.map((item) => {
        const last = item.practiceRecords[0] ? item.practiceRecords.reduce((latest, record) => record.createdAt > latest ? record.createdAt : latest, item.practiceRecords[0].createdAt) : null;
        return {
            id: item.id,
            knowledgePoints: parseTags(item),
            errorType: item.errorType,
            createdAt: item.createdAt,
            lastPracticedAt: last,
            practiceCount: item.practiceRecords.length,
            wrongPracticeCount: item.practiceRecords.filter((record) => record.isCorrect === false || record.result === 'wrong').length,
            masteryProbability: item.masteryProbability,
            masteryStatus: masteryStatusOf(item.practiceRecords.length, item.masteryProbability, threshold),
        };
    });
}

async function userThreshold(userId: string): Promise<number> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { masteryThreshold: true, questionDuplicateThreshold: true } });
    return user?.masteryThreshold ?? DEFAULT_MASTERY_THRESHOLD;
}

export async function findStudentSubjectIds(userId: string, studentName: string): Promise<string[]> {
    const notebooks = await prisma.subject.findMany({ where: { userId }, select: { id: true, name: true } });
    return notebooks.filter((item) => isStudentNotebook(item.name, studentName)).map((item) => item.id);
}

export async function buildProfileForSubjects(userId: string, subjectIds: string[]): Promise<{ profile: WeaknessProfile; items: DbItem[]; previous: Array<{ id: string; text: string }> }> {
    const threshold = await userThreshold(userId);
    const items = await loadNotebookItems(userId, subjectIds);
    const profile = buildWeaknessProfile(toProfileItems(items, threshold));
    const previous: Array<{ id: string; text: string }> = [];
    for (const item of items) {
        if (item.questionText?.trim()) previous.push({ id: item.id, text: item.questionText });
        for (const record of item.practiceRecords) {
            if (record.questionText?.trim()) previous.push({ id: `${item.id}-p`, text: record.questionText });
        }
    }
    return { profile, items, previous };
}

function usageFields(usage: TokenUsage) {
    return {
        promptTokens: usage.promptTokens ?? null,
        completionTokens: usage.completionTokens ?? null,
        totalTokens: usage.totalTokens ?? null,
        cost: usage.cost ?? null,
    };
}

async function persistLogs(runId: string, logs: StageLog[], itemId?: string) {
    if (logs.length === 0) return;
    await prisma.variantStageLog.createMany({
        data: logs.map((log) => ({
            runId,
            itemId: itemId ?? null,
            stage: log.stage,
            status: log.status,
            latencyMs: log.latencyMs,
            ...usageFields(log.usage || {}),
            detail: log.detail ? JSON.stringify(log.detail) : null,
        })),
    });
}

async function persistPipeline(runId: string, result: PipelineResult, title?: string) {
    const started = Date.now();
    for (const item of result.items) {
        const created = await prisma.variantItem.create({
            data: {
                runId,
                index: item.index,
                status: item.status,
                plan: JSON.stringify(item.plan),
                questionText: item.question?.questionText,
                answerText: item.question?.answerText,
                analysis: item.question?.analysis,
                figureSvg: item.question?.figureSvg ?? null,
                knowledgePoints: JSON.stringify(item.question?.knowledgePoints || item.plan.knowledgePoints || []),
                plannedDifficulty: item.plan.difficulty,
                checkedDifficulty: item.checkedDifficulty ?? null,
                difficultyConsistent: item.difficultyConsistent ?? null,
                verification: item.verification ? JSON.stringify({ ...item.verification, resolveAnswer: item.resolveAnswer, resolveAgreed: item.resolveAgreed }) : null,
                similarity: item.similarity ?? null,
                similarTo: item.similarTo ?? null,
                sourceItemId: item.sourceItemId ?? null,
            },
        });
        await persistLogs(runId, item.logs, created.id);
    }
    await persistLogs(runId, result.logs);
    await prisma.variantRun.update({
        where: { id: runId },
        data: {
            status: 'completed',
            title,
            totalLatencyMs: result.logs.concat(result.items.flatMap((item) => item.logs)).reduce((sum, log) => sum + log.latencyMs, 0) || Date.now() - started,
            ...usageFields(result.usage),
            finishedAt: new Date(),
            error: result.budgetExhausted ? 'BUDGET_EXHAUSTED' : null,
        },
    });
}

async function failRun(runId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error, runId }, '变式流水线失败');
    await prisma.variantRun.update({ where: { id: runId }, data: { status: 'failed', error: message.slice(0, 500), finishedAt: new Date() } });
}

export async function startPipelineRun(options: {
    user: QuotaUser;
    kind: VariantRunKind;
    language: 'zh' | 'en';
    targetDifficulty?: VariantDifficulty;
    count?: number;
    title?: string;
    errorItemId?: string;
    studentId?: string;
    classId?: string;
    subjectId?: string;
    input: PipelineInput;
    weaknessProfile?: WeaknessProfile;
    topicSuggestion?: unknown;
    quotaKind?: 'practice' | 'exam';
    subjectLabel?: string;
    wait?: boolean;
    skipQuota?: boolean;
}): Promise<{ id: string }> {
    if (!options.skipQuota) {
        const limited = await consumeAiQuota(options.user, options.quotaKind ?? (options.kind === 'practice' ? 'practice' : 'exam'));
        if (limited) throw new QuotaError(limited.status);
    }
    const run = await prisma.variantRun.create({
        data: {
            userId: options.user.id,
            kind: options.kind,
            mode: 'pipeline',
            language: options.language,
            targetDifficulty: options.targetDifficulty ?? options.input.targetDifficulty,
            requestedCount: options.input.count ?? 1,
            title: options.title,
            errorItemId: options.errorItemId,
            studentId: options.studentId,
            classId: options.classId,
            subjectId: options.subjectId,
            inputSnapshot: JSON.stringify({
                question: options.input.originalQuestion,
                knowledgePoints: options.input.knowledgePoints,
                errorType: options.input.errorType,
                difficulty: options.input.targetDifficulty,
                slots: options.input.plannedSlots,
            }),
            weaknessProfile: options.weaknessProfile ? JSON.stringify(options.weaknessProfile) : null,
            topicSuggestion: options.topicSuggestion ? JSON.stringify(options.topicSuggestion) : null,
        },
        select: { id: true },
    });
    const work = async () => {
        try {
            const result = await runVariantPipeline(options.input, createVariantAi(), { maxCalls: MAX_AI_CALLS_PER_RUN, maxRetries: MAX_GENERATE_RETRIES });
            await persistPipeline(run.id, result, options.title);
        } catch (error) {
            await failRun(run.id, error);
            if (options.wait) throw error;
        }
    };
    const task = { userId: options.user.id, kind: options.quotaKind ?? 'practice' as const, subject: options.subjectLabel || options.title || '变式题', link: `/variants?run=${run.id}` };
    if (options.wait) await trackBackgroundTask(task, work);
    else void trackBackgroundTask(task, work);
    return { id: run.id };
}

export class QuotaError extends Error {
    constructor(readonly status: number) {
        super('QUOTA_EXCEEDED');
    }
}

export async function startLegacyRun(options: {
    user: QuotaUser;
    errorItemId: string;
    question: string;
    knowledgePoints: string[];
    language: 'zh' | 'en';
    difficulty: DifficultyLevel;
    gradeSemester?: string | null;
    figureSvg?: string | null;
    subjectName?: string;
}): Promise<{ questionText: string; answerText: string; analysis: string; figureSvg: string | null; subject?: string; difficulty: DifficultyLevel; generatedAt: string; runId: string }> {
    const started = Date.now();
    const generated = await getAIService().generateSimilarQuestion(
        options.question, options.knowledgePoints, options.language, options.difficulty, options.gradeSemester, options.figureSvg,
    );
    const lastPractice = {
        questionText: generated.questionText,
        answerText: generated.answerText,
        analysis: generated.analysis,
        subject: subjectLabel(generated.subject || options.subjectName),
        figureSvg: generated.figureSvg ?? null,
        difficulty: options.difficulty,
        generatedAt: new Date().toISOString(),
    };
    const run = await prisma.variantRun.create({
        data: {
            userId: options.user.id,
            kind: 'legacy',
            mode: 'legacy',
            status: 'completed',
            language: options.language,
            targetDifficulty: options.difficulty,
            requestedCount: 1,
            errorItemId: options.errorItemId,
            inputSnapshot: JSON.stringify({ question: options.question, knowledgePoints: options.knowledgePoints, difficulty: options.difficulty }),
            totalLatencyMs: Date.now() - started,
            finishedAt: new Date(),
            items: {
                create: {
                    index: 0,
                    status: 'approved',
                    questionText: generated.questionText,
                    answerText: generated.answerText,
                    analysis: generated.analysis,
                    figureSvg: generated.figureSvg ?? null,
                    knowledgePoints: JSON.stringify(options.knowledgePoints),
                    plannedDifficulty: options.difficulty,
                    reviewedAt: new Date(),
                    sourceItemId: options.errorItemId,
                },
            },
        },
        select: { id: true },
    });
    try {
        await prisma.errorItem.update({ where: { id: options.errorItemId }, data: { lastPractice: serializeLastPractice(lastPractice) } });
    } catch (error) {
        logger.warn({ error, errorItemId: options.errorItemId }, '写入最近练习失败，仍返回已生成的题目');
    }
    return { ...lastPractice, runId: run.id };
}

export async function startItemPipeline(user: QuotaUser, errorItemId: string, language: 'zh' | 'en', difficulty: VariantDifficulty, options: { skipQuota?: boolean } = {}) {
    const item = await prisma.errorItem.findFirst({
        where: { id: errorItemId, userId: user.id },
        include: { subject: true, tags: { select: { name: true } } },
    });
    if (!item) return null;
    const knowledgePoints = parseTags(item);
    const previousRecords = await prisma.practiceRecord.findMany({
        where: { errorItemId, questionText: { not: null } },
        select: { id: true, questionText: true },
    });
    return startPipelineRun({
        user,
        kind: 'practice',
        language,
        targetDifficulty: difficulty,
        errorItemId,
        subjectId: item.subjectId ?? undefined,
        subjectLabel: item.questionText?.slice(0, 40) || '举一反三',
        input: {
            originalQuestion: item.questionText || item.ocrText || '',
            knowledgePoints,
            errorType: item.errorType || item.mistakeAnalysis,
            targetDifficulty: difficulty,
            language,
            count: 1,
            previousQuestions: previousRecords.map((record) => ({ id: record.id, text: record.questionText || '' })),
        },
        quotaKind: 'practice',
        wait: true,
        skipQuota: options.skipQuota,
    });
}

export async function startPersonalizedRun(user: QuotaUser, options: {
    kind: 'personalized_set' | 'topic';
    language: 'zh' | 'en';
    count?: number;
    studentId?: string;
    subjectId?: string;
    title?: string;
}) {
    const studentId = options.studentId;
    let classId: string | undefined;
    let studentName = '';
    const subjectIds: string[] = [];
    if (options.subjectId) {
        const subject = await prisma.subject.findFirst({ where: { id: options.subjectId, userId: user.id }, select: { id: true, name: true } });
        if (!subject) return null;
        subjectIds.push(subject.id);
        studentName = subject.name.split('·')[0] || subject.name;
    }
    if (studentId) {
        const student = await prisma.gradingStudent.findFirst({ where: { id: studentId, class: { userId: user.id } }, include: { class: true } });
        if (!student) return null;
        studentName = student.name;
        classId = student.classId;
        subjectIds.push(...await findStudentSubjectIds(user.id, student.name));
    }
    const uniqueIds = [...new Set(subjectIds)];
    if (uniqueIds.length === 0) return { error: 'NO_NOTEBOOK' as const };
    const { profile, items, previous } = await buildProfileForSubjects(user.id, uniqueIds);
    if (items.length === 0) return { error: 'NO_ITEMS' as const };

    const count = Math.max(3, Math.min(MAX_VARIANTS_PER_RUN, options.count ?? (options.kind === 'topic' ? 4 : 5)));
    let topicSuggestion = undefined;
    if (options.kind === 'topic') {
        const brief = classTopicBrief(profile.weaknesses.map((weakness) => ({
            knowledgePoint: weakness.knowledgePoint, studentCount: 1, averageScore: weakness.score, totalItems: weakness.itemCount,
        })));
        const topic = await suggestTopic({ ...brief, language: options.language });
        topicSuggestion = topic.data;
    }
    const points = topicSuggestion?.knowledgePoints || profile.weaknesses.map((item) => item.knowledgePoint);
    const slots = selectPracticeSlots(
        { ...profile, weaknesses: profile.weaknesses.filter((item) => points.includes(item.knowledgePoint)).concat(profile.weaknesses) },
        toProfileItems(items, await userThreshold(user.id)),
        count,
    );
    const itemById = new Map(items.map((item) => [item.id, item]));
    const run = await startPipelineRun({
        user,
        kind: options.kind,
        language: options.language,
        targetDifficulty: profile.suggestedDifficulty,
        count,
        title: options.title || topicSuggestion?.title || `${studentName} 个性化练习`,
        studentId,
        classId,
        subjectId: uniqueIds[0],
        weaknessProfile: profile,
        topicSuggestion,
        subjectLabel: studentName,
        quotaKind: 'exam',
        input: {
            originalQuestion: slots.map((slot) => itemById.get(slot.sourceItemId)?.questionText).find(Boolean) || items[0].questionText || '',
            knowledgePoints: points.slice(0, 8),
            errorType: Object.keys(profile.errorTypeSummary)[0],
            targetDifficulty: profile.suggestedDifficulty,
            language: options.language,
            count,
            previousQuestions: previous,
            plannedSlots: slots.map((slot) => ({
                knowledgePoint: slot.knowledgePoint,
                difficulty: slot.difficulty,
                sourceItemId: slot.sourceItemId,
                sourceQuestion: itemById.get(slot.sourceItemId)?.questionText || items[0].questionText || '',
                errorType: itemById.get(slot.sourceItemId)?.errorType,
            })),
        },
    });
    return run;
}

export async function startClassRuns(user: QuotaUser, options: {
    classId: string;
    kind: 'personalized_set' | 'class_topic';
    language: 'zh' | 'en';
    count?: number;
}) {
    const cls = await prisma.gradingClass.findFirst({
        where: { id: options.classId, userId: user.id },
        include: { students: { orderBy: { order: 'asc' } } },
    });
    if (!cls) return null;
    const students = cls.students.slice(0, MAX_CLASS_BATCH);
    const profiles: Array<{ studentKey: string; profile: WeaknessProfile; studentId: string; subjectIds: string[] }> = [];
    for (const student of students) {
        const subjectIds = await findStudentSubjectIds(user.id, student.name);
        if (subjectIds.length === 0) continue;
        const { profile } = await buildProfileForSubjects(user.id, subjectIds);
        if (profile.itemCount === 0) continue;
        profiles.push({ studentKey: student.id, profile, studentId: student.id, subjectIds });
    }
    if (profiles.length === 0) return { error: 'NO_ITEMS' as const, classWeaknesses: [] };

    const classWeaknesses = buildClassWeaknesses(profiles);
    if (options.kind === 'class_topic') {
        const brief = classTopicBrief(classWeaknesses);
        if (brief.knowledgePoints.length === 0) return { error: 'NO_COMMON' as const, classWeaknesses };
        const topic = await suggestTopic({ ...brief, language: options.language, studentCount: profiles.length });
        // 用班级共性知识点，从各学生错题中抽代表题作为来源
        const sourceSubjects = [...new Set(profiles.flatMap((item) => item.subjectIds))];
        const { items, previous, profile } = await buildProfileForSubjects(user.id, sourceSubjects);
        const slots = selectPracticeSlots(
            { ...profile, weaknesses: profile.weaknesses.filter((item) => brief.knowledgePoints.includes(item.knowledgePoint)) },
            toProfileItems(items, await userThreshold(user.id)),
            options.count ?? 5,
        );
        const itemById = new Map(items.map((item) => [item.id, item]));
        const run = await startPipelineRun({
            user,
            kind: 'class_topic',
            language: options.language,
            targetDifficulty: 'medium',
            title: topic.data.title,
            classId: cls.id,
            weaknessProfile: profile,
            topicSuggestion: topic.data,
            subjectLabel: `${cls.name} · ${topic.data.title}`,
            quotaKind: 'exam',
            input: {
                originalQuestion: itemById.get(slots[0]?.sourceItemId)?.questionText || items[0]?.questionText || brief.reason,
                knowledgePoints: brief.knowledgePoints,
                targetDifficulty: 'medium',
                language: options.language,
                count: slots.length || 4,
                previousQuestions: previous,
                plannedSlots: slots.map((slot) => ({
                    knowledgePoint: slot.knowledgePoint,
                    difficulty: slot.difficulty,
                    sourceItemId: slot.sourceItemId,
                    sourceQuestion: itemById.get(slot.sourceItemId)?.questionText || '',
                })),
            },
        });
        return { runIds: [run.id], classWeaknesses, topic: topic.data };
    }

    const runIds: string[] = [];
    for (const row of profiles) {
        const started = await startPersonalizedRun(user, {
            kind: 'personalized_set',
            language: options.language,
            count: options.count,
            studentId: row.studentId,
        });
        if (started && 'id' in started) runIds.push(started.id);
    }
    return { runIds, classWeaknesses };
}

export async function reviewVariantItem(userId: string, itemId: string, action: 'approve' | 'reject' | 'edit', edits?: { questionText?: string; answerText?: string; analysis?: string }, note?: string) {
    const item = await prisma.variantItem.findFirst({
        where: { id: itemId, run: { userId } },
        include: { run: true },
    });
    if (!item) return null;
    if (item.status === 'approved' && action !== 'edit') return { error: 'ALREADY_APPROVED' as const };

    const data: Record<string, unknown> = { reviewNote: note || item.reviewNote, reviewedAt: new Date() };
    if (edits?.questionText) data.questionText = edits.questionText;
    if (edits?.answerText) data.answerText = edits.answerText;
    if (edits?.analysis) data.analysis = edits.analysis;

    if (action === 'reject') {
        data.status = 'rejected';
        await prisma.variantItem.update({ where: { id: itemId }, data });
        await prisma.variantStageLog.create({ data: { runId: item.runId, itemId, stage: 'review', status: 'ok', detail: JSON.stringify({ action: 'reject', note }) } });
        return { id: itemId, status: 'rejected' as VariantItemStatus };
    }

    const questionText = (edits?.questionText ?? item.questionText)?.trim();
    const answerText = (edits?.answerText ?? item.answerText)?.trim();
    const analysis = (edits?.analysis ?? item.analysis)?.trim();
    if (!questionText || !answerText || !analysis) return { error: 'INCOMPLETE' as const };

    data.questionText = questionText;
    data.answerText = answerText;
    data.analysis = analysis;
    data.status = 'approved';
    await prisma.variantItem.update({ where: { id: itemId }, data });
    await prisma.variantStageLog.create({ data: { runId: item.runId, itemId, stage: 'review', status: 'ok', detail: JSON.stringify({ action, note }) } });

    // 单题举一反三：批准后写入该错题的最近练习，供练习页使用
    if (item.run.errorItemId && item.run.kind === 'practice') {
        await prisma.errorItem.update({
            where: { id: item.run.errorItemId },
            data: {
                lastPractice: serializeLastPractice({
                    questionText,
                    answerText,
                    analysis,
                    figureSvg: item.figureSvg,
                    difficulty: (item.plannedDifficulty as VariantDifficulty) || 'medium',
                    generatedAt: new Date().toISOString(),
                }),
            },
        });
    }
    return { id: itemId, status: 'approved' as VariantItemStatus };
}

export async function createExamFromApproved(userId: string, runId: string, title?: string) {
    const run = await prisma.variantRun.findFirst({
        where: { id: runId, userId },
        include: { items: { where: { status: 'approved' }, orderBy: { index: 'asc' } } },
    });
    if (!run) return null;
    if (run.items.length === 0) return { error: 'NO_APPROVED' as const };
    const sourceIds = [...new Set(run.items.map((item) => item.sourceItemId).filter((id): id is string => !!id))];
    const sources = sourceIds.length
        ? await prisma.errorItem.findMany({ where: { id: { in: sourceIds }, userId }, select: { id: true, shortId: true } })
        : [];
    const shortIdBySource = new Map(sources.map((item) => [item.id, item.shortId]));

    const paper = await prisma.$transaction(async (tx) => {
        const created = await tx.examPaper.create({
            data: {
                userId,
                title: title || run.title || '个性化练习卷',
                status: 'ready',
                scope: 'all',
                difficulty: run.targetDifficulty || 'medium',
                requestedCount: run.items.length,
                subjectIds: JSON.stringify(run.subjectId ? [run.subjectId] : []),
            },
        });
        for (const [index, item] of run.items.entries()) {
            const shortId = (item.sourceItemId && shortIdBySource.get(item.sourceItemId)) || await generateUniqueShortId(tx);
            const question = await tx.examQuestion.create({
                data: {
                    paperId: created.id,
                    order: index,
                    errorItemId: item.sourceItemId,
                    sourceShortId: shortId,
                    status: 'ready',
                    questionText: item.questionText,
                    answerText: item.answerText,
                    analysis: item.analysis,
                    figureSvg: item.figureSvg,
                },
            });
            await tx.variantItem.update({ where: { id: item.id }, data: { examQuestionId: question.id } });
        }
        await tx.variantRun.update({ where: { id: runId }, data: { examPaperId: created.id } });
        return created;
    });
    return { id: paper.id, title: paper.title, questionCount: run.items.length };
}
