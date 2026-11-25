import { createErrorResponse, ErrorCode, payloadTooLarge } from "@/lib/api-errors";
import { withRecoverableResponse } from "@/lib/recoverable-response";
import { analyzeImageForUser } from "@/lib/server/analyze-image";
import { defineApiRoute, PayloadTooLargeError, readBytesWithinLimit, type AuthenticatedRouteContext } from "@/lib/server/api-route";
import { MP_UPLOAD_MAX_BODY_BYTES, MP_UPLOAD_MAX_FILE_BYTES } from "@/lib/server/mp-auth";

function badUpload(message: string) {
    return createErrorResponse(message, 400, ErrorCode.BAD_REQUEST);
}

/**
 * POST /api/mp/analyze（multipart/form-data，wx.uploadFile 上传）：
 * 字段 file 为题目照片，可选 subjectId / language。识别逻辑与 /api/analyze 完全相同，
 * 额外返回规范化（转正、去 EXIF、限边）后的 imageDataUrl，供保存错题时作为原图。
 */
async function handlePost(req: Request, { user }: AuthenticatedRouteContext) {
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
        return badUpload("MULTIPART_REQUIRED");
    }
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MP_UPLOAD_MAX_BODY_BYTES) return payloadTooLarge();

    let form: FormData;
    try {
        const bytes = await readBytesWithinLimit(req, MP_UPLOAD_MAX_BODY_BYTES);
        form = await new Response(new Uint8Array(bytes), { headers: { "content-type": contentType } }).formData();
    } catch (error) {
        if (error instanceof PayloadTooLargeError) return payloadTooLarge();
        return badUpload("INVALID_MULTIPART");
    }

    const file = form.get("file");
    if (!file || typeof file === "string") return badUpload("Missing image data");
    if (file.size === 0) return badUpload("Missing image data");
    if (file.size > MP_UPLOAD_MAX_FILE_BYTES) return payloadTooLarge();

    const imageBase64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    const subjectId = form.get("subjectId");
    const language = form.get("language");
    return analyzeImageForUser(user, {
        imageBase64,
        mimeType: file.type || undefined,
        subjectId: typeof subjectId === "string" ? subjectId : undefined,
        language: typeof language === "string" ? language : undefined,
    }, { includeImageDataUrl: true });
}

export const POST = defineApiRoute({ auth: "user" }, withRecoverableResponse(handlePost));
