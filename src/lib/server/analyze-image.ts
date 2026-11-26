import { NextResponse } from "next/server";
import { getAIService } from "@/lib/ai";
import { getQuestionGradeContext, resolveQuestionGrade } from "@/lib/question-grade";
import type { QuestionGradeProfile } from "@/lib/question-grade";
import { prisma } from "@/lib/prisma";
import { badRequest, createErrorResponse, ErrorCode } from "@/lib/api-errors";
import type { AnalyzeExtraImage, CandidateTags, GradeLevel } from "@/lib/ai/types";
import { getNotebookCandidateTags } from "@/lib/ai/tag-service";
import { resolveNotebookScope, SUBJECT_DISPLAY_NAMES } from "@/lib/notebook-scope";
import { createLogger } from "@/lib/logger";
import { trackBackgroundTask } from "@/lib/background-tasks";
import { getAppTimeZone } from "@/lib/config";
import { getErrorMessage } from "@/lib/error-message";
import { reserveAiQuota, type AiQuotaReservation } from "@/lib/ai-quota";
import { toAnalyzeImageResult } from "@/lib/ai/parse-analyze";
import { toConcurrencyErrorResponse } from "@/lib/ai/concurrency";
import { recordAiProvenance } from "@/lib/ai/provenance";
import { ImageValidationError, normalizeImageInput, stitchImages, type NormalizedImageResult } from "@/lib/server/image-normalize";
import type { ActorUser } from "@/lib/server/actor";

const logger = createLogger('api:analyze');

export interface AnalyzeImageInput {
    imageBase64?: unknown;
    mimeType?: unknown;
    language?: unknown;
    subjectId?: unknown;
    /** 同一道跨页题按顺序拍的后续几页（data URL 或裸 base64），与 imageBase64 一起作为一次识别 */
    additionalImages?: unknown;
}

/** 一次识别最多几张图（跨页题合成一组） */
export const MAX_ANALYZE_IMAGES = 3;

export interface AnalyzeImageOptions {
    /** 小程序上传后需要拿回规范化后的图片保存错题，网页端已在本地持有图片 */
    includeImageDataUrl?: boolean;
    /** 原始请求：取 x-request-id，同一请求编号重试只预留一次额度 */
    request?: Request;
}

/** 识别算成功：至少认出 1 道有内容的题 */
export function hasRecognizedQuestion(items: Array<{ questionText?: string | null }> | undefined | null): boolean {
    return Boolean(items?.some((item) => typeof item?.questionText === "string" && item.questionText.trim().length > 0));
}

/**
 * 图片错题识别：校验并规范化图片，按错题本学段学科给出候选知识点，调用视觉模型并记录溯源。
 * 网页端 /api/analyze（JSON base64）与小程序 /api/mp/analyze（multipart 上传或 JSON）共用。
 * 带 additionalImages 时几张图按顺序一起交给 AI，只计 1 次 AI 用量，并返回拼好的原图 imageDataUrl。
 */
export async function analyzeImageForUser(user: ActorUser, body: AnalyzeImageInput, options: AnalyzeImageOptions = {}): Promise<Response> {
    logger.info('Analyze API called');
    let quota: AiQuotaReservation | undefined;

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
        const rawExtras = body.additionalImages ?? [];
        if (!Array.isArray(rawExtras) || rawExtras.some((item) => !item || typeof item !== 'string')) {
            return badRequest("INVALID_IMAGE");
        }
        if (rawExtras.length + 1 > MAX_ANALYZE_IMAGES) {
            return badRequest("TOO_MANY_IMAGES");
        }

        let imageBase64: string;
        let extraImages: AnalyzeExtraImage[] = [];
        // 服务端校验真实图片格式、转正、限边并剥离 EXIF 等元数据
        try {
            const normalized = await normalizeImageInput(rawImage);
            imageBase64 = normalized.base64;
            mimeType = normalized.mimeType;
            const extras: NormalizedImageResult[] = [];
            for (const raw of rawExtras as string[]) extras.push(await normalizeImageInput(raw));
            extraImages = extras.map((image) => ({ base64: image.base64, mimeType: image.mimeType }));
            if (extras.length > 0) {
                // 跨页题保存为一张拼好的原图，网页、打印、导出等处无需改动即可看到全部页面
                imageDataUrl = (await stitchImages([normalized, ...extras])).dataUrl;
            } else if (options.includeImageDataUrl) {
                imageDataUrl = normalized.dataUrl;
            }
            logger.debug({ mimeType, base64Length: imageBase64.length, pageCount: 1 + extras.length }, 'Normalized analyze image');
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
        // 一组图片只调用一次 AI，按一次计；认出至少 1 道题才确认，否则退回
        quota = await reserveAiQuota(user, 'analyze', { request: options.request });
        if (quota.limited) return quota.limited;

        const aiService = getAIService('vision');
        const analysisResult = await trackBackgroundTask(
            { userId: user.id, kind: 'analyze', subject: notebookName },
            () => aiService.analyzeImage(imageBase64, mimeType, language, userGrade, subjectChinese, userGradeSemester, candidateTags, extraImages)
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
        const result = {
            ...toAnalyzeImageResult(items, analysisResult.failedCount, provenanceId, analysisResult.continuity),
            pageCount: 1 + extraImages.length,
        };
        await quota.settle(hasRecognizedQuestion(items));
        return NextResponse.json(imageDataUrl ? { ...result, imageDataUrl } : result);
    } catch (error) {
        await quota?.release();
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
