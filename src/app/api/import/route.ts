import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, badRequest, forbidden } from "@/lib/api-errors";
import { authOptions } from "@/lib/auth";
import { BackupError } from "@/lib/backup/errors";
import { importLegacyJsonBackup, type LegacyImportData } from "@/lib/backup/import-json-legacy";
import { importBackupV3 } from "@/lib/backup/import-v3";
import { startBackgroundTask, type BackgroundTaskHandle } from "@/lib/background-tasks";
import { createLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const logger = createLogger('api:import');

function isZipMagic(bytes: Uint8Array): boolean {
    return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export async function POST(req: Request) {
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

    const { searchParams } = new URL(req.url);
    const importAll = searchParams.get('all') === 'true';

    // 只有管理员可以导入全部数据
    if (importAll && session.user.role !== 'admin') {
        return forbidden("Admin role required");
    }

    let task: BackgroundTaskHandle | null = null;
    try {
        const contentType = (req.headers.get('content-type') || '').toLowerCase();
        task = startBackgroundTask({ userId: user.id, kind: 'data_import' });

        if (contentType.includes('multipart/form-data')) {
            const formData = await req.formData();
            const file = formData.get('file');
            if (!(file instanceof Blob)) {
                task.fail('Missing backup file');
                return badRequest("Missing backup file");
            }
            const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
            const isZip = isZipMagic(head) || (file instanceof File && file.name.toLowerCase().endsWith('.zip'));
            if (isZip) {
                const { stats, warnings } = await importBackupV3({
                    db: prisma,
                    source: file.stream() as ReadableStream<Uint8Array>,
                    currentUser: { id: user.id, email: user.email },
                    importAll,
                });
                task.succeed();
                return NextResponse.json({ success: true, formatVersion: 3, stats, warnings });
            }
            const body = JSON.parse(await file.text()) as LegacyImportData;
            const { stats, warnings } = await importLegacyJsonBackup({
                db: prisma,
                body,
                currentUser: { id: user.id, email: user.email },
                importAll,
            });
            task.succeed();
            return NextResponse.json({ success: true, formatVersion: body.version, stats, warnings });
        }

        if (contentType.includes('application/zip') || contentType.includes('application/octet-stream')) {
            const source = req.body ?? new Uint8Array(await req.arrayBuffer());
            const { stats, warnings } = await importBackupV3({
                db: prisma,
                source,
                currentUser: { id: user.id, email: user.email },
                importAll,
            });
            task.succeed();
            return NextResponse.json({ success: true, formatVersion: 3, stats, warnings });
        }

        const contentLength = req.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > 50 * 1024 * 1024) {
            task.fail('Request body too large');
            return badRequest("Request body too large (max 50MB)");
        }

        const rawBuf = new Uint8Array(await req.arrayBuffer());
        if (isZipMagic(rawBuf)) {
            const { stats, warnings } = await importBackupV3({
                db: prisma,
                source: rawBuf,
                currentUser: { id: user.id, email: user.email },
                importAll,
            });
            task.succeed();
            return NextResponse.json({ success: true, formatVersion: 3, stats, warnings });
        }

        const body = JSON.parse(Buffer.from(rawBuf).toString('utf8')) as LegacyImportData;
        const { stats, warnings } = await importLegacyJsonBackup({
            db: prisma,
            body,
            currentUser: { id: user.id, email: user.email },
            importAll,
        });
        task.succeed();

        logger.info({ userId: user.id, scope: importAll ? 'all' : 'user', ...stats }, 'Data import completed');
        return NextResponse.json({ success: true, formatVersion: body.version, stats, warnings });
    } catch (error) {
        task?.fail(error);
        if (error instanceof BackupError) {
            return NextResponse.json({ message: error.message, code: error.code }, { status: error.status });
        }
        if (error instanceof SyntaxError) {
            return badRequest("Invalid JSON format");
        }
        logger.error({ error, userId: user.id }, 'Import failed');
        return internalError("Failed to import data");
    }
}
