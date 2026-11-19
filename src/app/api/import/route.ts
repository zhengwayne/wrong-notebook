import { NextResponse } from "next/server";
import { internalError, badRequest, forbidden } from "@/lib/api-errors";
import { backupUploadLimitBytes } from "@/lib/backup/archive-read";
import { BackupError } from "@/lib/backup/errors";
import { importLegacyJsonBackup, type LegacyImportData } from "@/lib/backup/import-json-legacy";
import { importBackupV3 } from "@/lib/backup/import-v3";
import { startBackgroundTask, type BackgroundTaskHandle } from "@/lib/background-tasks";
import { createLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { defineApiRoute } from "@/lib/server/api-route";

const logger = createLogger('api:import');

/** 表单上传除文件外还有分隔符与口令字段，留 1 MiB 余量 */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

function backupTooLarge(limit: number): BackupError {
    return new BackupError('BACKUP_TOO_LARGE', `Backup upload exceeds ${limit} bytes limit`, 413);
}

/** 按 Content-Length 提前拒绝超限上传，避免先把整个请求体读进内存或临时盘 */
function assertDeclaredSize(req: Request, limit: number): void {
    const declared = Number(req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) throw backupTooLarge(limit);
}

/** 对没有或伪造 Content-Length 的请求边读边计数，超限立即中断读取 */
function withBodyLimit(req: Request, limit: number): { request: Request; exceeded: () => boolean } {
    let received = 0;
    let over = false;
    if (!req.body) return { request: req, exceeded: () => false };
    const counted = req.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            received += chunk.byteLength;
            if (received > limit) {
                over = true;
                controller.error(backupTooLarge(limit));
                return;
            }
            controller.enqueue(chunk);
        },
    }));
    const request = new Request(req.url, {
        method: req.method,
        headers: req.headers,
        body: counted,
        duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    return { request, exceeded: () => over };
}

function isZipMagic(bytes: Uint8Array): boolean {
    return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export const POST = defineApiRoute({ auth: 'user' }, async (req, { user }) => {
    const { searchParams } = new URL(req.url);
    const importAll = searchParams.get('all') === 'true';

    // 只有管理员可以导入全部数据
    if (importAll && user.role !== 'admin') {
        return forbidden("Admin role required");
    }

    let task: BackgroundTaskHandle | null = null;
    try {
        const contentType = (req.headers.get('content-type') || '').toLowerCase();
        const headerPassphrase = req.headers.get('x-backup-passphrase');
        let passphrase = typeof headerPassphrase === 'string' && headerPassphrase.length > 0
            ? headerPassphrase
            : undefined;
        task = startBackgroundTask({ userId: user.id, kind: 'data_import' });

        if (contentType.includes('multipart/form-data')) {
            const multipartLimit = backupUploadLimitBytes() + MULTIPART_OVERHEAD_BYTES;
            assertDeclaredSize(req, multipartLimit);
            const limited = withBodyLimit(req, multipartLimit);
            let formData: FormData;
            try {
                formData = await limited.request.formData();
            } catch (error) {
                if (limited.exceeded()) throw backupTooLarge(multipartLimit);
                throw error;
            }
            const file = formData.get('file');
            const rawPassphrase = formData.get('passphrase');
            if (typeof rawPassphrase === 'string' && rawPassphrase.length > 0) {
                passphrase = rawPassphrase;
            }
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
                    passphrase,
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
            // 请求体在 archive-read 中边写临时文件边计数；这里先按声明长度快速拒绝
            assertDeclaredSize(req, backupUploadLimitBytes());
            const source = req.body ?? new Uint8Array(await req.arrayBuffer());
            const { stats, warnings } = await importBackupV3({
                db: prisma,
                source,
                currentUser: { id: user.id, email: user.email },
                importAll,
                passphrase,
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
                passphrase,
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
});
