import { createErrorResponse, ErrorCode, payloadTooLarge } from "@/lib/api-errors";
import { withRecoverableResponse } from "@/lib/recoverable-response";
import { analyzeImageForUser, MAX_ANALYZE_IMAGES } from "@/lib/server/analyze-image";
import { defineApiRoute, PayloadTooLargeError, readBytesWithinLimit, type AuthenticatedRouteContext } from "@/lib/server/api-route";
import { MP_UPLOAD_MAX_BODY_BYTES, MP_UPLOAD_MAX_FILE_BYTES } from "@/lib/server/mp-auth";

function badUpload(message: string) {
    return createErrorResponse(message, 400, ErrorCode.BAD_REQUEST);
}

interface AnalyzeUpload {
    images: string[];
    mimeType?: string;
    subjectId?: string;
    language?: string;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value ? value : undefined;
}

/** multipart：字段 file（可重复，按顺序为同一道题的几页），wx.uploadFile 只能带一张 */
async function readMultipart(bytes: Uint8Array, contentType: string): Promise<AnalyzeUpload | Response> {
    let form: FormData;
    try {
        form = await new Response(new Uint8Array(bytes), { headers: { "content-type": contentType } }).formData();
    } catch {
        return badUpload("INVALID_MULTIPART");
    }
    const files = form.getAll("file");
    if (files.length === 0) return badUpload("Missing image data");
    if (files.length > MAX_ANALYZE_IMAGES) return badUpload("TOO_MANY_IMAGES");
    const images: string[] = [];
    let mimeType: string | undefined;
    for (const file of files) {
        if (typeof file === "string" || file.size === 0) return badUpload("Missing image data");
        if (file.size > MP_UPLOAD_MAX_FILE_BYTES) return payloadTooLarge();
        mimeType ??= file.type || undefined;
        images.push(Buffer.from(await file.arrayBuffer()).toString("base64"));
    }
    return { images, mimeType, subjectId: optionalString(form.get("subjectId")), language: optionalString(form.get("language")) };
}

/** JSON：{ images: base64[] }，小程序一次发同一道跨页题的 2~3 张图时使用（wx.request） */
function readJson(bytes: Uint8Array): AnalyzeUpload | Response {
    let body: unknown;
    try {
        body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return badUpload("Invalid JSON body");
    }
    if (!body || typeof body !== "object") return badUpload("Missing image data");
    const { images, subjectId, language } = body as Record<string, unknown>;
    if (!Array.isArray(images) || images.length === 0) return badUpload("Missing image data");
    if (images.length > MAX_ANALYZE_IMAGES) return badUpload("TOO_MANY_IMAGES");
    if (images.some((image) => typeof image !== "string" || !image)) return badUpload("Missing image data");
    // base64 约为原图的 4/3
    if (images.some((image) => (image as string).length > Math.ceil(MP_UPLOAD_MAX_FILE_BYTES / 3) * 4 + 64)) return payloadTooLarge();
    return { images: images as string[], subjectId: optionalString(subjectId), language: optionalString(language) };
}

/**
 * POST /api/mp/analyze：
 * - multipart/form-data（wx.uploadFile）：字段 file 为题目照片，可重复；
 * - application/json（wx.request）：{ images: base64[], subjectId?, language? }。
 * 多张图按顺序作为同一道跨页题一起识别（最多 3 张，只计 1 次 AI 用量）。识别逻辑与 /api/analyze 相同，
 * 额外返回规范化（转正、去 EXIF、限边）后的 imageDataUrl（多张时为拼好的一张），供保存错题时作为原图。
 */
async function handlePost(req: Request, { user }: AuthenticatedRouteContext) {
    const contentType = req.headers.get("content-type") ?? "";
    const lower = contentType.toLowerCase();
    const isMultipart = lower.startsWith("multipart/form-data");
    if (!isMultipart && !lower.startsWith("application/json")) {
        return badUpload("MULTIPART_REQUIRED");
    }
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MP_UPLOAD_MAX_BODY_BYTES) return payloadTooLarge();

    let bytes: Uint8Array;
    try {
        bytes = new Uint8Array(await readBytesWithinLimit(req, MP_UPLOAD_MAX_BODY_BYTES));
    } catch (error) {
        if (error instanceof PayloadTooLargeError) return payloadTooLarge();
        return badUpload(isMultipart ? "INVALID_MULTIPART" : "Invalid JSON body");
    }

    const upload = isMultipart ? await readMultipart(bytes, contentType) : readJson(bytes);
    if (upload instanceof Response) return upload;
    const [imageBase64, ...additionalImages] = upload.images;
    return analyzeImageForUser(user, {
        imageBase64,
        additionalImages,
        mimeType: upload.mimeType,
        subjectId: upload.subjectId,
        language: upload.language,
    }, { includeImageDataUrl: true });
}

export const POST = defineApiRoute({ auth: "user" }, withRecoverableResponse(handlePost));
