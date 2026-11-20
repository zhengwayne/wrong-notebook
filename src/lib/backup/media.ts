import crypto from 'node:crypto';

export const MEDIA_REF_PREFIX = 'media://';

const DATA_URL_RE = /^data:([^;,]+);base64,([a-zA-Z0-9+/=\s]+)$/i;

export interface ExtractedMedia {
    ref: string;
    hash: string;
    mime: string;
    buffer: Buffer;
}

/** 将 data:<mime>;base64,... 拆解为稳定媒体引用与原始二进制 Buffer */
export function extractMediaDataUrl(value: string | null | undefined): ExtractedMedia | null {
    if (!value || !value.startsWith('data:')) return null;
    const match = DATA_URL_RE.exec(value);
    if (!match) return null;
    const mime = match[1].trim().toLowerCase();
    const cleanedBase64 = match[2].replace(/\s+/g, '');
    const buffer = Buffer.from(cleanedBase64, 'base64');
    if (buffer.length === 0) return null;
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const ref = `${MEDIA_REF_PREFIX}${hash}?mime=${encodeURIComponent(mime)}`;
    return { ref, hash, mime, buffer };
}

/** 解析形如 media://<sha256>?mime=image%2Fpng 的媒体引用 */
export function parseMediaRef(ref: string): { hash: string; mime: string } | null {
    if (!ref.startsWith(MEDIA_REF_PREFIX)) return null;
    const rest = ref.slice(MEDIA_REF_PREFIX.length);
    const [hash, query] = rest.split('?', 2);
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    const params = new URLSearchParams(query || '');
    const mime = params.get('mime')?.trim() || 'image/png';
    return { hash, mime };
}

/** 还原单个媒体字段：遇到 media:// 引用时读取文件、校验 SHA-256 并重新拼装 data URL */
export async function restoreMediaValue(
    value: string | null | undefined,
    loadMedia: (hash: string) => Promise<Buffer>,
): Promise<string> {
    if (!value) return '';
    const parsed = parseMediaRef(value);
    if (!parsed) return value;
    const buf = await loadMedia(parsed.hash);
    const actualHash = crypto.createHash('sha256').update(buf).digest('hex');
    if (actualHash !== parsed.hash) {
        throw new Error(`BACKUP_MEDIA_CORRUPTED:${parsed.hash}`);
    }
    return `data:${parsed.mime};base64,${buf.toString('base64')}`;
}

/** 对存有 JSON URL 数组的字段逐项拆出媒体 */
export function extractMediaFromJsonArray(
    raw: string | null | undefined,
    emitMedia: (media: ExtractedMedia) => Promise<void>,
): Promise<string | null> {
    return (async () => {
        if (!raw) return null;
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return raw;
        }
        if (!Array.isArray(parsed)) return raw;
        const out: unknown[] = [];
        for (const item of parsed) {
            if (typeof item === 'string') {
                const extracted = extractMediaDataUrl(item);
                if (extracted) {
                    await emitMedia(extracted);
                    out.push(extracted.ref);
                    continue;
                }
            }
            out.push(item);
        }
        return JSON.stringify(out);
    })();
}

/** 对存有 media:// JSON 数组的字段逐项还原回 data URL */
export async function restoreMediaInJsonArray(
    raw: string | null | undefined,
    loadMedia: (hash: string) => Promise<Buffer>,
): Promise<string | null> {
    if (!raw) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return raw;
    }
    if (!Array.isArray(parsed)) return raw;
    const out: unknown[] = [];
    for (const item of parsed) {
        if (typeof item === 'string' && item.startsWith(MEDIA_REF_PREFIX)) {
            out.push(await restoreMediaValue(item, loadMedia));
        } else {
            out.push(item);
        }
    }
    return JSON.stringify(out);
}
