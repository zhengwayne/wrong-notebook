import type { PrismaClient } from '@prisma/client';
import { parseDifficultyStars } from '@/lib/ai/schema';
import { EXAM_DIFFICULTIES, EXAM_SCOPES, summarizePaperStatus } from '@/lib/exam';
import { sanitizeFigureSvg } from '@/lib/figure-svg';
import { isPracticeResult, scheduleMasteryEvaluation, syncMasteryLevels } from '@/lib/mastery';
import { resolveNotebookScope } from '@/lib/notebook-scope';
import { getDefaultPaperLevel } from '@/lib/paper-level';
import { findDuplicateQuestion, recordDuplicateQuestion } from '@/lib/question-deduplication';
import { generateUniqueShortId, isShortId } from '@/lib/short-id';
import { sanitizeSvgAnimation } from '@/lib/svg-animation';
import { importSpeeches } from '@/lib/tts/speech-cache';
import { restoreBackupTags, type BackupCustomTag } from '@/lib/backup/tags';
import { BackupFormatError, BackupOwnershipError } from '@/lib/backup/errors';
import {
    asJsonText,
    asOptionalBoolean,
    asOptionalNumber,
    asOptionalString,
    mapStringArrayIds,
    parseUserPreferences,
    safeLastPractice,
    safeMasteryLevel,
    safeMasteryProbability,
    safeParseDate,
} from '@/lib/backup/parse-helpers';

export interface LegacyImportData {
    version: number;
    exportedAt: string;
    scope?: string;
    user: {
        id: string;
        email: string;
        name: string | null;
        educationStage: string | null;
        enrollmentYear: number | null;
        role: string;
        confirmBeforeImport?: boolean;
        gradeRecognitionMode?: string;
        fixedGradeSemester?: string | null;
        questionDuplicateThreshold?: number;
        masteryThreshold?: number;
        enableGeogebra?: boolean;
        enableSvgAnimation?: boolean;
        themePreference?: string;
        variantPipelineEnabled?: boolean;
    };
    subjects?: Array<{
        id: string;
        name: string;
        stage?: string | null;
        subjectKey?: string | null;
        userId: string;
    }>;
    customTags?: Array<{
        id: string;
        name: string;
        subject?: string;
        parentId?: string | null;
        systemParentPath?: unknown;
        order?: number;
        code?: string | null;
        isSystem?: boolean;
        userId?: string;
    }>;
    errorItems: Array<{
        id: string;
        shortId?: string | null;
        userId: string;
        subjectId: string | null;
        originalImageUrl: string;
        ocrText: string | null;
        questionText: string | null;
        answerText: string | null;
        analysis: string | null;
        wrongAnswerText: string | null;
        mistakeAnalysis: string | null;
        mistakeStatus: string | null;
        knowledgePoints: string | null;
        source: string | null;
        errorType: string | null;
        userNotes: string | null;
        masteryLevel: number;
        gradeSemester: string | null;
        paperLevel: string | null;
        difficultyStars?: number | null;
        hasFigure?: boolean;
        figureSvg?: string | null;
        geogebraCommands?: string | null;
        svgAnimation?: string | null;
        svgAnimationEn?: string | null;
        lastPractice?: string | null;
        masteryProbability?: number | null;
        masteryReason?: string | null;
        masterySource?: string | null;
        masteryEvaluatedAt?: string | null;
        provenanceId?: string | null;
        createdAt: string;
        updatedAt: string;
        tags: Array<{ id: string; name: string; subject: string; systemPath?: string[] }>;
    }>;
    reviewSchedules?: Array<{
        id: string;
        errorItemId: string;
        scheduledFor: string;
        completedAt: string | null;
        isCorrect: boolean | null;
    }>;
    practiceRecords?: Array<{
        id: string;
        userId: string;
        subject: string | null;
        difficulty: string | null;
        isCorrect: boolean | null;
        errorItemId?: string | null;
        result?: string | null;
        questionText?: string | null;
        answerText?: string | null;
        analysis?: string | null;
        wrongAnswerText?: string | null;
        mistakeAnalysis?: string | null;
        originalImageUrl?: string | null;
        figureSvg?: string | null;
        source?: string;
        examQuestionId?: string | null;
        createdAt: string;
    }>;
    examPapers?: Array<{
        id: string;
        userId: string;
        title: string;
        status: string;
        scope: string;
        difficulty: string;
        requestedCount: number;
        subjectIds: string;
        tagNames: string | null;
        resultsRecordedAt: string | null;
        createdAt: string;
        questions: Array<{
            id: string;
            order: number;
            errorItemId: string | null;
            sourceShortId: string;
            status: string;
            questionText: string | null;
            answerText: string | null;
            analysis: string | null;
            figureSvg: string | null;
            error: string | null;
        }>;
    }>;
    variantRuns?: Array<
        Record<string, unknown> & {
            items?: Array<Record<string, unknown>>;
            stages?: Array<Record<string, unknown>>;
        }
    >;
    aiProvenances?: Array<{
        id: string;
        task: string;
        provider: string;
        model: string;
        promptVersion: string;
        parserVersion: string;
    }>;
    ttsSpeeches?: unknown;
}

/** 兼容导入旧版 v1 / v2 JSON 备份（明确标注旧格式能力边界，修正 VariantRun 归属与阶段日志恢复） */
export async function importLegacyJsonBackup(options: {
    db: PrismaClient;
    body: LegacyImportData;
    currentUser: { id: string; email: string };
    importAll: boolean;
}) {
    const { db, body, currentUser, importAll } = options;
    if (!body?.version || !body?.user || !Array.isArray(body.errorItems)) {
        throw new BackupFormatError("Invalid import data format");
    }
    if (!importAll && body.scope === 'all') {
        throw new BackupFormatError('Use the all-users import for this backup', 'BACKUP_ALL_USERS_REQUIRED');
    }
    if (!importAll && body.user.email !== currentUser.email) {
        throw new BackupOwnershipError();
    }

    const stats = {
        subjectsCreated: 0,
        tagsCreated: 0,
        errorItemsCreated: 0,
        reviewSchedulesCreated: 0,
        examPapersCreated: 0,
        preferencesRestored: false,
        practiceRecordsCreated: 0,
        variantRunsCreated: 0,
        tagsLinked: 0,
        duplicateErrorItems: 0,
        ttsSpeechesImported: 0,
    };
    const warnings = ['LEGACY_JSON_PARTIAL_FORMAT'];
    if ((body.reviewSchedules?.length ?? 0) > 0) {
        warnings.push('LEGACY_REVIEW_SCHEDULE_DEPRECATED');
    }

    const masteryIds = new Set<string>();
    const evaluatedIds = new Set<string>();
    const tagWarnings = new Set<string>();

    await db.$transaction(async (tx) => {
        const preferences = body.user.email === currentUser.email ? parseUserPreferences(body.user) : {};
        if (Object.keys(preferences).length > 0) {
            await tx.user.update({ where: { id: currentUser.id }, data: preferences });
            stats.preferencesRestored = true;
        }

        const subjectIdMap = new Map<string, string>();
        for (const subject of (body.subjects || [])) {
            const targetUserId = importAll ? subject.userId : currentUser.id;
            const existing = await tx.subject.findFirst({ where: { name: subject.name, userId: targetUserId } });
            if (existing) {
                subjectIdMap.set(subject.id, existing.id);
            } else {
                const scope = resolveNotebookScope(subject);
                const created = await tx.subject.create({
                    data: { name: subject.name, stage: scope.stage, subjectKey: scope.subject, userId: targetUserId },
                });
                subjectIdMap.set(subject.id, created.id);
                stats.subjectsCreated++;
            }
        }

        const customTags: BackupCustomTag[] = [];
        for (const row of (body.customTags ?? [])) {
            const id = asOptionalString(row?.id);
            const name = asOptionalString(row?.name);
            if (!id || !name) continue;
            const rawSubject = asOptionalString(row.subject);
            const rawParentId = asOptionalString(row.parentId);
            const rawCode = asOptionalString(row.code);
            const rawUserId = asOptionalString(row.userId);
            customTags.push({
                id,
                name,
                userId: importAll && rawUserId ? rawUserId : currentUser.id,
                subject: rawSubject || 'math',
                parentId: rawParentId || null,
                systemParentPath: row.systemParentPath,
                order: asOptionalNumber(row.order) ?? 0,
                code: rawCode || null,
            });
        }
        const tags = await restoreBackupTags(tx, customTags, tagWarnings);
        stats.tagsCreated += tags.created;

        const provenanceIdMap = new Map<string, string>();
        for (const prov of (body.aiProvenances || [])) {
            if (!prov?.id || !prov.task || !prov.provider || !prov.model || !prov.promptVersion || !prov.parserVersion) {
                continue;
            }
            const key = {
                task: prov.task,
                provider: prov.provider,
                model: prov.model,
                promptVersion: prov.promptVersion,
                parserVersion: prov.parserVersion,
            };
            const row = await tx.aiProvenance.upsert({
                where: { task_provider_model_promptVersion_parserVersion: key },
                update: {},
                create: key,
                select: { id: true },
            });
            provenanceIdMap.set(prov.id, row.id);
        }

        const errorItemIdMap = new Map<string, string>();
        const errorItemOwnerMap = new Map<string, string>();
        for (const item of body.errorItems) {
            const targetUserId = importAll ? item.userId : currentUser.id;
            errorItemOwnerMap.set(item.id, targetUserId);
            const newSubjectId = item.subjectId ? subjectIdMap.get(item.subjectId) : undefined;

            const duplicate = await findDuplicateQuestion(tx, { userId: targetUserId, learnerId: null }, item);
            if (duplicate) {
                const existing = await recordDuplicateQuestion(tx, { userId: targetUserId, learnerId: null }, duplicate, item);
                errorItemIdMap.set(item.id, existing.id);
                masteryIds.add(existing.id);
                stats.duplicateErrorItems++;
                stats.practiceRecordsCreated++;
                continue;
            }

            const keepShortId = isShortId(item.shortId)
                && !(await tx.errorItem.findUnique({ where: { shortId: item.shortId }, select: { id: true } }));
            const difficultyStars = parseDifficultyStars(item.difficultyStars);
            const masteryProbability = safeMasteryProbability(item.masteryProbability);
            const masteryEvaluatedAt = masteryProbability === null ? undefined : safeParseDate(item.masteryEvaluatedAt);
            const created = await tx.errorItem.create({
                data: {
                    shortId: keepShortId ? item.shortId : await generateUniqueShortId(tx),
                    userId: targetUserId,
                    subjectId: newSubjectId || undefined,
                    originalImageUrl: item.originalImageUrl || '',
                    ocrText: item.ocrText,
                    questionText: item.questionText,
                    answerText: item.answerText,
                    analysis: item.analysis,
                    wrongAnswerText: item.wrongAnswerText,
                    mistakeAnalysis: item.mistakeAnalysis,
                    mistakeStatus: item.mistakeStatus,
                    knowledgePoints: item.knowledgePoints,
                    source: item.source,
                    errorType: item.errorType,
                    userNotes: item.userNotes,
                    masteryLevel: safeMasteryLevel(item.masteryLevel),
                    gradeSemester: item.gradeSemester,
                    paperLevel: item.paperLevel ?? getDefaultPaperLevel(difficultyStars),
                    difficultyStars,
                    hasFigure: item.hasFigure === true || sanitizeFigureSvg(item.figureSvg) !== null,
                    figureSvg: sanitizeFigureSvg(item.figureSvg),
                    geogebraCommands: typeof item.geogebraCommands === 'string' && item.geogebraCommands ? item.geogebraCommands : null,
                    svgAnimation: sanitizeSvgAnimation(item.svgAnimation),
                    svgAnimationEn: sanitizeSvgAnimation(item.svgAnimationEn),
                    lastPractice: safeLastPractice(item.lastPractice),
                    provenanceId: item.provenanceId ? (provenanceIdMap.get(item.provenanceId) ?? null) : null,
                    ...(masteryProbability !== null && masteryEvaluatedAt ? {
                        masteryProbability,
                        masteryReason: item.masteryReason ?? null,
                        masterySource: item.masterySource === 'ai' || item.masterySource === 'rule' ? item.masterySource : null,
                        masteryEvaluatedAt,
                    } : {}),
                    createdAt: safeParseDate(item.createdAt),
                    updatedAt: safeParseDate(item.updatedAt),
                },
            });
            errorItemIdMap.set(item.id, created.id);
            if (created.masteryEvaluatedAt) evaluatedIds.add(created.id);
            stats.errorItemsCreated++;

            if (item.tags && item.tags.length > 0) {
                const tagConnections = await tags.connections(targetUserId, item.tags);
                if (tagConnections.length > 0) {
                    await tx.errorItem.update({
                        where: { id: created.id },
                        data: { tags: { connect: tagConnections } },
                    });
                    stats.tagsLinked += tagConnections.length;
                }
            }
        }

        // 兼容导入旧版 JSON 中的 reviewSchedules
        for (const schedule of (body.reviewSchedules || [])) {
            const newErrorItemId = errorItemIdMap.get(schedule.errorItemId);
            const scheduledFor = safeParseDate(schedule.scheduledFor);
            if (!newErrorItemId || !scheduledFor) continue;
            const existingSchedule = await tx.reviewSchedule.findFirst({
                where: { errorItemId: newErrorItemId, scheduledFor },
            });
            if (existingSchedule) continue;
            await tx.reviewSchedule.create({
                data: {
                    errorItemId: newErrorItemId,
                    scheduledFor,
                    completedAt: safeParseDate(schedule.completedAt),
                    isCorrect: schedule.isCorrect,
                },
            });
            stats.reviewSchedulesCreated++;
        }

        const examQuestionIdMap = new Map<string, string>();
        const examQuestionOwnerMap = new Map<string, string>();
        const examPaperIdMap = new Map<string, string>();
        for (const paper of (body.examPapers || [])) {
            const targetUserId = importAll ? paper.userId : currentUser.id;
            const createdAt = safeParseDate(paper.createdAt);
            const existingPaper = createdAt
                ? await tx.examPaper.findFirst({
                    where: { userId: targetUserId, title: paper.title, createdAt },
                    include: { questions: { orderBy: { order: 'asc' } } },
                })
                : null;
            if (existingPaper) {
                examPaperIdMap.set(paper.id, existingPaper.id);
                paper.questions.forEach((q, idx) => {
                    const match = existingPaper.questions.find((row) => row.order === q.order) ?? existingPaper.questions[idx];
                    if (match) {
                        examQuestionIdMap.set(q.id, match.id);
                        examQuestionOwnerMap.set(q.id, targetUserId);
                    }
                });
                continue;
            }
            const status = paper.status === 'ready' || paper.status === 'partial' || paper.status === 'failed' ? paper.status : 'failed';
            const scope = EXAM_SCOPES.includes(paper.scope as typeof EXAM_SCOPES[number]) ? paper.scope : 'all';
            const difficulty = EXAM_DIFFICULTIES.includes(paper.difficulty as typeof EXAM_DIFFICULTIES[number]) ? paper.difficulty : 'medium';
            const mappedQuestions = paper.questions.map((question, index) => ({
                oldId: question.id,
                order: typeof question.order === 'number' ? question.order : index,
                errorItemId: question.errorItemId && errorItemOwnerMap.get(question.errorItemId) === targetUserId
                    ? errorItemIdMap.get(question.errorItemId)
                    : undefined,
                sourceShortId: question.sourceShortId || '',
                status: question.status === 'ready' ? 'ready' : 'failed',
                questionText: question.questionText,
                answerText: question.answerText,
                analysis: question.analysis,
                figureSvg: sanitizeFigureSvg(question.figureSvg),
                error: question.error,
            }));
            const createdPaper = await tx.examPaper.create({
                data: {
                    userId: targetUserId,
                    title: paper.title,
                    status: mappedQuestions.length ? summarizePaperStatus(mappedQuestions.map((q) => q.status)) : status,
                    scope,
                    difficulty,
                    requestedCount: Math.max(0, paper.requestedCount || mappedQuestions.length),
                    subjectIds: mapStringArrayIds(paper.subjectIds, subjectIdMap),
                    tagNames: paper.tagNames,
                    resultsRecordedAt: safeParseDate(paper.resultsRecordedAt),
                    createdAt,
                },
            });
            examPaperIdMap.set(paper.id, createdPaper.id);
            for (const q of mappedQuestions) {
                const { oldId, ...data } = q;
                const createdQ = await tx.examQuestion.create({ data: { ...data, paperId: createdPaper.id } });
                examQuestionIdMap.set(oldId, createdQ.id);
                examQuestionOwnerMap.set(oldId, targetUserId);
            }
            stats.examPapersCreated++;
        }

        for (const record of (body.practiceRecords || [])) {
            const targetUserId = importAll ? record.userId : currentUser.id;
            const errorItemId = record.errorItemId && errorItemOwnerMap.get(record.errorItemId) === targetUserId
                ? errorItemIdMap.get(record.errorItemId)
                : undefined;
            const result = isPracticeResult(record.result) ? record.result : undefined;
            const examQuestionId = record.examQuestionId && examQuestionOwnerMap.get(record.examQuestionId) === targetUserId
                ? examQuestionIdMap.get(record.examQuestionId)
                : undefined;
            await tx.practiceRecord.create({
                data: {
                    userId: targetUserId,
                    subject: record.subject,
                    difficulty: record.difficulty,
                    isCorrect: record.isCorrect,
                    ...(errorItemId ? {
                        errorItemId,
                        result,
                        questionText: record.questionText,
                        answerText: record.answerText,
                        analysis: record.analysis,
                        wrongAnswerText: record.wrongAnswerText,
                        mistakeAnalysis: record.mistakeAnalysis,
                        originalImageUrl: record.originalImageUrl,
                        figureSvg: sanitizeFigureSvg(record.figureSvg),
                        source: ['practice', 'manual', 'exam', 'duplicate_import'].includes(record.source || '') ? record.source : 'practice',
                        examQuestionId,
                    } : {}),
                    createdAt: safeParseDate(record.createdAt),
                },
            });
            stats.practiceRecordsCreated++;
            if (errorItemId && result && !evaluatedIds.has(errorItemId)) masteryIds.add(errorItemId);
        }

        for (const run of body.variantRuns || []) {
            const targetUserId = importAll && typeof run.userId === 'string' ? run.userId : currentUser.id;
            const mappedErrorItemId = typeof run.errorItemId === 'string' ? errorItemIdMap.get(run.errorItemId) : undefined;
            const created = await tx.variantRun.create({
                data: {
                    userId: targetUserId,
                    kind: typeof run.kind === 'string' ? run.kind : 'practice',
                    mode: typeof run.mode === 'string' ? run.mode : 'pipeline',
                    status: typeof run.status === 'string' ? run.status : 'completed',
                    language: typeof run.language === 'string' ? run.language : 'zh',
                    targetDifficulty: asOptionalString(run.targetDifficulty),
                    requestedCount: typeof run.requestedCount === 'number' ? run.requestedCount : 1,
                    title: asOptionalString(run.title),
                    errorItemId: mappedErrorItemId || null,
                    subjectId: typeof run.subjectId === 'string' ? subjectIdMap.get(run.subjectId) ?? null : null,
                    examPaperId: typeof run.examPaperId === 'string' ? examPaperIdMap.get(run.examPaperId) ?? null : null,
                    inputSnapshot: asJsonText(run.inputSnapshot),
                    weaknessProfile: asJsonText(run.weaknessProfile),
                    topicSuggestion: asJsonText(run.topicSuggestion),
                    totalLatencyMs: asOptionalNumber(run.totalLatencyMs),
                    promptTokens: asOptionalNumber(run.promptTokens),
                    completionTokens: asOptionalNumber(run.completionTokens),
                    totalTokens: asOptionalNumber(run.totalTokens),
                    cost: asOptionalNumber(run.cost),
                    error: asOptionalString(run.error),
                    startedAt: safeParseDate(asOptionalString(run.startedAt)),
                    finishedAt: safeParseDate(asOptionalString(run.finishedAt)),
                },
            });
            stats.variantRunsCreated++;
            const itemIdMap = new Map<string, string>();
            for (const item of run.items || []) {
                const createdItem = await tx.variantItem.create({
                    data: {
                        runId: created.id,
                        index: typeof item.index === 'number' ? item.index : 0,
                        status: typeof item.status === 'string' ? item.status : 'pending_review',
                        plan: asJsonText(item.plan),
                        questionText: asOptionalString(item.questionText),
                        answerText: asOptionalString(item.answerText),
                        analysis: asOptionalString(item.analysis),
                        figureSvg: sanitizeFigureSvg(asOptionalString(item.figureSvg)),
                        knowledgePoints: typeof item.knowledgePoints === 'string' ? item.knowledgePoints : JSON.stringify(item.knowledgePoints || []),
                        plannedDifficulty: asOptionalString(item.plannedDifficulty),
                        checkedDifficulty: asOptionalString(item.checkedDifficulty),
                        difficultyConsistent: asOptionalBoolean(item.difficultyConsistent),
                        verification: asJsonText(item.verification),
                        similarity: asOptionalNumber(item.similarity),
                        similarTo: asOptionalString(item.similarTo),
                        sourceItemId: typeof item.sourceItemId === 'string' ? errorItemIdMap.get(item.sourceItemId) ?? null : null,
                        provenanceId: typeof item.provenanceId === 'string' ? (provenanceIdMap.get(item.provenanceId) ?? null) : null,
                        reviewNote: asOptionalString(item.reviewNote),
                        reviewedAt: safeParseDate(asOptionalString(item.reviewedAt)),
                    },
                    select: { id: true },
                });
                if (typeof item.id === 'string') itemIdMap.set(item.id, createdItem.id);
            }
            for (const stageLog of run.stages || []) {
                await tx.variantStageLog.create({
                    data: {
                        runId: created.id,
                        itemId: typeof stageLog.itemId === 'string' ? (itemIdMap.get(stageLog.itemId) ?? null) : null,
                        stage: typeof stageLog.stage === 'string' ? stageLog.stage : 'generate',
                        status: typeof stageLog.status === 'string' ? stageLog.status : 'ok',
                        latencyMs: asOptionalNumber(stageLog.latencyMs),
                        promptTokens: asOptionalNumber(stageLog.promptTokens),
                        completionTokens: asOptionalNumber(stageLog.completionTokens),
                        totalTokens: asOptionalNumber(stageLog.totalTokens),
                        cost: asOptionalNumber(stageLog.cost),
                        detail: asJsonText(stageLog.detail),
                        createdAt: safeParseDate(asOptionalString(stageLog.createdAt)),
                    },
                });
            }
        }

        if (typeof preferences.masteryThreshold === 'number') {
            await syncMasteryLevels(tx, currentUser.id, preferences.masteryThreshold);
        }
    }, { timeout: 60000 });

    for (const warning of tagWarnings) {
        if (!warnings.includes(warning)) {
            warnings.push(warning);
        }
    }

    if (masteryIds.size) scheduleMasteryEvaluation([...masteryIds]);
    stats.ttsSpeechesImported = await importSpeeches(body.ttsSpeeches, currentUser.id).catch(() => 0);

    return { stats, warnings };
}
