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
import { toAnalyzeImageResult } from "@/lib/ai/parse-analyze";
import { toConcurrencyErrorResponse } from "@/lib/ai/concurrency";
import { recordAiProvenance } from "@/lib/ai/provenance";
import { ImageValidationError, normalizeImageInput } from "@/lib/server/image-normalize";
import type { ActorUser } from "@/lib/server/actor";

const logger = createLogger('api:analyze');

export interface AnalyzeImageInput {
    imageBase64?: unknown;
    mimeType?: unknown;
    language?: unknown;
    subjectId?: unknown;
}

export interface AnalyzeImageOptions {
    /** 小程序上传后需要拿回规范化后的图片保存错题，网页端已在本地持有图片 */
    includeImageDataUrl?: boolean;
}

/**
 * 图片错题识别：校验并规范化图片，按错题本学段学科给出候选知识点，调用视觉模型并记录溯源。
 * 网页端 /api/analyze（JSON base64）与小程序 /api/mp/analyze（multipart 上传）共用。
 */
export async function analyzeImageForUser(user: ActorUser, body: AnalyzeImageInput, options: AnalyzeImageOptions = {}): Promise<Response> {
    logger.info('Analyze API called');

    try {
        const language = body.language === 'en' || body.language === 'zh' ? body.language : undefined;
        const subjectId = typeof body.subjectId === 'string' && body.subjectId ? body.subjectId : undefined;
        const rawImage = body.imageBase64;
        let mimeType = typeof body.mimeType === 'string' ? body.mimeType : undefined;
        let imageDataUrl: string | undefined;

        logger.debug({
            imageLength: typeof rawImage === 'string' ? rawImage.length : undefined,
            mimeType,
            language,
            subjectId
        }, 'Request received');

        if (!rawImage || typeof rawImage !== 'string') {
            logger.warn('Missing image data');
            return badRequest("Missing image data");
        }

        let imageBase64: string;
        // 服务端校验真实图片格式、转正、限边并剥离 EXIF 等元数据
        try {
            const normalized = await normalizeImageInput(rawImage);
            imageBase64 = normalized.base64;
            mimeType = normalized.mimeType;
            if (options.includeImageDataUrl) imageDataUrl = normalized.dataUrl;
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
        const result = toAnalyzeImageResult(items, analysisResult.failedCount, provenanceId);
        return NextResponse.json(imageDataUrl ? { ...result, imageDataUrl } : result);
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
