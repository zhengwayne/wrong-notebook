import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { openPromise } from 'yauzl';
import { BackupError } from '@/lib/backup/errors';
import type { BackupManifestV3, EntryTransform } from '@/lib/backup/types';

export interface BackupArchiveLimits {
    maxZipBytes?: number;
    maxUncompressedBytes?: number;
    maxEntries?: number;
}

const DEFAULT_MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 50_000;

/** 备份上传体积上限；默认 2 GiB，可用 BACKUP_MAX_UPLOAD_BYTES（正整数字节）调小或调大 */
export function backupUploadLimitBytes(): number {
    const raw = Number(process.env.BACKUP_MAX_UPLOAD_BYTES);
    return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_ZIP_BYTES;
}

export interface UnpackedBackupArchive {
    manifest: BackupManifestV3;
    readNdjson: (relativePath: string, onRow: (row: Record<string, unknown>) => Promise<void>) => Promise<void>;
    readBinary: (relativePath: string) => Promise<Buffer>;
    hasEntry: (relativePath: string) => boolean;
    cleanup: () => Promise<void>;
}

function safeEntryTarget(rootDir: string, entryName: string): string | null {
    const normalized = path.posix.normalize(entryName).replace(/^\/+/, '');
    if (!normalized || normalized.startsWith('..') || normalized.includes('\0')) return null;
    const resolvedRoot = path.resolve(rootDir);
    const resolvedTarget = path.resolve(resolvedRoot, normalized);
    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
        return null;
    }
    return resolvedTarget;
}

/** 将请求体流式写入临时 ZIP 文件并按条目解压校验 SHA-256 到独立临时目录 */
export async function unpackBackupZipStream(
    source: ReadableStream<Uint8Array> | Uint8Array | Buffer,
    options: {
        decryptEntry?: (manifest: BackupManifestV3, entryName: string, packed: Uint8Array) => Uint8Array;
        resolveDecryptor?: (manifest: BackupManifestV3) => EntryTransform | undefined;
        limits?: BackupArchiveLimits;
    } = {},
): Promise<UnpackedBackupArchive> {
    const maxZipBytes = options.limits?.maxZipBytes ?? backupUploadLimitBytes();
    const maxUncompressedBytes = options.limits?.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;
    const maxEntries = options.limits?.maxEntries ?? DEFAULT_MAX_ENTRIES;

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xueji-backup-unzip-'));
    const zipFile = path.join(workDir, 'upload.zip');
    const extractDir = path.join(workDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    const cleanup = async () => {
        await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    };

    try {
        if (source instanceof Uint8Array) {
            if (source.byteLength > maxZipBytes) {
                throw new BackupError('BACKUP_TOO_LARGE', `Backup archive exceeds ${maxZipBytes} bytes limit`, 413);
            }
            await fs.promises.writeFile(zipFile, source);
        } else {
            let receivedZipBytes = 0;
            const sizeLimiter = new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                    receivedZipBytes += chunk.byteLength;
                    if (receivedZipBytes > maxZipBytes) {
                        callback(new BackupError('BACKUP_TOO_LARGE', `Backup archive exceeds ${maxZipBytes} bytes limit`, 413));
                        return;
                    }
                    callback(null, chunk);
                },
            });
            const nodeReadable = Readable.fromWeb(source as Parameters<typeof Readable.fromWeb>[0]);
            await pipeline(nodeReadable, sizeLimiter, fs.createWriteStream(zipFile));
        }

        const digests = new Map<string, { size: number; sha256: string }>();
        const entryPaths = new Set<string>();
        let totalUncompressedBytes = 0;
        // 以中央目录中的长度界定每个条目，媒体和密文中的任意字节均可原样还原。
        const zip = await openPromise(zipFile);
        try {
            if (zip.entryCount > maxEntries) {
                throw new BackupError('BACKUP_TOO_LARGE', `Backup archive exceeds ${maxEntries} entries limit`, 413);
            }
            for await (const entry of zip.eachEntry()) {
                const name = entry.fileName;
                if (name.endsWith('/')) continue;
                const target = safeEntryTarget(extractDir, name);
                if (!target) throw new Error(`INVALID_ZIP_ENTRY_PATH:${name}`);
                await fs.promises.mkdir(path.dirname(target), { recursive: true });

                const hash = crypto.createHash('sha256');
                let size = 0;
                const digest = new Transform({
                    transform(chunk: Buffer, _encoding, callback) {
                        totalUncompressedBytes += chunk.byteLength;
                        if (totalUncompressedBytes > maxUncompressedBytes) {
                            callback(new BackupError('BACKUP_TOO_LARGE', `Uncompressed backup exceeds ${maxUncompressedBytes} bytes limit`, 413));
                            return;
                        }
                        hash.update(chunk);
                        size += chunk.byteLength;
                        callback(null, chunk);
                    },
                });
                const input = await zip.openReadStreamPromise(entry);
                await pipeline(input, digest, fs.createWriteStream(target, { flags: 'wx' }));
                digests.set(name, { size, sha256: hash.digest('hex') });
                entryPaths.add(name);
            }
        } finally {
            zip.close();
        }

        const manifestPath = safeEntryTarget(extractDir, 'manifest.json');
        if (!manifestPath || !fs.existsSync(manifestPath)) {
            throw new Error('INVALID_BACKUP_MANIFEST_MISSING');
        }
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as BackupManifestV3;
        if (!manifest || manifest.formatVersion !== 3 || typeof manifest.files !== 'object' || !manifest.user?.email) {
            throw new Error('UNSUPPORTED_BACKUP_FORMAT');
        }

        // 校验每个在 manifest.files 中声明的条目大小与 SHA-256 摘要，防止传错文件或损坏篡改
        for (const [entryName, expected] of Object.entries(manifest.files)) {
            const actual = digests.get(entryName);
            if (!actual || actual.size !== expected.size || actual.sha256 !== expected.sha256) {
                throw new Error(`BACKUP_ENTRY_DIGEST_MISMATCH:${entryName}`);
            }
        }

        const resolved = options.resolveDecryptor?.(manifest);
        const maybeDecrypt: EntryTransform | undefined = resolved
            ?? (options.decryptEntry ? (entryName, bytes) => options.decryptEntry!(manifest, entryName, bytes) : undefined);

        return {
            manifest,
            hasEntry: (rel) => entryPaths.has(rel),
            readBinary: async (rel) => {
                const target = safeEntryTarget(extractDir, rel);
                if (!target || !entryPaths.has(rel)) {
                    throw new Error(`MISSING_BACKUP_ENTRY:${rel}`);
                }
                const raw = await fs.promises.readFile(target);
                if (!maybeDecrypt) return raw;
                const plain = maybeDecrypt(rel, raw);
                return Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength);
            },
            readNdjson: async (rel, onRow) => {
                const target = safeEntryTarget(extractDir, rel);
                if (!target || !entryPaths.has(rel)) return;
                if (maybeDecrypt) {
                    const encrypted = await fs.promises.readFile(target);
                    const plain = maybeDecrypt(rel, encrypted);
                    const rl = readline.createInterface({
                        input: Readable.from(Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength)),
                        crlfDelay: Infinity,
                    });
                    for await (const line of rl) {
                        const trimmed = line.trim();
                        if (!trimmed) continue;
                        await onRow(JSON.parse(trimmed) as Record<string, unknown>);
                    }
                    return;
                }
                const rl = readline.createInterface({
                    input: fs.createReadStream(target, { encoding: 'utf8', highWaterMark: 64 * 1024 }),
                    crlfDelay: Infinity,
                });
                for await (const line of rl) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    await onRow(JSON.parse(trimmed) as Record<string, unknown>);
                }
            },
            cleanup,
        };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
