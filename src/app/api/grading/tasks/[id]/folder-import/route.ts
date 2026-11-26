import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, conflict, notFound } from "@/lib/api-errors";
import { aiQuotaRefs, reserveAiQuota } from "@/lib/ai-quota";
import { CrossTenantOperationError, IdempotencyConflictError, runIdempotentOperation } from "@/lib/async-operations";
import { FOLDER_IMPORT_MAX_BODY_BYTES, identitySchema, imageDataUrlSchema, languageSchema, MAX_PAGES_PER_PAPER } from "@/lib/grading-api";
import { loadTaskRoster, resolveMatch, scheduleGrading, takenStudentIds } from "@/lib/grading-service";
import { prisma } from "@/lib/prisma";
import { defineApiRoute } from "@/lib/server/api-route";
import { ImageValidationError, normalizeImageDataUrl } from "@/lib/server/image-normalize";
import { hasIdentity } from "@/lib/student-match";

const bodySchema = z.object({
    /** 客户端按「任务 + 原文件路径/大小/修改时间」算出的 SHA-256，重试或重复导入同一份时不变 */
    importKey: z.string().regex(/^[a-f0-9]{64}$/),
    images: z.array(imageDataUrlSchema).min(1).max(MAX_PAGES_PER_PAPER),
    /** 老师在预览里手动选的学生 */
    studentId: z.string().min(1).max(100).nullish(),
    /** 从文件夹名/文件名解析出的身份，服务端重新匹配，不直接采信客户端的匹配结果 */
    identity: identitySchema.nullish(),
    language: languageSchema,
});

interface FolderImportResult {
    id: string;
    studentId: string | null;
    matchStatus: string | null;
}

class QuotaExceeded extends Error {
    constructor(readonly response: Response) {
        super("AI quota exceeded");
    }
}

class InvalidImage extends Error {}

/**
 * POST /api/grading/tasks/:id/folder-import：文件夹导入的单份答卷（每次一份，客户端排队并发）。
 * 同一 importKey 重试只会创建一份答卷；失败的份可以单独重试。判分沿用收卷的后台异步流程。
 */
export const POST = defineApiRoute(
    { auth: "user", maxBodyBytes: FOLDER_IMPORT_MAX_BODY_BYTES, bodySchema },
    async (req, { user, params, body }) => {
        const { id } = await (params as Promise<{ id: string }>);
        const task = await prisma.gradingTask.findFirst({
            where: { id, userId: user.id },
            include: { _count: { select: { questions: true } } },
        });
        if (!task) return notFound("Grading task not found");
        if (task._count.questions === 0 && task.taskMode !== "quick") return badRequest("Answer key is empty");

        const roster = await loadTaskRoster(task);
        if (body.studentId && !roster.some((student) => student.id === body.studentId)) {
            // 不在本任务班级名册里（含其他老师的学生）一律按不存在处理，不泄露是否存在
            return notFound("Student not found");
        }

        // 幂等载荷只含任务与图片摘要：重试时老师改了学生也复用已建的答卷，避免 409 或重复建卷
        const payload = {
            taskId: id,
            images: body.images.map((image) => crypto.createHash("sha256").update(image).digest("hex")),
        };

        try {
            const { reused, result } = await runIdempotentOperation<FolderImportResult>(
                { db: prisma, userId: user.id, kind: "grading-folder-import", idempotencyKey: `${id}:${body.importKey}`, payload },
                async () => {
                    let images: string[];
                    try {
                        images = await Promise.all(body.images.map(async (image) => (await normalizeImageDataUrl(image)).dataUrl));
                    } catch (error) {
                        if (error instanceof ImageValidationError) throw new InvalidImage();
                        throw error;
                    }
                    const quota = await reserveAiQuota(user, "grade", { request: req });
                    if (quota.limited) throw new QuotaExceeded(quota.limited);

                    const identityData = body.studentId
                        ? { studentId: body.studentId, matchStatus: "manual", matchReason: JSON.stringify({ code: "manual" }) }
                        : body.identity && hasIdentity(body.identity)
                            ? resolveMatch(body.identity, roster, await takenStudentIds(id))
                            : {};
                    let submission: { id: string; studentId: string | null; matchStatus: string | null };
                    try {
                        submission = await prisma.gradingSubmission.create({
                            data: { taskId: id, images: JSON.stringify(images), ...identityData },
                            select: { id: true, studentId: true, matchStatus: true },
                        });
                    } catch (error) {
                        await quota.release();
                        throw error;
                    }
                    await quota.attach(aiQuotaRefs.gradingSubmission(submission.id));
                    scheduleGrading([submission.id], body.language);
                    return { id: submission.id, studentId: submission.studentId ?? null, matchStatus: submission.matchStatus ?? null };
                },
            );
            return NextResponse.json({ ...result, reused }, { status: reused ? 200 : 202 });
        } catch (error) {
            if (error instanceof QuotaExceeded) return error.response;
            if (error instanceof InvalidImage) return badRequest("INVALID_IMAGE");
            if (error instanceof IdempotencyConflictError) return conflict("Import key reused with different pages");
            if (error instanceof CrossTenantOperationError) return notFound("Grading task not found");
            throw error;
        }
    },
);
