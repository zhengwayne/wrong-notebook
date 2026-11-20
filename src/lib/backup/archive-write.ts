import crypto from 'node:crypto';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import type { BackupEntryDigest, EntryTransform } from '@/lib/backup/types';

/**
 * 基于 fflate.Zip 的流式归档写入器：
 * - 将压缩块直接推送到 Web ReadableStream，并受下游客体背压暂停（避免大备份在内存中堆积）
 * - 自动记录每个写入条目的实际字节数与 SHA-256 摘要，供结尾写入 manifest.json
 */
export class StreamingZipWriter {
    private readonly controller: ReadableStreamDefaultController<Uint8Array>;
    private readonly zip: Zip;
    private readonly files: Record<string, BackupEntryDigest> = {};
    private readonly transformEntry?: EntryTransform;
    private pullResolver: (() => void) | null = null;
    private zipError: Error | null = null;

    constructor(
        controller: ReadableStreamDefaultController<Uint8Array>,
        options: { transformEntry?: EntryTransform } = {},
    ) {
        this.controller = controller;
        this.transformEntry = options.transformEntry;
        this.zip = new Zip((err, data, final) => {
            if (err) {
                this.zipError = err instanceof Error ? err : new Error(String(err));
                controller.error(this.zipError);
                this.wakePuller();
                return;
            }
            if (data && data.length > 0) {
                controller.enqueue(data);
            }
            if (final) {
                controller.close();
                this.wakePuller();
            }
        });
    }

    onPull(): void {
        if ((this.controller.desiredSize ?? 1) > 0) {
            this.wakePuller();
        }
    }

    private wakePuller(): void {
        if (this.pullResolver) {
            const resolve = this.pullResolver;
            this.pullResolver = null;
            resolve();
        }
    }

    private async waitBackpressure(): Promise<void> {
        if (this.zipError) throw this.zipError;
        if ((this.controller.desiredSize ?? 1) <= 0) {
            await new Promise<void>((resolve) => {
                this.pullResolver = resolve;
                // 若下游已在同步链路上取走块而未重新触发 pull，定时唤醒兜底
                setTimeout(() => this.wakePuller(), 200);
            });
        }
    }

    /** 写入一个不可分割条目的字节并记录校验摘要（如已压缩的图片、加密密文或 manifest.json） */
    async writeBinaryEntry(
        name: string,
        rawBytes: Uint8Array,
        options: { compress?: boolean; recordDigest?: boolean; rawManifest?: boolean } = {},
    ): Promise<void> {
        const bytes = options.rawManifest || !this.transformEntry
            ? rawBytes
            : this.transformEntry(name, rawBytes);
        if (options.recordDigest !== false) {
            this.files[name] = {
                size: bytes.byteLength,
                sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            };
        }
        const stream = options.compress
            ? new ZipDeflate(name, { level: 6 })
            : new ZipPassThrough(name);
        this.zip.add(stream);
        stream.push(bytes, true);
        await this.waitBackpressure();
    }

    /** 打开一个流式 NDJSON 条目，按分页逐块写入后关闭并记录摘要 */
    openNdjsonEntry(name: string): {
        writeLine: (record: unknown) => Promise<void>;
        close: () => Promise<number>;
    } {
        if (this.transformEntry) {
            // 启用条目整体加密时分片收集当前单个 NDJSON 的较小页文本或分块（通过压缩流写入并加密），
            // 为兼顾低内存与 AES-GCM 单条目认证，单条目最大只含同表数据；若表较大，仍按 chunk 写入
            const chunks: Buffer[] = [];
            let count = 0;
            return {
                writeLine: async (record: unknown) => {
                    const buf = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
                    chunks.push(buf);
                    count++;
                },
                close: async () => {
                    const plain = Buffer.concat(chunks);
                    chunks.length = 0;
                    await this.writeBinaryEntry(name, plain, { compress: false, recordDigest: true });
                    return count;
                },
            };
        }

        const hash = crypto.createHash('sha256');
        let totalBytes = 0;
        let count = 0;
        const stream = new ZipDeflate(name, { level: 6 });
        this.zip.add(stream);

        return {
            writeLine: async (record: unknown) => {
                const buf = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
                hash.update(buf);
                totalBytes += buf.byteLength;
                count++;
                stream.push(buf, false);
                await this.waitBackpressure();
            },
            close: async () => {
                stream.push(new Uint8Array(0), true);
                this.files[name] = {
                    size: totalBytes,
                    sha256: hash.digest('hex'),
                };
                await this.waitBackpressure();
                return count;
            },
        };
    }

    getRecordedFiles(): Record<string, BackupEntryDigest> {
        return { ...this.files };
    }

    finish(): void {
        this.zip.end();
    }

    abort(error: unknown): void {
        this.zipError = error instanceof Error ? error : new Error(String(error));
        this.zip.terminate();
        try {
            this.controller.error(this.zipError);
        } catch {
            // 流已被消费端 cancel 或 close 时忽略重复错误通知
        }
        this.wakePuller();
    }
}
