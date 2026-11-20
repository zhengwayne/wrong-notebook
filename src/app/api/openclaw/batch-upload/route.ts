import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { compare } from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { createLogger } from "@/lib/logger";
import { startBackgroundTask } from "@/lib/background-tasks";
import type { BackgroundTaskHandle } from "@/lib/background-tasks";
import { createErrorResponse, ErrorCode, forbidden, tooManyRequests } from "@/lib/api-errors";
import { prepareImportGrade } from "@/lib/import-question-grade";
import { needsQuestionGradeRecognition } from "@/lib/question-grade";
import { inferSubjectFromName } from "@/lib/knowledge-tags";
import { findParentTagIdForGrade } from "@/lib/tag-recognition";
import { generateUniqueShortId } from "@/lib/short-id";
import { scheduleMasteryEvaluation } from "@/lib/mastery";
import { scheduleLearningPathReplan } from "@/lib/learning-path/service";
import { findDuplicateQuestion, recordDuplicateQuestion, runQuestionImportTransaction } from "@/lib/question-deduplication";
import { parseDifficultyStars } from "@/lib/ai/schema";
import { recordAiProvenance } from "@/lib/ai/provenance";
import { getDefaultPaperLevel } from "@/lib/paper-level";
import { getErrorMessage } from "@/lib/error-message";
import { LearnerNotFoundError } from "@/lib/learners";
import { resolveLearningScope, type LearningScope } from "@/lib/learning-scope";
import { ImageValidationError, normalizeImageBuffer } from "@/lib/server/image-normalize";
import { findUserByEmailInsensitive, findUserByLoginIdentifier, normalizeEmail } from "@/lib/email";
import { getClientIp, loginAccountLimiter, loginIpLimiter } from "@/lib/rate-limit";

const logger = createLogger('api:openclaw:batch-upload');

const MAX_IMAGES = 20;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png'];

interface ImageData {
    base64: string;
    mimeType: string;
    filename: string;
}

interface OpenclawResponse {
    success: boolean;
    data?: {
        questionText: string;
        answerText: string;
        analysis: string;
        wrongAnswerText?: string;
        mistakeAnalysis?: string;
        knowledgePoints: string[];
        subject?: string;
        errorType?: string;
        source?: string;
        difficultyStars?: number | null;
        gradeSemester?: string | null;
    };
    error?: string;
}

function validateImage(base64: string, filename: string, mimeType: string): { valid: boolean; error?: string } {
    if (!base64 || base64.length === 0) {
        return { valid: false, error: '图片数据为空' };
    }

    const extension = filename.toLowerCase().substring(filename.lastIndexOf('.'));
    if (!ALLOWED_EXTENSIONS.includes(extension)) {
        return { valid: false, error: `不支持的图片格式: ${extension}，仅支持 JPG、PNG` };
    }

    // mimeType 会写入题目原图的 data URL，须与扩展名一样限定为 JPG、PNG
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
        return { valid: false, error: `不支持的图片类型: ${String(mimeType).slice(0, 50)}，仅支持 image/jpeg、image/png` };
    }

    const estimatedSize = (base64.length * 3) / 4;
    if (estimatedSize > MAX_IMAGE_SIZE) {
        return { valid: false, error: `图片大小超过限制: ${Math.round(estimatedSize / 1024 / 1024)}MB > 5MB` };
    }

    return { valid: true };
}

async function callOpenclawAgent(imageBase64: string, mimeType: string, timeout: number): Promise<OpenclawResponse> {
    const openclawUrl = process.env.OPENCLAW_API_URL || 'http://localhost:8080';
    const openclawApiKey = process.env.OPENCLAW_API_KEY || '';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(`${openclawUrl}/api/recognize`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(openclawApiKey ? { 'Authorization': `Bearer ${openclawApiKey}` } : {}),
            },
            body: JSON.stringify({
                image: imageBase64,
                mimeType: mimeType,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            logger.error({ status: response.status, error: errorText }, 'Openclaw agent error');
            return {
                success: false,
                error: `识别服务异常: HTTP ${response.status}`,
            };
        }

        const data = await response.json() as OpenclawResponse;
        return data;
    } catch (error) {
        clearTimeout(timeoutId);
        
        if (error instanceof Error && error.name === 'AbortError') {
            logger.error('Openclaw agent timeout');
            return {
                success: false,
                error: '识别服务超时',
            };
        }
        
        logger.error({ error: getErrorMessage(error) }, 'Openclaw agent request failed');
        return {
            success: false,
            error: `识别服务请求失败: ${getErrorMessage(error)}`,
        };
    }
}

async function createErrorItem(
    scope: LearningScope,
    imageBase64: string,
    mimeType: string,
    parsedData: OpenclawResponse['data'],
    finalGradeSemester: string | null,
    subjectId?: string,
    provenanceId?: string | null
) {
    const userId = scope.userId;
    const { questionText, answerText, analysis, knowledgePoints, errorType, source } = parsedData || {};
    const difficultyStars = parseDifficultyStars(parsedData?.difficultyStars);

    const content = {
        questionText,
        answerText,
        analysis,
        wrongAnswerText: parsedData?.wrongAnswerText,
        mistakeAnalysis: parsedData?.mistakeAnalysis,
        originalImageUrl: `data:${mimeType};base64,${imageBase64}`,
    };
    const result = await runQuestionImportTransaction(async (tx) => {
        const duplicate = await findDuplicateQuestion(tx, scope, content);
        if (duplicate) return recordDuplicateQuestion(tx, scope, duplicate, content);

        const tagNames: string[] = Array.isArray(knowledgePoints) ? knowledgePoints : [];
        const tagConnections: { id: string }[] = [];

        const subject = subjectId ? await tx.subject.findUnique({ where: { id: subjectId } }) : null;
        const subjectKey = (subject ? inferSubjectFromName(subject.name) : null) || (parsedData?.subject ? inferSubjectFromName(parsedData.subject) : null) || 'other';

        for (const tagName of tagNames) {
            try {
                let tag = await tx.knowledgeTag.findFirst({
                    where: {
                        name: tagName,
                        subject: subjectKey,
                        OR: [
                            { isSystem: true },
                            { userId: userId },
                        ],
                    },
                });

                if (!tag) {
                    const parentId = finalGradeSemester && subjectKey !== 'other'
                        ? await findParentTagIdForGrade(finalGradeSemester, subjectKey, tx)
                        : null;

                    tag = await tx.knowledgeTag.create({
                        data: {
                            name: tagName,
                            subject: subjectKey,
                            isSystem: false,
                            userId: userId,
                            parentId: parentId || undefined,
                        },
                    });
                }

                tagConnections.push({ id: tag.id });
            } catch (tagError) {
                logger.error({ tagName, error: tagError }, 'Error processing tag');
            }
        }

        const errorItem = await tx.errorItem.create({
            data: {
                shortId: await generateUniqueShortId(tx),
                userId: userId,
                subjectId: subjectId || undefined,
                learnerId: scope.learnerId || undefined,
                originalImageUrl: `data:${mimeType};base64,${imageBase64}`,
                ocrText: questionText || null,
                questionText: questionText || null,
                answerText: answerText || null,
                analysis: analysis || null,
                knowledgePoints: JSON.stringify(tagNames),
                gradeSemester: finalGradeSemester,
                paperLevel: getDefaultPaperLevel(difficultyStars),
                difficultyStars,
                errorType: errorType || null,
                source: source || 'Openclaw',
                provenanceId: provenanceId ?? null,
                masteryLevel: 0,
                tags: {
                    connect: tagConnections,
                },
            },
            include: {
                tags: true,
                subject: true,
            },
        });

        return errorItem;
    });
    if ('duplicate' in result && result.duplicate) scheduleMasteryEvaluation([result.id]);
    if (result?.id) scheduleLearningPathReplan(userId, 'zh', scope.learnerId);
    return result;
}

function safeCompareSecret(provided: string, expected: string): boolean {
    const providedDigest = crypto.createHash('sha256').update(provided, 'utf8').digest();
    const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
    return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

export async function POST(req: Request) {
    logger.info('POST /api/openclaw/batch-upload called');

    // 获取请求头中的 API Key
    const apiKey = req.headers.get('x-api-key');
    // 从环境变量获取配置的 API Key
    const expectedApiKey = process.env.OPENCLAW_INTEGRATION_API_KEY?.trim() || '';
    // 认证模式：credentials（用户名密码，默认）或 apikey（API Key）
    const authMode = process.env.OPENCLAW_AUTH_MODE || 'credentials';

    let user = null;
    let userEmail: string | null = null;
    let rawSubjectId: unknown = undefined;
    let task: BackgroundTaskHandle | null = null;

    try {
        const body = await req.json();
        const requestData = body;

        // 根据认证模式选择验证方式：apikey 模式下缺少服务端密钥配置时显式拒绝，绝不静默降级为密码认证
        if (authMode === 'apikey') {
            if (!expectedApiKey) {
                logger.error('OPENCLAW_AUTH_MODE=apikey but OPENCLAW_INTEGRATION_API_KEY is missing');
                return createErrorResponse(
                    '服务未配置 Openclaw API 密钥',
                    503,
                    ErrorCode.INTERNAL_ERROR,
                    'Openclaw API key not configured'
                );
            }

            if (!apiKey) {
                logger.warn('Missing API key in request');
                return createErrorResponse(
                    '未提供API密钥',
                    401,
                    ErrorCode.UNAUTHORIZED,
                    'Missing API key'
                );
            }

            if (!safeCompareSecret(apiKey, expectedApiKey)) {
                logger.warn('Invalid API key provided');
                return createErrorResponse(
                    'API密钥无效',
                    401,
                    ErrorCode.UNAUTHORIZED,
                    'Invalid API key'
                );
            }

            if (typeof requestData.userEmail !== 'string' || !requestData.userEmail.trim()) {
                return createErrorResponse(
                    '缺少有效的用户邮箱',
                    400,
                    ErrorCode.BAD_REQUEST,
                    'Invalid or missing userEmail'
                );
            }
            userEmail = normalizeEmail(requestData.userEmail);
            rawSubjectId = requestData.subjectId;
        } else {
            // 用户名密码认证模式（默认）
            const { username, password } = requestData;

            if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
                return createErrorResponse(
                    '请提供用户名和密码',
                    401,
                    ErrorCode.UNAUTHORIZED,
                    'Missing username or password'
                );
            }

            const ip = getClientIp(req.headers);
            const accountKey = normalizeEmail(username);
            const accountRetry = loginAccountLimiter.retryAfter(accountKey);
            const ipRetry = ip ? loginIpLimiter.retryAfter(ip) : 0;
            const retryAfter = Math.max(accountRetry, ipRetry);
            if (retryAfter > 0) {
                logger.warn({ username: accountKey, ip }, 'Openclaw credentials login rate limited');
                return tooManyRequests(retryAfter);
            }

            // 从数据库查找用户（支持邮箱大小写不敏感或用户名精确匹配），存在与否统一报 401 防止账户枚举
            user = await findUserByLoginIdentifier(prisma, username);
            const isPasswordValid = user ? await compare(password, user.password) : false;

            if (!user || !isPasswordValid) {
                loginAccountLimiter.hit(accountKey);
                if (ip) loginIpLimiter.hit(ip);
                logger.warn({ username: accountKey }, 'Openclaw credentials authentication failed');
                return createErrorResponse(
                    '用户名或密码错误',
                    401,
                    ErrorCode.UNAUTHORIZED,
                    'Invalid username or password'
                );
            }

            if (!user.isActive) {
                logger.warn({ userId: user.id }, 'Disabled user attempted Openclaw upload');
                return forbidden('账号已禁用');
            }

            loginAccountLimiter.reset(accountKey);
            userEmail = normalizeEmail(user.email);
            rawSubjectId = requestData.subjectId;
            logger.info({ userId: user.id, email: user.email }, 'User authenticated via credentials');
        }

        // 获取图片数组
        const { images } = requestData;

        // 验证图片数组
        if (!images || !Array.isArray(images) || images.length === 0) {
            return createErrorResponse(
                '未提供图片数据',
                400,
                ErrorCode.BAD_REQUEST,
                'Missing images array'
            );
        }

        // 验证图片数量
        if (images.length > MAX_IMAGES) {
            return createErrorResponse(
                `图片数量超过限制: 最多${MAX_IMAGES}张`,
                400,
                ErrorCode.BAD_REQUEST,
                `Maximum ${MAX_IMAGES} images allowed`
            );
        }

        // 获取用户信息（API Key 模式需要单独按大小写不敏感查库并校验激活状态）
        let dbUser = user;
        if (!dbUser && userEmail) {
            dbUser = await findUserByEmailInsensitive(prisma, userEmail);
        }

        if (!dbUser) {
            logger.warn({ userEmail }, 'User not found');
            return createErrorResponse(
                '用户不存在',
                404,
                ErrorCode.USER_NOT_FOUND,
                'User not found'
            );
        }

        if (!dbUser.isActive) {
            logger.warn({ userId: dbUser.id }, 'Disabled user rejected for Openclaw upload');
            return forbidden('账号已禁用');
        }

        // 校验 subjectId 类型及归属，防止跨账户写入他人错题本
        let subjectId: string | undefined;
        if (rawSubjectId !== undefined && rawSubjectId !== null) {
            if (typeof rawSubjectId !== 'string') {
                return createErrorResponse(
                    'subjectId 参数无效',
                    400,
                    ErrorCode.BAD_REQUEST,
                    'Invalid subjectId'
                );
            }
            const trimmedSubjectId = rawSubjectId.trim();
            if (trimmedSubjectId) {
                const targetSubject = await prisma.subject.findUnique({
                    where: { id: trimmedSubjectId },
                    select: { id: true, userId: true },
                });
                if (!targetSubject || targetSubject.userId !== dbUser.id) {
                    return forbidden('无权写入该错题本');
                }
                subjectId = targetSubject.id;
            }
        }

        const rawLearnerInput = requestData.learnerId;
        if (
            rawLearnerInput !== undefined &&
            rawLearnerInput !== null &&
            typeof rawLearnerInput !== 'string'
        ) {
            return createErrorResponse(
                'learnerId 参数无效',
                400,
                ErrorCode.BAD_REQUEST,
                'Invalid learnerId'
            );
        }
        let scope: LearningScope;
        try {
            scope = await resolveLearningScope(prisma, dbUser.id, rawLearnerInput ?? null);
        } catch (error) {
            if (error instanceof LearnerNotFoundError) {
                return createErrorResponse(
                    '未找到学习者档案',
                    404,
                    ErrorCode.NOT_FOUND,
                    'Learner not found'
                );
            }
            throw error;
        }

        const parsedTimeout = parseInt(process.env.OPENCLAW_TIMEOUT || '30000', 10);
        const totalTimeout = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 30000;
        const singleImageTimeout = Math.max(3000, Math.floor(totalTimeout / images.length));
        const results: Array<{
            success: boolean;
            index: number;
            errorItemId?: string;
            duplicate?: boolean;
            mistakeRecorded?: boolean;
            similarity?: number;
            practiceRecordId?: string;
            message?: string;
            error?: string;
        }> = [];
        // 页面「后台任务」中显示识别进度
        const currentTask = startBackgroundTask({ userId: dbUser.id, kind: 'batch_upload', total: images.length });
        task = currentTask;
        const reportProgress = () => currentTask.setProgress(results.length, images.length, results.filter(r => !r.success).length);

        for (let i = 0; i < images.length; i++) {
            reportProgress();
            const imageData = images[i] as ImageData;
            const { base64, mimeType, filename } = imageData;

            const validation = validateImage(base64, filename, mimeType);
            if (!validation.valid) {
                logger.warn({ index: i, filename, error: validation.error }, 'Image validation failed');
                results.push({
                    success: false,
                    index: i,
                    error: validation.error,
                });
                continue;
            }

            let normalizedImg: { base64: string; mimeType: string };
            try {
                normalizedImg = await normalizeImageBuffer(Buffer.from(base64, 'base64'), { allowedFormats: ['jpeg', 'png'] });
            } catch (imgError) {
                const errMsg = imgError instanceof ImageValidationError ? imgError.code : 'INVALID_IMAGE';
                logger.warn({ index: i, filename, error: errMsg }, 'Image normalization failed');
                results.push({
                    success: false,
                    index: i,
                    error: `无效或损坏的图片数据: ${errMsg}`,
                });
                continue;
            }

            const openclawResponse = await callOpenclawAgent(normalizedImg.base64, normalizedImg.mimeType, singleImageTimeout);

            if (!openclawResponse.success || !openclawResponse.data) {
                logger.error({ index: i, error: openclawResponse.error }, 'Openclaw recognition failed');
                results.push({
                    success: false,
                    index: i,
                    error: openclawResponse.error || '识别失败',
                });
                continue;
            }

            try {
                const gradeInput = {
                    questionText: openclawResponse.data.questionText,
                    recognizedGradeSemester: openclawResponse.data.gradeSemester,
                };
                const duplicateBeforeRecognition = needsQuestionGradeRecognition(dbUser, gradeInput)
                    ? await findDuplicateQuestion(prisma, scope, gradeInput) : null;
                const gradeResult = await prepareImportGrade(dbUser, gradeInput, duplicateBeforeRecognition !== null);
                if (gradeResult.response) {
                    results.push({ success: false, index: i, error: 'AI_DAILY_LIMIT_EXCEEDED' });
                    continue;
                }
                const provenanceId = await recordAiProvenance(prisma, {
                    task: 'analyze',
                    role: 'vision',
                    providerOverride: 'openclaw',
                    modelOverride: 'agent',
                });
                const errorItem = await createErrorItem(
                    scope,
                    normalizedImg.base64,
                    normalizedImg.mimeType,
                    openclawResponse.data,
                    gradeResult.gradeSemester,
                    subjectId,
                    provenanceId,
                );

                results.push({
                    success: true,
                    index: i,
                    errorItemId: errorItem.id,
                    ...('duplicate' in errorItem ? {
                        duplicate: errorItem.duplicate,
                        mistakeRecorded: errorItem.mistakeRecorded,
                        similarity: errorItem.similarity,
                        practiceRecordId: errorItem.practiceRecordId,
                        message: errorItem.message,
                    } : {}),
                });

                logger.info({ index: i, errorItemId: errorItem.id }, 'Error item created successfully');
            } catch (dbError) {
                logger.error({ index: i, error: getErrorMessage(dbError) }, 'Failed to create error item');
                results.push({
                    success: false,
                    index: i,
                    error: `导入失败: ${getErrorMessage(dbError)}`,
                });
            }
        }

        const successCount = results.filter(r => r.success).length;
        const failCount = results.length - successCount;
        reportProgress();
        if (successCount === 0) currentTask.fail('ALL_FAILED');
        else currentTask.succeed();

        logger.info({ 
            total: results.length, 
            success: successCount, 
            failed: failCount 
        }, 'Batch upload completed');

        const statusCode = failCount === 0 ? 201 : 207;

        return NextResponse.json({
            success: failCount === 0,
            total: results.length,
            successCount,
            failCount,
            results,
        }, { status: statusCode });
    } catch (error) {
        task?.fail(error);
        const message = getErrorMessage(error);
        logger.error({ error: message, stack: error instanceof Error ? error.stack : undefined }, 'Batch upload error');
        return createErrorResponse(
            message || '批量上传失败',
            500,
            ErrorCode.INTERNAL_ERROR,
            message
        );
    }
}
