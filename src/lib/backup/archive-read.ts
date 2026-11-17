import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import type { BackupManifestV3, EntryTransform } from '@/lib/backup/types';

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
    } = {},
): Promise<UnpackedBackupArchive> {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xueji-backup-unzip-'));
    const zipFile = path.join(workDir, 'upload.zip');
    const extractDir = path.join(workDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    const cleanup = async () => {
        await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    };

    try {
        if (source instanceof Uint8Array) {
            await fs.promises.writeFile(zipFile, source);
        } else {
            const nodeReadable = Readable.fromWeb(source as Parameters<typeof Readable.fromWeb>[0]);
            await pipeline(nodeReadable, fs.createWriteStream(zipFile));
        }

        const digests = new Map<string, { size: number; sha256: string }>();
        const entryPaths = new Set<string>();
        const entryWrites: Promise<void>[] = [];

        const unzip = new Unzip((file) => {
            if (file.name.endsWith('/')) return;
            const target = safeEntryTarget(extractDir, file.name);
            if (!target) {
                throw new Error(`INVALID_ZIP_ENTRY_PATH:${file.name}`);
            }
            fs.mkdirSync(path.dirname(target), { recursive: true });
            const writeStream = fs.createWriteStream(target);
            const hash = crypto.createHash('sha256');
            let size = 0;

            const done = new Promise<void>((resolve, reject) => {
                writeStream.on('error', reject);
                writeStream.on('finish', () => {
                    digests.set(file.name, { size, sha256: hash.digest('hex') });
                    entryPaths.add(file.name);
                    resolve();
                });
            });
            entryWrites.push(done);

            file.ondata = (err, data, final) => {
                if (err) {
                    writeStream.destroy(err instanceof Error ? err : new Error(String(err)));
                    return;
                }
                if (data && data.length > 0) {
                    hash.update(data);
                    size += data.byteLength;
                    writeStream.write(data);
                }
                if (final) {
                    writeStream.end();
                }
            };
            file.start();
        });
        unzip.register(UnzipPassThrough);
        unzip.register(UnzipInflate);

        await new Promise<void>((resolve, reject) => {
            const readStream = fs.createReadStream(zipFile, { highWaterMark: 256 * 1024 });
            readStream.on('data', (chunk: string | Buffer) => {
                try {
                    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
                    unzip.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), false);
                } catch (err) {
                    readStream.destroy(err instanceof Error ? err : new Error(String(err)));
                }
            });
            readStream.on('end', () => {
                try {
                    unzip.push(new Uint8Array(0), true);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
            readStream.on('error', reject);
        });

        await Promise.all(entryWrites);

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
