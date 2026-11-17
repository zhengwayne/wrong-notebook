/** 判断文件是否为 HEIC/HEIF，便于走解码或给出明确提示 */
const HEIC_TYPES = new Set([
    "image/heic",
    "image/heif",
    "image/heic-sequence",
    "image/heif-sequence",
]);

export const HEIC_UNSUPPORTED = "HEIC_UNSUPPORTED";

export function isHeicFile(file: { type?: string; name?: string }): boolean {
    const type = (file.type || "").toLowerCase();
    if (HEIC_TYPES.has(type)) return true;
    return /\.(heic|heif)$/i.test(file.name || "");
}

export function heicUnsupportedError(): Error {
    const error = new Error(HEIC_UNSUPPORTED);
    error.name = HEIC_UNSUPPORTED;
    return error;
}
