import { NextResponse } from "next/server";
import { getAIService } from "@/lib/ai";
import { badRequest, createErrorResponse, ErrorCode } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { describeQuestion, trackBackgroundTask } from "@/lib/background-tasks";
import { prisma } from "@/lib/prisma";
import { getNotebookCandidateTags } from "@/lib/ai/tag-service";
import { resolveNotebookScope } from "@/lib/notebook-scope";
import type { CandidateTags } from "@/lib/ai";
import { consumeAiQuota } from "@/lib/ai-quota";
import { withRecoverableResponse } from "@/lib/recoverable-response";
import { getFixedQuestionGrade, resolveQuestionGrade } from "@/lib/question-grade";
import { getAppTimeZone } from "@/lib/config";
import { ImageValidationError, normalizeImageInput } from "@/lib/server/image-normalize";
import { defineApiRoute, type AuthenticatedRouteContext } from "@/lib/server/api-route";

const logger = createLogger('api:reanswer');

async function handlePost(req: Request, { user }: AuthenticatedRouteContext) {
    logger.info('Reanswer API called');

    try {
        const body = await req.json();
        const { questionText, language = 'zh', subject, imageBase64, gradeSemester, subjectId, forImport } = body;

        logger.debug({
            questionLength: questionText?.length,
            language,
            subject,
            hasImage: !!imageBase64,
            gradeSemester
        }, 'Reanswer request received');

        if (!questionText || questionText.trim().length === 0) {
            logger.warn('Missing question text');
            return badRequest("Missing question text");
        }

        let cleanImageBase64 = imageBase64;
        if (typeof imageBase64 === 'string' && imageBase64.trim()) {
            try {
                cleanImageBase64 = (await normalizeImageInput(imageBase64)).dataUrl;
            } catch (imgError) {
                if (imgError instanceof ImageValidationError) {
                    logger.warn({ code: imgError.code }, 'Invalid image payload for reanswer');
                    return badRequest("INVALID_IMAGE");
                }
                throw imgError;
            }
        }

        // 指定了错题本时，知识点只能从该错题本学段 + 学科下的全部标签中选择
        let candidateTags: CandidateTags | undefined;
        if (typeof subjectId === 'string' && subjectId) {
            const notebook = await prisma.subject.findFirst({
                where: { id: subjectId, userId: user.id },
                select: { name: true, stage: true, subjectKey: true },
            });
            if (notebook) {
                candidateTags = await getNotebookCandidateTags(resolveNotebookScope(notebook));
            }
        }

        const limited = await consumeAiQuota(user, 'reanswer');
        if (limited) return limited;

        const aiService = getAIService(cleanImageBase64 ? 'vision' : 'text');
        // 新录入的文字题遵循账户规则，已有题目的重新解题沿用其手工年级。
        const gradeProfile = forImport === true ? user : null;
        const targetGrade = gradeSemester ?? (gradeProfile ? getFixedQuestionGrade(gradeProfile, getAppTimeZone()) : undefined);

        // 根据是否有图片选择不同的重新解题方式
        const result = await trackBackgroundTask(
            { userId: user.id, kind: 'reanswer', subject: describeQuestion({ questionText }) },
            () => aiService.reanswerQuestion(questionText, language, subject, cleanImageBase64, targetGrade, candidateTags)
        );

        logger.info('Reanswer successful');

        return NextResponse.json(gradeProfile ? {
            ...result,
            gradeSemester: resolveQuestionGrade(gradeProfile, { gradeSemester, recognizedGradeSemester: result.gradeSemester }, getAppTimeZone()),
        } : result);
    } catch (error: unknown) {
        const errorMessageFromError = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        logger.error({ error: errorMessageFromError, stack }, 'Reanswer error occurred');

        let errorMessage = errorMessageFromError || "Failed to reanswer question";

        if (errorMessageFromError.includes('AI_AUTH_ERROR')) {
            errorMessage = 'AI_AUTH_ERROR';
        } else if (errorMessageFromError === 'AI_CONNECTION_FAILED') {
            errorMessage = 'AI_CONNECTION_FAILED';
        } else if (errorMessageFromError === 'AI_RESPONSE_ERROR') {
            errorMessage = 'AI_RESPONSE_ERROR';
        }

        return createErrorResponse(errorMessage, 500, ErrorCode.AI_ERROR);
    }
}

/** 耗时 AI 请求：浏览器中断连接后，前端可通过 /api/requests/:id 取回响应 */
export const POST = defineApiRoute({ auth: 'user' }, withRecoverableResponse(handlePost));
