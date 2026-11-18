import type { Prisma, PrismaClient } from '@prisma/client';
import { parseDifficultyStars } from '@/lib/ai/schema';
import { EXAM_DIFFICULTIES, EXAM_SCOPES, summarizePaperStatus } from '@/lib/exam';
import { sanitizeFigureSvg } from '@/lib/figure-svg';
import { LEARNER_KIND } from '@/lib/learners';
import { isPracticeResult, scheduleMasteryEvaluation, syncMasteryLevels } from '@/lib/mastery';
import { resolveNotebookScope } from '@/lib/notebook-scope';
import { getDefaultPaperLevel } from '@/lib/paper-level';
import { findDuplicateQuestion, recordDuplicateQuestion } from '@/lib/question-deduplication';
import { generateUniqueShortId, isShortId } from '@/lib/short-id';
import { sanitizeSvgAnimation } from '@/lib/svg-animation';
import { importSpeeches, type BackupSpeech } from '@/lib/tts/speech-cache';
import { unpackBackupZipStream, type UnpackedBackupArchive } from '@/lib/backup/archive-read';
import { createBackupEntryDecryptor } from '@/lib/backup/crypto';
import { BackupError, BackupFormatError, BackupOwnershipError } from '@/lib/backup/errors';
import { restoreMediaInJsonArray, restoreMediaValue } from '@/lib/backup/media';
import {
    asJsonText,
    asOptionalBoolean,
    asOptionalNumber,
    asOptionalString,
    asRequiredString,
    mapNullableStringArrayIds,
    mapStringArrayIds,
    parseUserPreferences,
    safeLastPractice,
    safeMasteryLevel,
    safeMasteryProbability,
    safeParseDate,
} from '@/lib/backup/parse-helpers';
import type { BackupManifestV3, ImportStatsV3 } from '@/lib/backup/types';

export interface ImportV3Options {
    db: PrismaClient;
    source: ReadableStream<Uint8Array> | Uint8Array | Buffer;
    currentUser: { id: string; email: string };
    importAll: boolean;
    passphrase?: string;
    decryptEntry?: (manifest: BackupManifestV3, entryName: string, packed: Uint8Array) => Uint8Array;
}

interface BackupUserRow {
    id: string;
    email: string;
    name?: string | null;
}

interface ImportContext {
    tx: Prisma.TransactionClient;
    archive: UnpackedBackupArchive;
    currentUser: { id: string; email: string };
    importAll: boolean;
    warnings: Set<string>;
    stats: ImportStatsV3;
    masteryIds: Set<string>;
    evaluatedIds: Set<string>;
    backupUsers: Map<string, BackupUserRow>;
    userIdMap: Map<string, string | null>;
    classIdMap: Map<string, string>;
    studentIdMap: Map<string, string>;
    learnerIdMap: Map<string, string>;
    subjectIdMap: Map<string, string>;
    tagIdMap: Map<string, string>;
    tagNameByUser: Map<string, Map<string, string>>;
    provenanceIdMap: Map<string, string>;
    errorItemIdMap: Map<string, string>;
    errorItemOwnerMap: Map<string, string>;
    errorItemLearnerMap: Map<string, string | null>;
    examPaperIdMap: Map<string, string>;
    examQuestionIdMap: Map<string, string>;
    examQuestionOwnerMap: Map<string, string>;
    parentPaperIdMap: Map<string, string>;
    gradingTaskIdMap: Map<string, string>;
    gradingKeyQuestionIdMap: Map<string, string>;
    gradingSubmissionIdMap: Map<string, string>;
    practiceRecordIdMap: Map<string, string>;
    variantRunIdMap: Map<string, string>;
    variantItemIdMap: Map<string, string>;
    learningPathIdMap: Map<string, string>;
}

async function resolveOwnerId(ctx: ImportContext, rawUserId: unknown): Promise<string | null> {
    if (!ctx.importAll) return ctx.currentUser.id;
    const oldId = asOptionalString(rawUserId);
    if (!oldId) return ctx.currentUser.id;
    if (ctx.userIdMap.has(oldId)) return ctx.userIdMap.get(oldId) ?? null;

    const backupEmail = ctx.backupUsers.get(oldId)?.email;
    if (backupEmail) {
        const byEmail = await ctx.tx.user.findUnique({ where: { email: backupEmail }, select: { id: true } });
        if (byEmail) {
            ctx.userIdMap.set(oldId, byEmail.id);
            return byEmail.id;
        }
    }
    const byId = await ctx.tx.user.findUnique({ where: { id: oldId }, select: { id: true } });
    if (byId) {
        ctx.userIdMap.set(oldId, byId.id);
        return byId.id;
    }

    ctx.userIdMap.set(oldId, null);
    ctx.warnings.add('MISSING_USERS_SKIPPED');
    return null;
}

async function importRosterAndLearners(ctx: ImportContext): Promise<void> {
    await ctx.archive.readNdjson('data/gradingClasses.ndjson', async (row) => {
        const targetUserId = await resolveOwnerId(ctx, row.userId);
        const name = asOptionalString(row.name);
        const oldId = asOptionalString(row.id);
        if (!targetUserId || !name || !oldId) return;

        const existing = await ctx.tx.gradingClass.findUnique({
            where: { userId_name: { userId: targetUserId, name } },
            select: { id: true },
        });
        if (existing) {
            ctx.classIdMap.set(oldId, existing.id);
            return;
        }
        const created = await ctx.tx.gradingClass.create({
            data: { userId: targetUserId, name },
            select: { id: true },
        });
        ctx.classIdMap.set(oldId, created.id);
        ctx.stats.gradingClassesCreated++;
    });

    await ctx.archive.readNdjson('data/gradingStudents.ndjson', async (row) => {
        const oldId = asOptionalString(row.id);
        const mappedClassId = ctx.classIdMap.get(asRequiredString(row.classId));
        const name = asOptionalString(row.name);
        if (!oldId || !mappedClassId || !name) return;

        const studentNo = asOptionalString(row.studentNo);
        const existing = studentNo
            ? await ctx.tx.gradingStudent.findUnique({
                where: { classId_studentNo: { classId: mappedClassId, studentNo } },
                select: { id: true },
            })
            : await ctx.tx.gradingStudent.findFirst({
                where: { classId: mappedClassId, name, studentNo: null },
                select: { id: true },
            });
        if (existing) {
            ctx.studentIdMap.set(oldId, existing.id);
            return;
        }
        const created = await ctx.tx.gradingStudent.create({
            data: {
                classId: mappedClassId,
                name,
                studentNo,
                order: asOptionalNumber(row.order) ?? 0,
            },
            select: { id: true },
        });
        ctx.studentIdMap.set(oldId, created.id);
        ctx.stats.gradingStudentsCreated++;
    });

    await ctx.archive.readNdjson('data/learners.ndjson', async (row) => {
        const oldId = asOptionalString(row.id);
        const targetUserId = await resolveOwnerId(ctx, row.userId);
        const kind = asOptionalString(row.kind);
        const name = asOptionalString(row.name);
        if (!oldId || !targetUserId || !kind || !name) return;

        const mappedGradingStudentId = asOptionalString(row.gradingStudentId)
            ? (ctx.studentIdMap.get(asRequiredString(row.gradingStudentId)) ?? null)
            : null;
        const archivedAt = safeParseDate(row.archivedAt) ?? null;

        if (kind === LEARNER_KIND.student && mappedGradingStudentId) {
            const existing = await ctx.tx.learner.findUnique({
                where: { gradingStudentId: mappedGradingStudentId },
                select: { id: true },
            });
            if (existing) {
                ctx.learnerIdMap.set(oldId, existing.id);
                return;
            }
        } else if (kind === LEARNER_KIND.self) {
            const existingSelf = await ctx.tx.learner.findFirst({
                where: { userId: targetUserId, kind: LEARNER_KIND.self },
                select: { id: true },
            });
            if (existingSelf) {
                ctx.learnerIdMap.set(oldId, existingSelf.id);
                return;
            }
        } else if (kind === LEARNER_KIND.child) {
            const existingChild = await ctx.tx.learner.findFirst({
                where: { userId: targetUserId, kind: LEARNER_KIND.child, name, archivedAt },
                select: { id: true },
            });
            if (existingChild) {
                ctx.learnerIdMap.set(oldId, existingChild.id);
                return;
            }
        }

        const created = await ctx.tx.learner.create({
            data: {
                userId: targetUserId,
                kind,
                name,
                gradingStudentId: mappedGradingStudentId,
                order: asOptionalNumber(row.order) ?? 0,
                archivedAt,
            },
            select: { id: true },
        });
        ctx.learnerIdMap.set(oldId, created.id);
        ctx.stats.learnersCreated++;
    });
}

async function importSubjectsTagsProvenance(ctx: ImportContext): Promise<void> {
    await ctx.archive.readNdjson('data/subjects.ndjson', async (row) => {
        const oldId = asOptionalString(row.id);
        const targetUserId = await resolveOwnerId(ctx, row.userId);
        const name = asOptionalString(row.name);
        if (!oldId || !targetUserId || !name) return;

        const existing = await ctx.tx.subject.findFirst({
            where: { name, userId: targetUserId },
            select: { id: true },
        });
        if (existing) {
            ctx.subjectIdMap.set(oldId, existing.id);
            return;
        }
        const scope = resolveNotebookScope({
            name,
            stage: asOptionalString(row.stage),
            subjectKey: asOptionalString(row.subjectKey),
        });
        const created = await ctx.tx.subject.create({
            data: {
                name,
                stage: scope.stage,
                subjectKey: scope.subject,
                userId: targetUserId,
            },
            select: { id: true },
        });
        ctx.subjectIdMap.set(oldId, created.id);
        ctx.stats.subjectsCreated++;
    });

    const deferredParentLinks: Array<{ createdId: string; oldParentId: string }> = [];
    await ctx.archive.readNdjson('data/customTags.ndjson', async (row) => {
        const oldId = asOptionalString(row.id);
        const targetUserId = await resolveOwnerId(ctx, row.userId);
        const name = asOptionalString(row.name);
        const subject = asRequiredString(row.subject, 'math');
        if (!oldId || !targetUserId || !name) return;

        const existing = await ctx.tx.knowledgeTag.findFirst({
            where: { name, userId: targetUserId, isSystem: false },
            select: { id: true },
        });
        if (existing) {
            ctx.tagIdMap.set(oldId, existing.id);
            return;
        }
        const oldParentId = asOptionalString(row.parentId);
        const parentId = oldParentId && ctx.tagIdMap.has(oldParentId) ? ctx.tagIdMap.get(oldParentId)! : null;
        const created = await ctx.tx.knowledgeTag.create({
            data: {
                name,
                subject,
                isSystem: false,
                userId: targetUserId,
                parentId,
                order: asOptionalNumber(row.order) ?? 0,
                code: asOptionalString(row.code),
            },
            select: { id: true },
        });
        ctx.tagIdMap.set(oldId, created.id);
        ctx.stats.tagsCreated++;
        if (oldParentId && !parentId) {
            deferredParentLinks.push({ createdId: created.id, oldParentId });
        }
    });
    for (const link of deferredParentLinks) {
        const mappedParent = ctx.tagIdMap.get(link.oldParentId);
        if (mappedParent) {
            await ctx.tx.knowledgeTag.update({
                where: { id: link.createdId },
                data: { parentId: mappedParent },
            });
        }
    }

    await ctx.archive.readNdjson('data/aiProvenances.ndjson', async (row) => {
        const oldId = asOptionalString(row.id);
        const task = asOptionalString(row.task);
        const provider = asOptionalString(row.provider);
        const model = asOptionalString(row.model);
        const promptVersion = asOptionalString(row.promptVersion);
        const parserVersion = asOptionalString(row.parserVersion);
        if (!oldId || !task || !provider || !model || !promptVersion || !parserVersion) return;

        const key = { task, provider, model, promptVersion, parserVersion };
        const upserted = await ctx.tx.aiProvenance.upsert({
            where: { task_provider_model_promptVersion_parserVersion: key },
            update: {},
            create: key,
            select: { id: true },
        });
        ctx.provenanceIdMap.set(oldId, upserted.id);
    });
}

async function resolveTagConnections(
    ctx: ImportContext,
    targetUserId: string,
    rawTags: unknown,
): Promise<Array<{ id: string }>> {
    if (!Array.isArray(rawTags) || rawTags.length === 0) return [];
    let nameMap = ctx.tagNameByUser.get(targetUserId);
    if (!nameMap) {
        nameMap = new Map();
        const visibleTags = await ctx.tx.knowledgeTag.findMany({
            where: { OR: [{ isSystem: true }, { userId: targetUserId }] },
            select: { id: true, name: true, userId: true },
        });
        for (const tag of visibleTags) {
            if (!nameMap.has(tag.name) || tag.userId === targetUserId) {
                nameMap.set(tag.name, tag.id);
            }
        }
        ctx.tagNameByUser.set(targetUserId, nameMap);
    }

    const connections: Array<{ id: string }> = [];
    for (const entry of rawTags) {
        if (!entry || typeof entry !== 'object') continue;
        const tag = entry as { id?: unknown; name?: unknown };
        if (typeof tag.id === 'string' && ctx.tagIdMap.has(tag.id)) {
            connections.push({ id: ctx.tagIdMap.get(tag.id)! });
        } else if (typeof tag.name === 'string' && nameMap.has(tag.name)) {
            connections.push({ id: nameMap.get(tag.name)! });
        }
    }
    return connections;
}

async function importCoreLearningRecords(
    ctx: ImportContext,
    loadMedia: (hash: string) => Promise<Buffer>,
): Promise<void> {
    await ctx.archive.readNdjson('data/errorItems.ndjson', async (row) => {
        const oldId = asOptionalString(row.id);
        const targetUserId = await resolveOwnerId(ctx, row.userId);
        if (!oldId || !targetUserId) return;

        ctx.errorItemOwnerMap.set(oldId, targetUserId);
        const oldLearnerId = asOptionalString(row.learnerId);
        const mappedLearnerId = oldLearnerId ? (ctx.learnerIdMap.get(oldLearnerId) ?? null) : null;
        const newSubjectId = asOptionalString(row.subjectId)
            ? ctx.subjectIdMap.get(asRequiredString(row.subjectId))
            : undefined;
        const originalImageUrl = await restoreMediaValue(asOptionalString(row.originalImageUrl), loadMedia);

        const content = {
            questionText: asOptionalString(row.questionText),
            ocrText: asOptionalString(row.ocrText),
            answerText: asOptionalString(row.answerText),
            analysis: asOptionalString(row.analysis),
            wrongAnswerText: asOptionalString(row.wrongAnswerText),
            mistakeAnalysis: asOptionalString(row.mistakeAnalysis),
            originalImageUrl,
        };
        const duplicate = await findDuplicateQuestion(ctx.tx, { userId: targetUserId, learnerId: mappedLearnerId }, content);
        if (duplicate) {
            const existing = await recordDuplicateQuestion(ctx.tx, { userId: targetUserId, learnerId: mappedLearnerId }, duplicate, content);
            ctx.errorItemIdMap.set(oldId, existing.id);
            ctx.errorItemLearnerMap.set(oldId, existing.learnerId ?? null);
            ctx.masteryIds.add(existing.id);
            ctx.stats.duplicateErrorItems++;
            ctx.stats.practiceRecordsCreated++;
            return;
        }

        const rawShortId = asOptionalString(row.shortId);
        const keepShortId = isShortId(rawShortId)
            && !(await ctx.tx.errorItem.findUnique({ where: { shortId: rawShortId! }, select: { id: true } }));
        const difficultyStars = parseDifficultyStars(row.difficultyStars);
        const masteryProbability = safeMasteryProbability(row.masteryProbability);
        const masteryEvaluatedAt = masteryProbability === null ? undefined : safeParseDate(row.masteryEvaluatedAt);
        const figureSvg = sanitizeFigureSvg(asOptionalString(row.figureSvg));
        const mappedProvId = asOptionalString(row.provenanceId)
            ? (ctx.provenanceIdMap.get(asRequiredString(row.provenanceId)) ?? null)
            : null;
        const tagConnections = await resolveTagConnections(ctx, targetUserId, row.tags);

        const created = await ctx.tx.errorItem.create({
            data: {
                shortId: keepShortId ? rawShortId! : await generateUniqueShortId(ctx.tx),
                userId: targetUserId,
                subjectId: newSubjectId || null,
                learnerId: mappedLearnerId,
                originalImageUrl,
                ocrText: content.ocrText,
                questionText: content.questionText,
                answerText: content.answerText,
                analysis: content.analysis,
                wrongAnswerText: content.wrongAnswerText,
                mistakeAnalysis: content.mistakeAnalysis,
                mistakeStatus: asOptionalString(row.mistakeStatus),
                knowledgePoints: asOptionalString(row.knowledgePoints),
                source: asOptionalString(row.source),
                errorType: asOptionalString(row.errorType),
                userNotes: asOptionalString(row.userNotes),
                masteryLevel: safeMasteryLevel(row.masteryLevel),
                gradeSemester: asOptionalString(row.gradeSemester),
                paperLevel: asOptionalString(row.paperLevel) ?? getDefaultPaperLevel(difficultyStars),
                difficultyStars,
                hasFigure: row.hasFigure === true || figureSvg !== null,
                figureSvg,
                geogebraCommands: typeof row.geogebraCommands === 'string' && row.geogebraCommands ? row.geogebraCommands : null,
                svgAnimation: sanitizeSvgAnimation(asOptionalString(row.svgAnimation)),
                svgAnimationEn: sanitizeSvgAnimation(asOptionalString(row.svgAnimationEn)),
                lastPractice: safeLastPractice(row.lastPractice),
                provenanceId: mappedProvId,
                ...(masteryProbability !== null && masteryEvaluatedAt ? {
                    masteryProbability,
                    masteryReason: asOptionalString(row.masteryReason),
                    masterySource: row.masterySource === 'ai' || row.masterySource === 'rule' ? row.masterySource : null,
                    masteryEvaluatedAt,
                } : {}),
                createdAt: safeParseDate(row.createdAt),
                updatedAt: safeParseDate(row.updatedAt),
                ...(tagConnections.length > 0 ? { tags: { connect: tagConnections } } : {}),
            },
            select: { id: true, masteryEvaluatedAt: true },
        });
        ctx.errorItemIdMap.set(oldId, created.id);
        ctx.errorItemLearnerMap.set(oldId, mappedLearnerId);
        if (created.masteryEvaluatedAt) ctx.evaluatedIds.add(created.id);
        ctx.stats.errorItemsCreated++;
        ctx.stats.tagsLinked += tagConnections.length;
    });

    await ctx.archive.readNdjson('data/reviewSchedules.ndjson', async () => {
        ctx.warnings.add('LEGACY_REVIEW_SCHEDULE_IGNORED');
    });

    await ctx.archive.readNdjson('data/examPapers.ndjson', async (row) => {
        const oldId = asOptionalString(row.id);
        const targetUserId = await resolveOwnerId(ctx, row.userId);
        const title = asOptionalString(row.title);
        if (!oldId || !targetUserId || !title) return;

        const createdAt = safeParseDate(row.createdAt);
        const existingPaper = createdAt
            ? await ctx.tx.examPaper.findFirst({ where: { userId: targetUserId, title, createdAt }, select: { id: true } })
            : null;
        if (existingPaper) {
            ctx.examPaperIdMap.set(oldId, existingPaper.id);
            return;
        }
        const status = asRequiredString(row.status, 'ready');
        const safeStatus = ['ready', 'partial', 'failed'].includes(status) ? status : 'failed';
        const scope = EXAM_SCOPES.includes(row.scope as (typeof EXAM_SCOPES)[number]) ? String(row.scope) : 'all';
        const difficulty = EXAM_DIFFICULTIES.includes(row.difficulty as (typeof EXAM_DIFFICULTIES)[number])
            ? String(row.difficulty)
            : 'medium';
        const oldLearnerId = asOptionalString(row.learnerId);
        const mappedLearnerId = oldLearnerId ? (ctx.learnerIdMap.get(oldLearnerId) ?? null) : null;
        const created = await ctx.tx.examPaper.create({
            data: {
                userId: targetUserId,
                learnerId: mappedLearnerId,
                title,
                status: safeStatus,
                scope,
                difficulty,
                requestedCount: Math.max(0, asOptionalNumber(row.requestedCount) ?? 0),
                subjectIds: mapStringArrayIds(row.subjectIds, ctx.subjectIdMap),
                tagNames: typeof row.tagNames === 'string' ? row.tagNames : null,
                resultsRecordedAt: safeParseDate(row.resultsRecordedAt) ?? null,
                createdAt,
            },
            select: { id: true },
        });
        ctx.examPaperIdMap.set(oldId, created.id);
        ctx.stats.examPapersCreated++;
    });

    const touchedPaperIds = new Set<string>();
    await ctx.archive.readNdjson('data/examQuestions.ndjson', async (row) => {
        const oldId = asOptionalString(row.id);
        const oldPaperId = asOptionalString(row.paperId);
        const mappedPaperId = oldPaperId ? ctx.examPaperIdMap.get(oldPaperId) : undefined;
        if (!oldId || !mappedPaperId) return;

        const order = asOptionalNumber(row.order) ?? 0;
        const existingQ = await ctx.tx.examQuestion.findFirst({
            where: { paperId: mappedPaperId, order },
            select: { id: true, paper: { select: { userId: true } } },
        });
        if (existingQ) {
            ctx.examQuestionIdMap.set(oldId, existingQ.id);
            ctx.examQuestionOwnerMap.set(oldId, existingQ.paper.userId);
            return;
        }

        const oldItemId = asOptionalString(row.errorItemId);
        const mappedItemId = oldItemId ? (ctx.errorItemIdMap.get(oldItemId) ?? null) : null;
        const paper = await ctx.tx.examPaper.findUnique({ where: { id: mappedPaperId }, select: { userId: true } });
        const ownerId = paper?.userId ?? ctx.currentUser.id;
        const rawStatus = asRequiredString(row.status, 'failed');
        const createdQ = await ctx.tx.examQuestion.create({
            data: {
                paperId: mappedPaperId,
                order,
                errorItemId: mappedItemId,
                sourceShortId: asRequiredString(row.sourceShortId),
                status: rawStatus === 'ready' ? 'ready' : 'failed',
                questionText: asOptionalString(row.questionText),
                answerText: asOptionalString(row.answerText),
                analysis: asOptionalString(row.analysis),
                figureSvg: sanitizeFigureSvg(asOptionalString(row.figureSvg)),
                error: asOptionalString(row.error),
            },
            select: { id: true },
        });
        ctx.examQuestionIdMap.set(oldId, createdQ.id);
        ctx.examQuestionOwnerMap.set(oldId, ownerId);
        touchedPaperIds.add(mappedPaperId);
    });
    for (const paperId of touchedPaperIds) {
        const qs = await ctx.tx.examQuestion.findMany({ where: { paperId }, select: { status: true } });
        if (qs.length > 0) {
            await ctx.tx.examPaper.update({ where: { id: paperId }, data: { status: summarizePaperStatus(qs.map((q) => q.status)) } });
        }
    }

    await ctx.archive.readNdjson('data/practiceRecords.ndjson', async (row) => {
        const oldId = asOptionalString(row.id);
        const targetUserId = await resolveOwnerId(ctx, row.userId);
        if (!oldId || !targetUserId) return;

        const oldErrorItemId = asOptionalString(row.errorItemId);
        const mappedErrorItemId = oldErrorItemId && ctx.errorItemOwnerMap.get(oldErrorItemId) === targetUserId
            ? ctx.errorItemIdMap.get(oldErrorItemId)
            : undefined;
        const oldExamQId = asOptionalString(row.examQuestionId);
        const mappedExamQId = oldExamQId && ctx.examQuestionOwnerMap.get(oldExamQId) === targetUserId
            ? ctx.examQuestionIdMap.get(oldExamQId)
            : undefined;
        const oldLearnerId = asOptionalString(row.learnerId);
        const mappedLearnerId = oldLearnerId
            ? (ctx.learnerIdMap.get(oldLearnerId) ?? null)
            : (oldErrorItemId ? (ctx.errorItemLearnerMap.get(oldErrorItemId) ?? null) : null);

        const result = isPracticeResult(asOptionalString(row.result) ?? undefined) ? asOptionalString(row.result)! : undefined;
        const originalImageUrl = asOptionalString(row.originalImageUrl)
            ? await restoreMediaValue(asOptionalString(row.originalImageUrl), loadMedia)
            : null;

        const created = await ctx.tx.practiceRecord.create({
            data: {
                userId: targetUserId,
                learnerId: mappedLearnerId,
                subject: asOptionalString(row.subject),
                difficulty: asOptionalString(row.difficulty),
                isCorrect: asOptionalBoolean(row.isCorrect),
                ...(mappedErrorItemId ? {
                    errorItemId: mappedErrorItemId,
                    result,
                    questionText: asOptionalString(row.questionText),
                    answerText: asOptionalString(row.answerText),
                    analysis: asOptionalString(row.analysis),
                    wrongAnswerText: asOptionalString(row.wrongAnswerText),
                    mistakeAnalysis: asOptionalString(row.mistakeAnalysis),
                    originalImageUrl,
                    figureSvg: sanitizeFigureSvg(asOptionalString(row.figureSvg)),
                    source: ['practice', 'manual', 'exam', 'duplicate_import'].includes(asRequiredString(row.source))
                        ? asRequiredString(row.source)
                        : 'practice',
                    examQuestionId: mappedExamQId ?? null,
                } : {}),
                createdAt: safeParseDate(row.createdAt),
            },
            select: { id: true },
        });
        ctx.practiceRecordIdMap.set(oldId, created.id);
        ctx.stats.practiceRecordsCreated++;
        if (mappedErrorItemId && result && !ctx.evaluatedIds.has(mappedErrorItemId)) {
            ctx.masteryIds.add(mappedErrorItemId);
        }
    });
}

async function importPapersGradingVariantsPaths(
    ctx: ImportContext,
    loadMedia: (hash: string) => Promise<Buffer>,
): Promise<void> {
    await ctx.archive.readNdjson('data/parentPapers.ndjson', async (row) => {
        const oldId = asOptionalString(row.id);
        const targetUserId = await resolveOwnerId(ctx, row.userId);
        const mappedLearnerId = ctx.learnerIdMap.get(asRequiredString(row.learnerId));
        if (!oldId || !targetUserId || !mappedLearnerId) return;

        const answerKeyImages = await restoreMediaInJsonArray(asOptionalString(row.answerKeyImages), loadMedia);
        const created = await ctx.tx.parentPaper.create({
            data: {
                userId: targetUserId,
                learnerId: mappedLearnerId,
                title: asOptionalString(row.title),
                status: asRequiredString(row.status, 'pending_confirmation'),
                answerKeyImages,
                hasAnswerKey: Boolean(row.hasAnswerKey),
                errorMessage: asOptionalString(row.errorMessage),
                recognizedAt: safeParseDate(row.recognizedAt) ?? null,
                confirmedAt: safeParseDate(row.confirmedAt) ?? null,
                createdAt: safeParseDate(row.createdAt),
            },
            select: { id: true },
        });
        ctx.parentPaperIdMap.set(oldId, created.id);
        ctx.stats.parentPapersCreated++;
    });

    await ctx.archive.readNdjson('data/parentPaperPages.ndjson', async (row) => {
        const mappedPaperId = ctx.parentPaperIdMap.get(asRequiredString(row.paperId));
        if (!mappedPaperId) return;
        const imageUrl = await restoreMediaValue(asOptionalString(row.imageUrl), loadMedia);
        const originalImageUrl = asOptionalString(row.originalImageUrl)
            ? await restoreMediaValue(asOptionalString(row.originalImageUrl), loadMedia)
            : null;
        await ctx.tx.parentPaperPage.create({
            data: {
                paperId: mappedPaperId,
                position: asOptionalNumber(row.position) ?? 0,
                imageUrl,
                originalImageUrl,
                createdAt: safeParseDate(row.createdAt),
            },
        });
    });

    await ctx.archive.readNdjson('data/parentPaperQuestions.ndjson', async (row) => {
        const mappedPaperId = ctx.parentPaperIdMap.get(asRequiredString(row.paperId));
        if (!mappedPaperId) return;
        const oldItemId = asOptionalString(row.importedErrorItemId);
        const oldProvId = asOptionalString(row.provenanceId);
        await ctx.tx.parentPaperQuestion.create({
            data: {
                paperId: mappedPaperId,
                position: asOptionalNumber(row.position) ?? 0,
                number: asRequiredString(row.number),
                type: asRequiredString(row.type, 'objective'),
                questionText: asRequiredString(row.questionText),
                studentAnswer: asRequiredString(row.studentAnswer),
                correctAnswer: asRequiredString(row.correctAnswer),
                verdict: asRequiredString(row.verdict, 'wrong'),
                overrideVerdict: asOptionalString(row.overrideVerdict),
                confidence: asOptionalNumber(row.confidence) ?? 0,
                errorCause: asOptionalString(row.errorCause),
                knowledgePoints: asRequiredString(row.knowledgePoints, '[]'),
                bbox: asOptionalString(row.bbox),
                subjectHint: asOptionalString(row.subjectHint),
                importedErrorItemId: oldItemId ? (ctx.errorItemIdMap.get(oldItemId) ?? null) : null,
                provenanceId: oldProvId ? (ctx.provenanceIdMap.get(oldProvId) ?? null) : null,
                selected: row.selected !== false,
                createdAt: safeParseDate(row.createdAt),
            },
        });
    });

    await ctx.archive.readNdjson('data/gradingTasks.ndjson', async (row) => {
        const oldId = asOptionalString(row.id);
        const targetUserId = await resolveOwnerId(ctx, row.userId);
        const mappedClassId = ctx.classIdMap.get(asRequiredString(row.classId));
        const title = asOptionalString(row.title);
        if (!oldId || !targetUserId || !mappedClassId || !title) return;

        const keyImageUrl = asOptionalString(row.keyImageUrl)
            ? await restoreMediaValue(asOptionalString(row.keyImageUrl), loadMedia)
            : null;
        const oldExamPaperId = asOptionalString(row.examPaperId);
        const created = await ctx.tx.gradingTask.create({
            data: {
                userId: targetUserId,
                classId: mappedClassId,
                title,
                subjectName: asRequiredString(row.subjectName, '数学'),
                examPaperId: oldExamPaperId ? (ctx.examPaperIdMap.get(oldExamPaperId) ?? null) : null,
                keyImageUrl,
                extraClassIds: mapNullableStringArrayIds(row.extraClassIds, ctx.classIdMap),
                createdAt: safeParseDate(row.createdAt),
            },
            select: { id: true },
        });
        ctx.gradingTaskIdMap.set(oldId, created.id);
        ctx.stats.gradingTasksCreated++;
    });

    await ctx.archive.readNdjson('data/gradingKeyQuestions.ndjson', async (row) => {
        const oldId = asOptionalString(row.id);
        const mappedTaskId = ctx.gradingTaskIdMap.get(asRequiredString(row.taskId));
        if (!oldId || !mappedTaskId) return;
        const created = await ctx.tx.gradingKeyQuestion.create({
            data: {
                taskId: mappedTaskId,
                order: asOptionalNumber(row.order) ?? 0,
                number: asRequiredString(row.number),
                type: asRequiredString(row.type, 'objective'),
                maxScore: asOptionalNumber(row.maxScore) ?? 1,
                answer: asRequiredString(row.answer),
                acceptedAnswers: asOptionalString(row.acceptedAnswers),
                questionText: asOptionalString(row.questionText),
                knowledgePoints: asOptionalString(row.knowledgePoints),
            },
            select: { id: true },
        });
        ctx.gradingKeyQuestionIdMap.set(oldId, created.id);
    });

    await ctx.archive.readNdjson('data/gradingSubmissions.ndjson', async (row) => {
        const oldId = asOptionalString(row.id);
        const mappedTaskId = ctx.gradingTaskIdMap.get(asRequiredString(row.taskId));
        if (!oldId || !mappedTaskId) return;
        const oldStudentId = asOptionalString(row.studentId);
        const mappedStudentId = oldStudentId ? (ctx.studentIdMap.get(oldStudentId) ?? null) : null;
        const images = (await restoreMediaInJsonArray(asRequiredString(row.images, '[]'), loadMedia)) ?? '[]';

        let matchCandidates = asOptionalString(row.matchCandidates);
        if (matchCandidates) {
            try {
                const arr: unknown = JSON.parse(matchCandidates);
                if (Array.isArray(arr)) {
                    matchCandidates = JSON.stringify(arr.map((cand) => {
                        if (!cand || typeof cand !== 'object') return cand;
                        const rec = cand as Record<string, unknown>;
                        const mappedCandId = typeof rec.studentId === 'string' ? ctx.studentIdMap.get(rec.studentId) : undefined;
                        return mappedCandId ? { ...rec, studentId: mappedCandId } : rec;
                    }));
                }
            } catch {
                // 保持原样
            }
        }

        const created = await ctx.tx.gradingSubmission.create({
            data: {
                taskId: mappedTaskId,
                studentId: mappedStudentId,
                detectedName: asOptionalString(row.detectedName),
                detectedClass: asOptionalString(row.detectedClass),
                detectedStudentNo: asOptionalString(row.detectedStudentNo),
                matchStatus: asOptionalString(row.matchStatus),
                matchConfidence: asOptionalNumber(row.matchConfidence),
                matchReason: asOptionalString(row.matchReason),
                matchCandidates,
                images,
                status: asRequiredString(row.status, 'pending'),
                totalScore: asOptionalNumber(row.totalScore),
                error: asOptionalString(row.error),
                confirmedAt: safeParseDate(row.confirmedAt) ?? null,
                importedCount: asOptionalNumber(row.importedCount) ?? 0,
                createdAt: safeParseDate(row.createdAt),
            },
            select: { id: true },
        });
        ctx.gradingSubmissionIdMap.set(oldId, created.id);
    });

    await ctx.archive.readNdjson('data/gradingResults.ndjson', async (row) => {
        const mappedSubmissionId = ctx.gradingSubmissionIdMap.get(asRequiredString(row.submissionId));
        const mappedKeyQuestionId = ctx.gradingKeyQuestionIdMap.get(asRequiredString(row.keyQuestionId));
        if (!mappedSubmissionId || !mappedKeyQuestionId) return;
        const oldItemId = asOptionalString(row.errorItemId);
        const oldProvId = asOptionalString(row.provenanceId);

        await ctx.tx.gradingResult.upsert({
            where: { submissionId_keyQuestionId: { submissionId: mappedSubmissionId, keyQuestionId: mappedKeyQuestionId } },
            update: {
                studentAnswer: asOptionalString(row.studentAnswer),
                verdict: asRequiredString(row.verdict, 'wrong'),
                score: asOptionalNumber(row.score) ?? 0,
                aiScore: asOptionalNumber(row.aiScore),
                reason: asOptionalString(row.reason),
                source: asRequiredString(row.source, 'auto'),
                errorItemId: oldItemId ? (ctx.errorItemIdMap.get(oldItemId) ?? null) : null,
                provenanceId: oldProvId ? (ctx.provenanceIdMap.get(oldProvId) ?? null) : null,
            },
            create: {
                submissionId: mappedSubmissionId,
                keyQuestionId: mappedKeyQuestionId,
                studentAnswer: asOptionalString(row.studentAnswer),
                verdict: asRequiredString(row.verdict, 'wrong'),
                score: asOptionalNumber(row.score) ?? 0,
                aiScore: asOptionalNumber(row.aiScore),
                reason: asOptionalString(row.reason),
                source: asRequiredString(row.source, 'auto'),
                errorItemId: oldItemId ? (ctx.errorItemIdMap.get(oldItemId) ?? null) : null,
                provenanceId: oldProvId ? (ctx.provenanceIdMap.get(oldProvId) ?? null) : null,
            },
        });
    });

    await ctx.archive.readNdjson('data/variantRuns.ndjson', async (row) => {
        const oldId = asOptionalString(row.id);
        const targetUserId = await resolveOwnerId(ctx, row.userId);
        if (!oldId || !targetUserId) return;

        const oldErrorItemId = asOptionalString(row.errorItemId);
        const oldStudentId = asOptionalString(row.studentId);
        const oldClassId = asOptionalString(row.classId);
        const oldSubjectId = asOptionalString(row.subjectId);
        const oldExamPaperId = asOptionalString(row.examPaperId);
        const created = await ctx.tx.variantRun.create({
            data: {
                userId: targetUserId,
                kind: asRequiredString(row.kind, 'practice'),
                mode: asRequiredString(row.mode, 'pipeline'),
                status: asRequiredString(row.status, 'completed'),
                language: asRequiredString(row.language, 'zh'),
                targetDifficulty: asOptionalString(row.targetDifficulty),
                requestedCount: asOptionalNumber(row.requestedCount) ?? 1,
                title: asOptionalString(row.title),
                errorItemId: oldErrorItemId ? (ctx.errorItemIdMap.get(oldErrorItemId) ?? null) : null,
                studentId: oldStudentId ? (ctx.studentIdMap.get(oldStudentId) ?? null) : null,
                classId: oldClassId ? (ctx.classIdMap.get(oldClassId) ?? null) : null,
                subjectId: oldSubjectId ? (ctx.subjectIdMap.get(oldSubjectId) ?? null) : null,
                examPaperId: oldExamPaperId ? (ctx.examPaperIdMap.get(oldExamPaperId) ?? null) : null,
                inputSnapshot: asJsonText(row.inputSnapshot),
                weaknessProfile: asJsonText(row.weaknessProfile),
                topicSuggestion: asJsonText(row.topicSuggestion),
                totalLatencyMs: asOptionalNumber(row.totalLatencyMs),
                promptTokens: asOptionalNumber(row.promptTokens),
                completionTokens: asOptionalNumber(row.completionTokens),
                totalTokens: asOptionalNumber(row.totalTokens),
                cost: asOptionalNumber(row.cost),
                error: asOptionalString(row.error),
                startedAt: safeParseDate(row.startedAt),
                finishedAt: safeParseDate(row.finishedAt) ?? null,
            },
            select: { id: true },
        });
        ctx.variantRunIdMap.set(oldId, created.id);
        ctx.stats.variantRunsCreated++;
    });

    await ctx.archive.readNdjson('data/variantItems.ndjson', async (row) => {
        const oldId = asOptionalString(row.id);
        const mappedRunId = ctx.variantRunIdMap.get(asRequiredString(row.runId));
        if (!oldId || !mappedRunId) return;

        const oldPrId = asOptionalString(row.practiceRecordId);
        const oldEqId = asOptionalString(row.examQuestionId);
        const oldSrcId = asOptionalString(row.sourceItemId);
        const oldProvId = asOptionalString(row.provenanceId);

        const created = await ctx.tx.variantItem.create({
            data: {
                runId: mappedRunId,
                index: asOptionalNumber(row.index) ?? 0,
                status: asRequiredString(row.status, 'pending_review'),
                plan: asJsonText(row.plan),
                questionText: asOptionalString(row.questionText),
                answerText: asOptionalString(row.answerText),
                analysis: asOptionalString(row.analysis),
                figureSvg: sanitizeFigureSvg(asOptionalString(row.figureSvg)),
                knowledgePoints: asJsonText(row.knowledgePoints) ?? '[]',
                plannedDifficulty: asOptionalString(row.plannedDifficulty),
                checkedDifficulty: asOptionalString(row.checkedDifficulty),
                difficultyConsistent: asOptionalBoolean(row.difficultyConsistent),
                verification: asJsonText(row.verification),
                similarity: asOptionalNumber(row.similarity),
                similarTo: asOptionalString(row.similarTo),
                sourceItemId: oldSrcId ? (ctx.errorItemIdMap.get(oldSrcId) ?? null) : null,
                practiceRecordId: oldPrId ? (ctx.practiceRecordIdMap.get(oldPrId) ?? null) : null,
                examQuestionId: oldEqId ? (ctx.examQuestionIdMap.get(oldEqId) ?? null) : null,
                reviewNote: asOptionalString(row.reviewNote),
                reviewedAt: safeParseDate(row.reviewedAt) ?? null,
                provenanceId: oldProvId ? (ctx.provenanceIdMap.get(oldProvId) ?? null) : null,
            },
            select: { id: true },
        });
        ctx.variantItemIdMap.set(oldId, created.id);
    });

    await ctx.archive.readNdjson('data/variantStageLogs.ndjson', async (row) => {
        const mappedRunId = ctx.variantRunIdMap.get(asRequiredString(row.runId));
        if (!mappedRunId) return;
        const oldItemId = asOptionalString(row.itemId);
        await ctx.tx.variantStageLog.create({
            data: {
                runId: mappedRunId,
                itemId: oldItemId ? (ctx.variantItemIdMap.get(oldItemId) ?? null) : null,
                stage: asRequiredString(row.stage, 'generate'),
                status: asRequiredString(row.status, 'ok'),
                latencyMs: asOptionalNumber(row.latencyMs),
                promptTokens: asOptionalNumber(row.promptTokens),
                completionTokens: asOptionalNumber(row.completionTokens),
                totalTokens: asOptionalNumber(row.totalTokens),
                cost: asOptionalNumber(row.cost),
                detail: asJsonText(row.detail),
                createdAt: safeParseDate(row.createdAt),
            },
        });
    });

    const mapStudentKey = (rawKey: unknown): string | null => {
        const key = asOptionalString(rawKey);
        if (!key) return null;
        if (key === 'self') return 'self';
        if (ctx.studentIdMap.has(key)) return ctx.studentIdMap.get(key)!;
        if (ctx.learnerIdMap.has(key)) return ctx.learnerIdMap.get(key)!;
        return null;
    };

    await ctx.archive.readNdjson('data/knowledgeMasteries.ndjson', async (row) => {
        const targetUserId = await resolveOwnerId(ctx, row.userId);
        const studentKey = mapStudentKey(row.studentKey);
        const knowledgePoint = asOptionalString(row.knowledgePoint);
        if (!targetUserId || !studentKey || !knowledgePoint) return;

        await ctx.tx.knowledgeMastery.upsert({
            where: { userId_studentKey_knowledgePoint: { userId: targetUserId, studentKey, knowledgePoint } },
            update: {
                pKnown: asOptionalNumber(row.pKnown) ?? 0.3,
                retrievability: asOptionalNumber(row.retrievability) ?? 1,
                stabilityDays: asOptionalNumber(row.stabilityDays) ?? 1,
                evidenceCount: asOptionalNumber(row.evidenceCount) ?? 0,
                lastCorrect: asOptionalBoolean(row.lastCorrect),
                lastObservedAt: safeParseDate(row.lastObservedAt) ?? null,
                dueAt: safeParseDate(row.dueAt) ?? null,
            },
            create: {
                userId: targetUserId,
                studentKey,
                knowledgePoint,
                pKnown: asOptionalNumber(row.pKnown) ?? 0.3,
                retrievability: asOptionalNumber(row.retrievability) ?? 1,
                stabilityDays: asOptionalNumber(row.stabilityDays) ?? 1,
                evidenceCount: asOptionalNumber(row.evidenceCount) ?? 0,
                lastCorrect: asOptionalBoolean(row.lastCorrect),
                lastObservedAt: safeParseDate(row.lastObservedAt) ?? null,
                dueAt: safeParseDate(row.dueAt) ?? null,
            },
        });
        ctx.stats.knowledgeMasteriesImported++;
    });

    await ctx.archive.readNdjson('data/learningPaths.ndjson', async (row) => {
        const oldId = asOptionalString(row.id);
        const targetUserId = await resolveOwnerId(ctx, row.userId);
        const studentKey = mapStudentKey(row.studentKey);
        const studentName = asOptionalString(row.studentName);
        if (!oldId || !targetUserId || !studentKey || !studentName) return;

        const oldClassId = asOptionalString(row.classId);
        const mappedClassId = oldClassId ? (ctx.classIdMap.get(oldClassId) ?? null) : null;
        const upserted = await ctx.tx.learningPath.upsert({
            where: { userId_studentKey: { userId: targetUserId, studentKey } },
            update: {
                studentName,
                classId: mappedClassId,
                version: asOptionalNumber(row.version) ?? 1,
                status: asRequiredString(row.status, 'active'),
                evidenceHash: asRequiredString(row.evidenceHash),
                planReason: asOptionalString(row.planReason),
                aiSuggestCount: asOptionalNumber(row.aiSuggestCount) ?? 0,
                aiSuggestedAt: safeParseDate(row.aiSuggestedAt) ?? null,
                plannedAt: safeParseDate(row.plannedAt),
            },
            create: {
                userId: targetUserId,
                studentKey,
                studentName,
                classId: mappedClassId,
                version: asOptionalNumber(row.version) ?? 1,
                status: asRequiredString(row.status, 'active'),
                evidenceHash: asRequiredString(row.evidenceHash),
                planReason: asOptionalString(row.planReason),
                aiSuggestCount: asOptionalNumber(row.aiSuggestCount) ?? 0,
                aiSuggestedAt: safeParseDate(row.aiSuggestedAt) ?? null,
                plannedAt: safeParseDate(row.plannedAt),
            },
            select: { id: true },
        });
        await ctx.tx.learningPathStep.deleteMany({ where: { pathId: upserted.id } });
        ctx.learningPathIdMap.set(oldId, upserted.id);
        ctx.stats.learningPathsCreated++;
    });

    await ctx.archive.readNdjson('data/learningPathSteps.ndjson', async (row) => {
        const mappedPathId = ctx.learningPathIdMap.get(asRequiredString(row.pathId));
        if (!mappedPathId) return;
        const oldVarRunId = asOptionalString(row.variantRunId);
        await ctx.tx.learningPathStep.create({
            data: {
                pathId: mappedPathId,
                position: asOptionalNumber(row.position) ?? 0,
                type: asRequiredString(row.type, 'review_explanation'),
                title: asRequiredString(row.title),
                reason: asRequiredString(row.reason),
                knowledgePoints: asRequiredString(row.knowledgePoints, '[]'),
                errorItemIds: mapNullableStringArrayIds(row.errorItemIds, ctx.errorItemIdMap),
                variantRunId: oldVarRunId ? (ctx.variantRunIdMap.get(oldVarRunId) ?? null) : null,
                status: asRequiredString(row.status, 'pending'),
                locked: Boolean(row.locked),
                dueAt: safeParseDate(row.dueAt) ?? null,
                href: asOptionalString(row.href),
                teacherNote: asOptionalString(row.teacherNote),
                completedAt: safeParseDate(row.completedAt) ?? null,
                createdAt: safeParseDate(row.createdAt),
            },
        });
    });

    await ctx.archive.readNdjson('data/itemMemories.ndjson', async (row) => {
        const targetUserId = await resolveOwnerId(ctx, row.userId);
        const oldErrorItemId = asOptionalString(row.errorItemId);
        const mappedErrorItemId = oldErrorItemId ? (ctx.errorItemIdMap.get(oldErrorItemId) ?? null) : null;
        if (!targetUserId || !mappedErrorItemId) return;

        const oldLearnerId = asOptionalString(row.learnerId);
        let mappedLearnerId: string | null = null;
        if (oldLearnerId) {
            mappedLearnerId = ctx.learnerIdMap.get(oldLearnerId) ?? null;
            if (!mappedLearnerId) return;
        }
        const scopeKey = mappedLearnerId ?? 'self';
        const algorithmVersion = asRequiredString(row.algorithmVersion, 'fsrs-v1');
        const dueAt = safeParseDate(row.dueAt);
        if (!dueAt) return;

        await ctx.tx.itemMemory.upsert({
            where: {
                userId_scopeKey_errorItemId_algorithmVersion: {
                    userId: targetUserId,
                    scopeKey,
                    errorItemId: mappedErrorItemId,
                    algorithmVersion,
                },
            },
            update: {
                learnerId: mappedLearnerId,
                stability: asOptionalNumber(row.stability) ?? 1,
                difficulty: asOptionalNumber(row.difficulty) ?? 5,
                lastReviewAt: safeParseDate(row.lastReviewAt) ?? null,
                dueAt,
                reps: asOptionalNumber(row.reps) ?? 0,
                lapses: asOptionalNumber(row.lapses) ?? 0,
            },
            create: {
                userId: targetUserId,
                learnerId: mappedLearnerId,
                scopeKey,
                errorItemId: mappedErrorItemId,
                stability: asOptionalNumber(row.stability) ?? 1,
                difficulty: asOptionalNumber(row.difficulty) ?? 5,
                lastReviewAt: safeParseDate(row.lastReviewAt) ?? null,
                dueAt,
                reps: asOptionalNumber(row.reps) ?? 0,
                lapses: asOptionalNumber(row.lapses) ?? 0,
                algorithmVersion,
            },
        });
        ctx.stats.itemMemoriesImported++;
    });
}

/** 从流式 ZIP v3 备份归档恢复学习数据 */
export async function importBackupV3(options: ImportV3Options): Promise<{
    stats: ImportStatsV3;
    warnings: string[];
}> {
    let archive: UnpackedBackupArchive;
    try {
        archive = await unpackBackupZipStream(options.source, {
            decryptEntry: options.decryptEntry,
            resolveDecryptor: (manifest) => (
                !options.decryptEntry && manifest.encryption
                    ? createBackupEntryDecryptor(manifest.encryption, options.passphrase)
                    : undefined
            ),
        });
    } catch (error) {
        if (error instanceof BackupError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        throw new BackupFormatError(msg);
    }

    try {
        const { manifest } = archive;
        if (!options.importAll && manifest.user.email !== options.currentUser.email) {
            throw new BackupOwnershipError();
        }

        const warnings = new Set<string>(manifest.warnings ?? []);
        const backupUsers = new Map<string, BackupUserRow>();
        await archive.readNdjson('data/users.ndjson', async (row) => {
            if (typeof row.id === 'string' && typeof row.email === 'string') {
                backupUsers.set(row.id, { id: row.id, email: row.email, name: asOptionalString(row.name) });
            }
        });

        const stats: ImportStatsV3 = {
            learnersCreated: 0,
            gradingClassesCreated: 0,
            gradingStudentsCreated: 0,
            subjectsCreated: 0,
            tagsCreated: 0,
            errorItemsCreated: 0,
            reviewSchedulesCreated: 0,
            examPapersCreated: 0,
            preferencesRestored: false,
            practiceRecordsCreated: 0,
            parentPapersCreated: 0,
            gradingTasksCreated: 0,
            variantRunsCreated: 0,
            knowledgeMasteriesImported: 0,
            itemMemoriesImported: 0,
            learningPathsCreated: 0,
            tagsLinked: 0,
            duplicateErrorItems: 0,
            ttsSpeechesImported: 0,
        };
        const masteryIds = new Set<string>();
        const evaluatedIds = new Set<string>();
        const importedUserIds = new Set<string>([options.currentUser.id]);
        const loadMedia = (hash: string) => archive.readBinary(`media/${hash}`);

        await options.db.$transaction(async (tx) => {
            const ctx: ImportContext = {
                tx,
                archive,
                currentUser: options.currentUser,
                importAll: options.importAll,
                warnings,
                stats,
                masteryIds,
                evaluatedIds,
                backupUsers,
                userIdMap: new Map(),
                classIdMap: new Map(),
                studentIdMap: new Map(),
                learnerIdMap: new Map(),
                subjectIdMap: new Map(),
                tagIdMap: new Map(),
                tagNameByUser: new Map(),
                provenanceIdMap: new Map(),
                errorItemIdMap: new Map(),
                errorItemOwnerMap: new Map(),
                errorItemLearnerMap: new Map(),
                examPaperIdMap: new Map(),
                examQuestionIdMap: new Map(),
                examQuestionOwnerMap: new Map(),
                parentPaperIdMap: new Map(),
                gradingTaskIdMap: new Map(),
                gradingKeyQuestionIdMap: new Map(),
                gradingSubmissionIdMap: new Map(),
                practiceRecordIdMap: new Map(),
                variantRunIdMap: new Map(),
                variantItemIdMap: new Map(),
                learningPathIdMap: new Map(),
            };

            const preferences = manifest.user.email === options.currentUser.email
                ? parseUserPreferences(manifest.user as unknown as Record<string, unknown>)
                : {};
            if (Object.keys(preferences).length > 0) {
                await tx.user.update({ where: { id: options.currentUser.id }, data: preferences });
                stats.preferencesRestored = true;
            }

            await importRosterAndLearners(ctx);
            await importSubjectsTagsProvenance(ctx);
            await importCoreLearningRecords(ctx, loadMedia);
            await importPapersGradingVariantsPaths(ctx, loadMedia);

            if (typeof preferences.masteryThreshold === 'number') {
                await syncMasteryLevels(tx, options.currentUser.id, preferences.masteryThreshold);
            }
            for (const targetUserId of ctx.userIdMap.values()) {
                if (targetUserId) importedUserIds.add(targetUserId);
            }
        }, { timeout: 120000 });

        if (masteryIds.size > 0) {
            scheduleMasteryEvaluation([...masteryIds]);
        }

        // 导入 TTS 语音文件缓存
        const speeches: BackupSpeech[] = [];
        await archive.readNdjson('data/ttsSpeeches.ndjson', async (row) => {
            const id = asOptionalString(row.id);
            if (!id || !archive.hasEntry(`tts/${id}.mp3`)) return;
            const audioBuf = await archive.readBinary(`tts/${id}.mp3`);
            speeches.push({
                provider: asRequiredString(row.provider) as BackupSpeech['provider'],
                model: asRequiredString(row.model),
                voice: asRequiredString(row.voice),
                language: row.language === 'en' ? 'en' : 'zh',
                text: asRequiredString(row.text),
                ...(typeof row.rate === 'number' ? { rate: row.rate } : {}),
                ...(typeof row.pitch === 'string' ? { pitch: row.pitch } : {}),
                audio: audioBuf.toString('base64'),
            });
        });
        if (speeches.length > 0) {
            stats.ttsSpeechesImported = await importSpeeches(speeches, [...importedUserIds]).catch(() => 0);
        }

        return { stats, warnings: [...warnings] };
    } finally {
        await archive.cleanup();
    }
}
