import type { Prisma, PrismaClient } from '@prisma/client';
import { loadSystemTagPaths } from '@/lib/backup/tags';
import { getAppConfig } from '@/lib/config';
import { StreamingZipWriter } from '@/lib/backup/archive-write';
import { extractMediaDataUrl, extractMediaFromJsonArray, type ExtractedMedia } from '@/lib/backup/media';
import type {
    BackupEncryptionMeta,
    BackupManifestV3,
    BackupUserMeta,
    EntryTransform,
} from '@/lib/backup/types';
import { exportSpeeches, speechId, type AnimationNarrationSource } from '@/lib/tts/speech-cache';

const PAGE_SIZE = 50;
/** 含 base64 图片的大字段表每次仅取 2 条，控制导出期 JS 堆与 Prisma 响应缓存上限 */
const MEDIA_PAGE_SIZE = 2;

const USER_BACKUP_SELECT = {
    id: true,
    email: true,
    name: true,
    educationStage: true,
    enrollmentYear: true,
    gradeRecognitionMode: true,
    fixedGradeSemester: true,
    role: true,
    isActive: true,
    personas: true,
    activePersona: true,
    personasConfirmedAt: true,
    confirmBeforeImport: true,
    questionDuplicateThreshold: true,
    masteryThreshold: true,
    variantPipelineEnabled: true,
    enableGeogebra: true,
    enableSvgAnimation: true,
    themePreference: true,
    reviewAlgorithmVersion: true,
} satisfies Prisma.UserSelect;

export interface ExportV3Options {
    db: PrismaClient;
    currentUser: BackupUserMeta;
    exportAll: boolean;
    appVersion?: string;
    transformEntry?: EntryTransform;
    encryption?: BackupEncryptionMeta;
    extraWarnings?: string[];
}

async function streamPaged<Row extends { id: string }>(
    fetchPage: (cursor: string | undefined, take: number) => Promise<Row[]>,
    onRow: (row: Row) => Promise<void>,
    pageSize = PAGE_SIZE,
): Promise<void> {
    let cursor: string | undefined;
    while (true) {
        const rows = await fetchPage(cursor, pageSize);
        for (const row of rows) {
            await onRow(row);
        }
        if (rows.length < pageSize) break;
        cursor = rows[rows.length - 1].id;
    }
}

/**
 * 构建流式 v3 ZIP 备份 Web ReadableStream（manifest.json + data/*.ndjson + media/<sha256> + tts/*.mp3）。
 * 通过游标分页与下游背压控制内存峰值，不依赖 Asset 表。
 */
export function createBackupV3Stream(options: ExportV3Options): ReadableStream<Uint8Array> {
    const { db, currentUser, exportAll } = options;
    let writer: StreamingZipWriter | null = null;

    return new ReadableStream<Uint8Array>({
        start(controller) {
            writer = new StreamingZipWriter(controller, {
                transformEntry: options.transformEntry,
            });
            void runExport(writer).catch((error) => {
                writer?.abort(error);
            });
        },
        pull() {
            writer?.onPull();
        },
        cancel() {
            writer?.abort(new Error('Backup export stream cancelled'));
        },
    });

    async function runExport(zipWriter: StreamingZipWriter): Promise<void> {
        const userFilter = exportAll ? {} : { userId: currentUser.id };
        const seenMediaHashes = new Set<string>();
        const referencedProvenanceIds = new Set<string>();
        const narrationSources: AnimationNarrationSource[] = [];
        const counts: Record<string, number> = {};
        const derivedCounts: Record<string, number> = {};
        const warnings: string[] = [...(options.extraWarnings ?? [])];

        const emitMedia = async (media: ExtractedMedia) => {
            if (seenMediaHashes.has(media.hash)) return;
            seenMediaHashes.add(media.hash);
            await zipWriter.writeBinaryEntry(`media/${media.hash}`, media.buffer, { compress: false });
        };

        const stripMediaField = async (value: string | null | undefined): Promise<string | null> => {
            if (!value) return value ?? null;
            const media = extractMediaDataUrl(value);
            if (!media) return value;
            await emitMedia(media);
            return media.ref;
        };

        // 1. 用户信息（脱敏：不含 password）
        const usersEntry = zipWriter.openNdjsonEntry('data/users.ndjson');
        await streamPaged(
            (cursor, take) => db.user.findMany({
                where: exportAll ? {} : { id: currentUser.id },
                select: USER_BACKUP_SELECT,
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => usersEntry.writeLine(row),
        );
        counts.users = await usersEntry.close();

        // 2. 班级与花名册学生
        const classEntry = zipWriter.openNdjsonEntry('data/gradingClasses.ndjson');
        await streamPaged(
            (cursor, take) => db.gradingClass.findMany({
                where: userFilter,
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => classEntry.writeLine(row),
        );
        counts.gradingClasses = await classEntry.close();

        const studentEntry = zipWriter.openNdjsonEntry('data/gradingStudents.ndjson');
        await streamPaged(
            (cursor, take) => db.gradingStudent.findMany({
                where: exportAll ? {} : { class: { userId: currentUser.id } },
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => studentEntry.writeLine(row),
        );
        counts.gradingStudents = await studentEntry.close();

        // 3. 学习者档案
        const learnerEntry = zipWriter.openNdjsonEntry('data/learners.ndjson');
        await streamPaged(
            (cursor, take) => db.learner.findMany({
                where: userFilter,
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => learnerEntry.writeLine(row),
        );
        counts.learners = await learnerEntry.close();

        // 4. 错题本与自定义标签
        const subjectEntry = zipWriter.openNdjsonEntry('data/subjects.ndjson');
        await streamPaged(
            (cursor, take) => db.subject.findMany({
                where: userFilter,
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => subjectEntry.writeLine(row),
        );
        counts.subjects = await subjectEntry.close();

        const systemTagPaths = await loadSystemTagPaths(db);
        const tagEntry = zipWriter.openNdjsonEntry('data/customTags.ndjson');
        await streamPaged(
            (cursor, take) => db.knowledgeTag.findMany({
                where: { ...userFilter, isSystem: false },
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => tagEntry.writeLine({
                ...row,
                systemParentPath: row.parentId ? systemTagPaths.get(row.parentId)?.path : undefined,
            }),
        );
        counts.customTags = await tagEntry.close();

        // 5. 错题（流式分页并拆出原图至 media/<sha256>）
        const errorItemEntry = zipWriter.openNdjsonEntry('data/errorItems.ndjson');
        await streamPaged(
            (cursor, take) => db.errorItem.findMany({
                where: userFilter,
                include: { tags: { select: { id: true, name: true, subject: true } } },
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => {
                if (row.provenanceId) referencedProvenanceIds.add(row.provenanceId);
                if (row.svgAnimation) narrationSources.push({ language: 'zh', svg: row.svgAnimation });
                if (row.svgAnimationEn) narrationSources.push({ language: 'en', svg: row.svgAnimationEn });
                const imageRef = await stripMediaField(row.originalImageUrl);
                await errorItemEntry.writeLine({
                    ...row,
                    originalImageUrl: imageRef ?? '',
                    tags: row.tags.map((tag) => ({ ...tag, systemPath: systemTagPaths.get(tag.id)?.path })),
                });
            },
            MEDIA_PAGE_SIZE,
        );
        counts.errorItems = await errorItemEntry.close();

        // 6. 遗留 ReviewSchedule（只在未删除表前导出留档）
        const scheduleEntry = zipWriter.openNdjsonEntry('data/reviewSchedules.ndjson');
        await streamPaged(
            (cursor, take) => db.reviewSchedule.findMany({
                where: exportAll ? {} : { errorItem: { userId: currentUser.id } },
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => scheduleEntry.writeLine(row),
        );
        counts.reviewSchedules = await scheduleEntry.close();

        // 7. 随机试卷及题目
        const examEntry = zipWriter.openNdjsonEntry('data/examPapers.ndjson');
        await streamPaged(
            (cursor, take) => db.examPaper.findMany({
                where: userFilter,
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => examEntry.writeLine(row),
        );
        counts.examPapers = await examEntry.close();

        const examQEntry = zipWriter.openNdjsonEntry('data/examQuestions.ndjson');
        await streamPaged(
            (cursor, take) => db.examQuestion.findMany({
                where: exportAll ? {} : { paper: { userId: currentUser.id } },
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => examQEntry.writeLine(row),
        );
        counts.examQuestions = await examQEntry.close();

        // 8. 练习记录（拆出快照图片）
        const practiceEntry = zipWriter.openNdjsonEntry('data/practiceRecords.ndjson');
        await streamPaged(
            (cursor, take) => db.practiceRecord.findMany({
                where: userFilter,
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => {
                const imageRef = await stripMediaField(row.originalImageUrl);
                await practiceEntry.writeLine({
                    ...row,
                    originalImageUrl: imageRef,
                });
            },
            MEDIA_PAGE_SIZE,
        );
        counts.practiceRecords = await practiceEntry.close();

        // 9. 家长试卷树（拆出答案卷图和页图至 media/<sha256>）
        const ppEntry = zipWriter.openNdjsonEntry('data/parentPapers.ndjson');
        await streamPaged(
            (cursor, take) => db.parentPaper.findMany({
                where: userFilter,
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => {
                const answerKeyImages = await extractMediaFromJsonArray(row.answerKeyImages, emitMedia);
                await ppEntry.writeLine({ ...row, answerKeyImages });
            },
            MEDIA_PAGE_SIZE,
        );
        counts.parentPapers = await ppEntry.close();

        const pppEntry = zipWriter.openNdjsonEntry('data/parentPaperPages.ndjson');
        await streamPaged(
            (cursor, take) => db.parentPaperPage.findMany({
                where: exportAll ? {} : { paper: { userId: currentUser.id } },
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => {
                const imageUrl = (await stripMediaField(row.imageUrl)) ?? '';
                const originalImageUrl = await stripMediaField(row.originalImageUrl);
                await pppEntry.writeLine({ ...row, imageUrl, originalImageUrl });
            },
            MEDIA_PAGE_SIZE,
        );
        counts.parentPaperPages = await pppEntry.close();

        const ppqEntry = zipWriter.openNdjsonEntry('data/parentPaperQuestions.ndjson');
        await streamPaged(
            (cursor, take) => db.parentPaperQuestion.findMany({
                where: exportAll ? {} : { paper: { userId: currentUser.id } },
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => {
                if (row.provenanceId) referencedProvenanceIds.add(row.provenanceId);
                await ppqEntry.writeLine(row);
            },
        );
        counts.parentPaperQuestions = await ppqEntry.close();

        // 10. 教师改卷任务及结果（拆出答案卷图与答卷页面图）
        const gtEntry = zipWriter.openNdjsonEntry('data/gradingTasks.ndjson');
        await streamPaged(
            (cursor, take) => db.gradingTask.findMany({
                where: userFilter,
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => {
                const keyImageUrl = await stripMediaField(row.keyImageUrl);
                await gtEntry.writeLine({ ...row, keyImageUrl, submitTokenHash: null, allowSelfSubmit: false });
            },
            MEDIA_PAGE_SIZE,
        );
        counts.gradingTasks = await gtEntry.close();

        const gkqEntry = zipWriter.openNdjsonEntry('data/gradingKeyQuestions.ndjson');
        await streamPaged(
            (cursor, take) => db.gradingKeyQuestion.findMany({
                where: exportAll ? {} : { task: { userId: currentUser.id } },
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => gkqEntry.writeLine(row),
        );
        counts.gradingKeyQuestions = await gkqEntry.close();

        const gsEntry = zipWriter.openNdjsonEntry('data/gradingSubmissions.ndjson');
        await streamPaged(
            (cursor, take) => db.gradingSubmission.findMany({
                where: exportAll ? {} : { task: { userId: currentUser.id } },
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => {
                const images = (await extractMediaFromJsonArray(row.images, emitMedia)) ?? '[]';
                await gsEntry.writeLine({ ...row, images, shareTokenHash: null });
            },
            MEDIA_PAGE_SIZE,
        );
        counts.gradingSubmissions = await gsEntry.close();

        const grEntry = zipWriter.openNdjsonEntry('data/gradingResults.ndjson');
        await streamPaged(
            (cursor, take) => db.gradingResult.findMany({
                where: exportAll ? {} : { submission: { task: { userId: currentUser.id } } },
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => {
                if (row.provenanceId) referencedProvenanceIds.add(row.provenanceId);
                await grEntry.writeLine(row);
            },
        );
        counts.gradingResults = await grEntry.close();

        // 11. 变式流水线与阶段日志
        const vrEntry = zipWriter.openNdjsonEntry('data/variantRuns.ndjson');
        await streamPaged(
            (cursor, take) => db.variantRun.findMany({
                where: userFilter,
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => vrEntry.writeLine(row),
        );
        counts.variantRuns = await vrEntry.close();

        const viEntry = zipWriter.openNdjsonEntry('data/variantItems.ndjson');
        await streamPaged(
            (cursor, take) => db.variantItem.findMany({
                where: exportAll ? {} : { run: { userId: currentUser.id } },
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => {
                if (row.provenanceId) referencedProvenanceIds.add(row.provenanceId);
                await viEntry.writeLine(row);
            },
        );
        counts.variantItems = await viEntry.close();

        const vsEntry = zipWriter.openNdjsonEntry('data/variantStageLogs.ndjson');
        await streamPaged(
            (cursor, take) => db.variantStageLog.findMany({
                where: exportAll ? {} : { run: { userId: currentUser.id } },
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => vsEntry.writeLine(row),
        );
        counts.variantStageLogs = await vsEntry.close();

        // 12. AI 溯源记录（须在所有引用 provenanceId 的表扫描完后写入）
        const provEntry = zipWriter.openNdjsonEntry('data/aiProvenances.ndjson');
        const provIds = [...referencedProvenanceIds];
        if (exportAll) {
            await streamPaged(
                (cursor, take) => db.aiProvenance.findMany({
                    orderBy: { id: 'asc' },
                    take,
                    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                }),
                async (row) => provEntry.writeLine(row),
            );
        } else if (provIds.length > 0) {
            for (let i = 0; i < provIds.length; i += PAGE_SIZE) {
                const rows = await db.aiProvenance.findMany({
                    where: { id: { in: provIds.slice(i, i + PAGE_SIZE) } },
                    orderBy: { id: 'asc' },
                });
                for (const row of rows) await provEntry.writeLine(row);
            }
        }
        counts.aiProvenances = await provEntry.close();

        // 13. 可重算的派生学习状态（单独计入 derivedCounts，导入时可恢复或按需重算）
        const kmEntry = zipWriter.openNdjsonEntry('data/knowledgeMasteries.ndjson');
        await streamPaged(
            (cursor, take) => db.knowledgeMastery.findMany({
                where: userFilter,
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => kmEntry.writeLine(row),
        );
        derivedCounts.knowledgeMasteries = await kmEntry.close();

        const lpEntry = zipWriter.openNdjsonEntry('data/learningPaths.ndjson');
        await streamPaged(
            (cursor, take) => db.learningPath.findMany({
                where: userFilter,
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => lpEntry.writeLine(row),
        );
        derivedCounts.learningPaths = await lpEntry.close();

        const lpsEntry = zipWriter.openNdjsonEntry('data/learningPathSteps.ndjson');
        await streamPaged(
            (cursor, take) => db.learningPathStep.findMany({
                where: exportAll ? {} : { path: { userId: currentUser.id } },
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => lpsEntry.writeLine(row),
        );
        derivedCounts.learningPathSteps = await lpsEntry.close();

        const imEntry = zipWriter.openNdjsonEntry('data/itemMemories.ndjson');
        await streamPaged(
            (cursor, take) => db.itemMemory.findMany({
                where: userFilter,
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => imEntry.writeLine(row),
        );
        derivedCounts.itemMemories = await imEntry.close();

        // 13b. 家长每日全科作业待办项
        const dhEntry = zipWriter.openNdjsonEntry('data/dailyHomeworkItems.ndjson');
        await streamPaged(
            (cursor, take) => db.dailyHomeworkItem.findMany({
                where: userFilter,
                orderBy: { id: 'asc' },
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            async (row) => dhEntry.writeLine(row),
        );
        counts.dailyHomeworkItems = await dhEntry.close();

        // 14. 动画云端语音缓存（MP3 单独写入 tts/<id>.mp3）
        const speeches = await exportSpeeches(narrationSources);
        const ttsEntry = zipWriter.openNdjsonEntry('data/ttsSpeeches.ndjson');
        for (const speech of speeches) {
            const { audio, ...meta } = speech;
            const id = speechId(meta);
            await zipWriter.writeBinaryEntry(`tts/${id}.mp3`, Buffer.from(audio, 'base64'), { compress: false });
            await ttsEntry.writeLine({ id, ...meta });
        }
        counts.ttsSpeeches = await ttsEntry.close();
        counts.mediaFiles = seenMediaHashes.size;

        if (!options.encryption) {
            warnings.push('BACKUP_UNENCRYPTED');
        }

        const cfgAppVersion = options.appVersion
            || process.env.APP_VERSION
            || (getAppConfig() as { version?: string }).version
            || '3';

        const manifest: BackupManifestV3 = {
            formatVersion: 3,
            appVersion: String(cfgAppVersion),
            exportedAt: new Date().toISOString(),
            scope: exportAll ? 'all' : 'user',
            user: currentUser,
            counts,
            derivedCounts,
            files: zipWriter.getRecordedFiles(),
            warnings,
            ...(options.encryption ? { encryption: options.encryption } : {}),
        };

        await zipWriter.writeBinaryEntry(
            'manifest.json',
            Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
            { compress: true, recordDigest: false, rawManifest: true },
        );
        zipWriter.finish();
    }
}
