import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { badRequest, forbidden, internalError, unauthorized } from "@/lib/api-errors";
import { authOptions } from "@/lib/auth";
import { prepareBackupEncryption } from "@/lib/backup/crypto";
import { createBackupV3Stream } from "@/lib/backup/export-v3";
import { getAppTimeZone } from "@/lib/config";
import { formatDateTime } from "@/lib/date-time";
import { createLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { exportSpeeches } from "@/lib/tts/speech-cache";

const logger = createLogger('api:export');

interface ExportParams {
    exportAll: boolean;
    format: 'zip' | 'json';
    passphrase?: string;
}

async function executeExport({ exportAll, format, passphrase }: ExportParams) {
    const session = await getServerSession(authOptions);

    if (!session?.user?.email) {
        return unauthorized("Not authenticated");
    }

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
    });

    if (!user) {
        return unauthorized("User not found");
    }

    // 只有管理员可以导出全部数据
    if (exportAll && session.user.role !== 'admin') {
        return forbidden("Admin role required");
    }

    if (passphrase && format === 'json') {
        return badRequest("Passphrase encryption requires v3 ZIP format");
    }

    const userProfile = {
        id: user.id,
        email: user.email,
        name: user.name,
        educationStage: user.educationStage,
        enrollmentYear: user.enrollmentYear,
        gradeRecognitionMode: user.gradeRecognitionMode,
        fixedGradeSemester: user.fixedGradeSemester,
        role: user.role,
        confirmBeforeImport: user.confirmBeforeImport,
        questionDuplicateThreshold: user.questionDuplicateThreshold,
        masteryThreshold: user.masteryThreshold,
        enableGeogebra: user.enableGeogebra,
        enableSvgAnimation: user.enableSvgAnimation,
        variantPipelineEnabled: user.variantPipelineEnabled,
        themePreference: user.themePreference,
    };

    try {
        const dateTag = formatDateTime(new Date(), 'yyyy-MM-dd', getAppTimeZone());

        if (format === 'zip') {
            const filename = exportAll
                ? `XueJi-backup-all-${dateTag}.zip`
                : `XueJi-backup-${dateTag}.zip`;
            const encrypted = passphrase ? prepareBackupEncryption(passphrase) : null;
            const stream = createBackupV3Stream({
                db: prisma,
                currentUser: userProfile,
                exportAll,
                ...(encrypted ? { encryption: encrypted.meta, transformEntry: encrypted.transformEntry } : {}),
            });
            logger.info({
                userId: user.id,
                scope: exportAll ? 'all' : 'user',
                format: 'zip-v3',
                encrypted: Boolean(encrypted),
            }, 'Streaming ZIP v3 export started');
            return new NextResponse(stream, {
                headers: {
                    'Content-Type': 'application/zip',
                    'Content-Disposition': `attachment; filename="${filename}"`,
                    'X-Backup-Format-Version': '3',
                    'X-Backup-Encrypted': encrypted ? '1' : '0',
                    ...(encrypted ? {} : { 'X-Backup-Unencrypted-Warning': '1' }),
                },
            });
        }

        // 向后兼容：显式 ?format=json 时保留 v2 JSON 导出格式
        const userFilter = exportAll ? {} : { userId: user.id };
        const subjects = await prisma.subject.findMany({ where: userFilter });
        const customTags = await prisma.knowledgeTag.findMany({ where: { ...userFilter, isSystem: false } });
        const errorItems = await prisma.errorItem.findMany({ where: userFilter, include: { tags: true } });
        const reviewSchedules = await prisma.reviewSchedule.findMany({
            where: exportAll ? { errorItem: { userId: { not: undefined } } } : { errorItem: { userId: user.id } },
        });
        const practiceRecords = await prisma.practiceRecord.findMany({ where: userFilter });
        const examPapers = await prisma.examPaper.findMany({
            where: userFilter,
            include: { questions: { orderBy: { order: 'asc' } } },
        });
        const variantRuns = await prisma.variantRun.findMany({
            where: exportAll ? {} : { userId: user.id },
            include: { items: { orderBy: { index: 'asc' } }, stages: { orderBy: { createdAt: 'asc' } } },
            orderBy: { startedAt: 'asc' },
        });
        const referencedProvenanceIds = [...new Set([
            ...errorItems.map((item) => item.provenanceId),
            ...variantRuns.flatMap((run) => run.items.map((item) => item.provenanceId)),
        ].filter((id): id is string => Boolean(id)))];
        const aiProvenances = exportAll
            ? await prisma.aiProvenance.findMany({ orderBy: { createdAt: 'asc' } })
            : (referencedProvenanceIds.length > 0
                ? await prisma.aiProvenance.findMany({ where: { id: { in: referencedProvenanceIds } } })
                : []);
        const ttsSpeeches = await exportSpeeches(errorItems.flatMap((item) => [
            ...(item.svgAnimation ? [{ language: 'zh' as const, svg: item.svgAnimation }] : []),
            ...(item.svgAnimationEn ? [{ language: 'en' as const, svg: item.svgAnimationEn }] : []),
        ]));

        const exportData = {
            version: 2,
            exportedAt: new Date().toISOString(),
            scope: exportAll ? 'all' : 'user',
            user: userProfile,
            subjects,
            customTags,
            errorItems,
            reviewSchedules,
            practiceRecords,
            examPapers,
            variantRuns,
            aiProvenances,
            ttsSpeeches,
        };

        const filename = exportAll ? `XueJi-export-all-${dateTag}.json` : `XueJi-export-${dateTag}.json`;
        return new NextResponse(JSON.stringify(exportData, null, 2), {
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Disposition': `attachment; filename="${filename}"`,
            },
        });
    } catch (error) {
        logger.error({ error, userId: user.id }, 'Export failed');
        return internalError("Failed to export data");
    }
}

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    return executeExport({
        exportAll: searchParams.get('all') === 'true',
        format: searchParams.get('format') === 'json' ? 'json' : 'zip',
    });
}

export async function POST(req: Request) {
    let body: { all?: unknown; format?: unknown; passphrase?: unknown };
    try {
        body = (await req.json()) as { all?: unknown; format?: unknown; passphrase?: unknown };
    } catch {
        return badRequest("Invalid JSON format");
    }
    const passphrase = typeof body?.passphrase === 'string' && body.passphrase.length > 0
        ? body.passphrase
        : undefined;
    return executeExport({
        exportAll: body?.all === true,
        format: body?.format === 'json' ? 'json' : 'zip',
        passphrase,
    });
}
