import { NextResponse } from "next/server";
import { getAIService } from "@/lib/ai";
import { getQuestionGradeContext, resolveQuestionGrade } from "@/lib/question-grade";
import type { QuestionGradeProfile } from "@/lib/question-grade";
import { prisma } from "@/lib/prisma";
import { badRequest, createErrorResponse, ErrorCode } from "@/lib/api-errors";
import type { CandidateTags, GradeLevel } from "@/lib/ai/types";
import { getNotebookCandidateTags } from "@/lib/ai/tag-service";
import { resolveNotebookScope, SUBJECT_DISPLAY_NAMES } from "@/lib/notebook-scope";
import { createLogger } from "@/lib/logger";
import { trackBackgroundTask } from "@/lib/background-tasks";
import { getAppTimeZone } from "@/lib/config";
import { getErrorMessage } from "@/lib/error-message";
import { consumeAiQuota } from "@/lib/ai-quota";
import { withRecoverableResponse } from "@/lib/recoverable-response";
import { toAnalyzeImageResult } from "@/lib/ai/parse-analyze";
import { toConcurrencyErrorResponse } from "@/lib/ai/concurrency";
import { recordAiProvenance } from "@/lib/ai/provenance";
import { ImageValidationError, normalizeImageInput } from "@/lib/server/image-normalize";
import { defineApiRoute, type AuthenticatedRouteContext } from "@/lib/server/api-route";

const logger = createLogger('api:analyze');

async function handlePost(req: Request, { user }: AuthenticatedRouteContext) {
    logger.info('Analyze API called');

    try {
        const body = await req.json();
        const { language, subjectId } = body;
        let { imageBase64, mimeType } = body;

        logger.debug({
            imageLength: imageBase64?.length,
            mimeType,
            language,
            subjectId
        }, 'Request received');

        if (!imageBase64 || typeof imageBase64 !== 'string') {
            logger.warn('Missing image data');
            return badRequest("Missing image data");
        }

        // 服务端校验真实图片格式、转正、限边并剥离 EXIF 等元数据
        try {
            const normalized = await normalizeImageInput(imageBase64);
            imageBase64 = normalized.base64;
            mimeType = normalized.mimeType;
            logger.debug({ mimeType, base64Length: imageBase64.length }, 'Normalized analyze image');
        } catch (imgError) {
            if (imgError instanceof ImageValidationError) {
                logger.warn({ code: imgError.code }, 'Invalid image payload for analyze');
                return badRequest("INVALID_IMAGE");
            }
            throw imgError;
        }

        // 直接使用经鉴权并加载的当前用户上下文构建年级档案与错题本范围
        const gradeProfile: QuestionGradeProfile = {
            educationStage: user.educationStage,
            enrollmentYear: user.enrollmentYear,
            gradeRecognitionMode: user.gradeRecognitionMode,
            fixedGradeSemester: user.fixedGradeSemester,
        };
        const context = getQuestionGradeContext(gradeProfile, getAppTimeZone());
        const userGrade: GradeLevel | null = context.grade;
        const userGradeSemester: string | null = context.gradeSemester;
        let subjectChinese: string | null = null;
        let candidateTags: CandidateTags | undefined;
        let notebookName: string | null = null;

        // 错题本的学段 + 学科决定候选知识点：直接取该范围内的全部标签
        if (subjectId) {
            try {
                const notebook = await prisma.subject.findUnique({
                    where: { id: subjectId },
                    select: { name: true, userId: true, stage: true, subjectKey: true }
                });

                if (notebook && notebook.userId === user.id) {
                    notebookName = notebook.name;
                    const scope = resolveNotebookScope(notebook);
                    subjectChinese = scope.subject ? SUBJECT_DISPLAY_NAMES[scope.subject] : null;
                    candidateTags = await getNotebookCandidateTags(scope);
                    logger.debug({ scope, candidateTagCount: candidateTags?.tags.length }, 'Notebook scope resolved');
                }
            } catch (error) {
                logger.error({ error }, 'Error fetching subject info');
            }
        }

        logger.info({ userGrade, userGradeSemester, subject: subjectChinese }, 'Calling AI service for image analysis');
        const limited = await consumeAiQuota(user, 'analyze');
        if (limited) return limited;

        const aiService = getAIService('vision');
        const analysisResult = await trackBackgroundTask(
            { userId: user.id, kind: 'analyze', subject: notebookName },
            () => aiService.analyzeImage(imageBase64, mimeType, language, userGrade, subjectChinese, userGradeSemester, candidateTags)
        );

        logger.debug({
            knowledgePointsCount: analysisResult.knowledgePoints?.length,
            knowledgePointsType: typeof analysisResult.knowledgePoints,
            isArray: Array.isArray(analysisResult.knowledgePoints)
        }, 'AI returned knowledge points');

        // AI 现在从数据库获取标签列表，返回的标签已经是标准化的，不需要额外处理
        if (!analysisResult.knowledgePoints || analysisResult.knowledgePoints.length === 0) {
            logger.warn('Knowledge points is empty or null');
        }

        logger.info('AI analysis successful');

        const provenanceId = await recordAiProvenance(prisma, { task: 'analyze', role: 'vision' });
        const items = (analysisResult.items?.length ? analysisResult.items : [analysisResult]).map((item) => (
            gradeProfile
                ? { ...item, gradeSemester: resolveQuestionGrade(gradeProfile, { recognizedGradeSemester: item.gradeSemester }, getAppTimeZone()) }
                : item
        ));
        return NextResponse.json(toAnalyzeImageResult(items, analysisResult.failedCount, provenanceId));
    } catch (error) {
        const busy = toConcurrencyErrorResponse(error);
        if (busy) return busy;
        const message = getErrorMessage(error);
        logger.error({
            error: message,
            stack: error instanceof Error ? error.stack : undefined
        }, 'Analysis error occurred');

        // 返回具体的错误类型，便于前端显示详细提示
        let errorMessage = message || "Failed to analyze image";

        // 识别特定错误类型
        if (message && (
            message === 'AI_CONNECTION_FAILED' ||
            message === 'AI_RESPONSE_ERROR' ||
            message.includes('AI_AUTH_ERROR') ||
            message === 'AI_TIMEOUT_ERROR' ||
            message === 'AI_QUOTA_EXCEEDED' ||
            message === 'AI_PERMISSION_DENIED' ||
            message === 'AI_NOT_FOUND' ||
            message === 'AI_SERVICE_UNAVAILABLE' ||
            message === 'AI_UNKNOWN_ERROR' ||
            message === 'AI_OUTPUT_TRUNCATED'
        )) {
            // 直接传递 AI Provider 定义的错误类型 (如果是 AI_AUTH_ERROR，提取出来)
            if (message.includes('AI_AUTH_ERROR')) {
                errorMessage = 'AI_AUTH_ERROR';
            } else {
                errorMessage = message;
            }
        } else if (message.includes('Zod') || message.includes('validate')) {
            // Zod 验证错误
            errorMessage = 'AI_RESPONSE_ERROR';
        }

        return createErrorResponse(errorMessage, 500, ErrorCode.AI_ERROR, message);
    }
}

/** 耗时 AI 请求：浏览器中断连接后，前端可通过 /api/requests/:id 取回响应 */
export const POST = defineApiRoute({ auth: 'user' }, withRecoverableResponse(handlePost));
