import Anthropic from "@anthropic-ai/sdk";
import type { AIService, GradeLevel, ParsedQuestion, DifficultyLevel, AIConfig, ReanswerQuestionResult, GeogebraAnalysisResult, MasteryEvaluationInput, MasteryEvaluationResult, AnswerGradingInput, AnswerGradingResult, TagSuggestionInput, TagSuggestionResult, CandidateTags, FigureResult, StructuredCompletion, AnalyzeImageResult } from "./types";
import { parseJsonCompletion, usageFromAnthropic } from "./usage";
import { generateGradeRecognitionRequest, generateAnalyzeRequest, generateSimilarQuestionRequest, generateGeogebraRequest, generateMasteryRequest, generateGradingRequest, generateTagSuggestRequest, generateReanswerRequest, generateFigureRequest, generateSvgAnimationRequest, generateSvgNarrationRequest, generateLatexFixRequest } from './prompt-requests';
import { parseNarration, sanitizeSvgAnimation } from '../svg-animation';
import type { NarrationSegment } from '../svg-animation';
import { parseLatexFix } from './latex-fix';
import type { LatexFixInput, LatexFixResult } from './latex-fix';
import { getAppConfig } from '../config';
import { parseGradeRecognition, parseMasteryEvaluation, parseAnswerGrading, parseTagSuggestion, parseFigure } from './schema';
import { prefetchSubjectTags } from './tag-service';
import { generateExamPaperReadRequest } from './prompt-requests';
import { parseExamPaperByMode } from './exam-paper-read';
import type { ExamPaperReadInput, ExamPaperReadResult } from './exam-paper-read';
import { createLogger } from '../logger';
import { trimTrailingSlashes } from '../utils';
import { withTruncationRetry } from './truncation';
import { normalizeGeneratedQuestion } from './generated-question';
import { normalizeAiQuestionTags } from './knowledge-points';
import { parseAnalyzeResponse, toAnalyzeImageResult } from './parse-analyze';
import { getInitialMaxTokens } from './model-output-limits';
import { extractXmlTag, parseGeogebraJson, parseQuestionXml, parseReanswerXml } from './base-xml-parser';
import { deadlineFetch } from './deadline';
import { normalizeAiError } from './error-normalizer';

const logger = createLogger('ai:anthropic');

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

// 显式指定请求超时：SDK 在未指定超时且 max_tokens 较大时会拒绝非流式请求
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
type UserContent = string | Anthropic.ContentBlockParam[];

function toImageMediaType(mimeType: string | undefined): ImageMediaType {
    const normalized = (mimeType || '').toLowerCase();
    if (normalized === 'image/png' || normalized === 'image/gif' || normalized === 'image/webp') {
        return normalized;
    }
    return 'image/jpeg';
}

function imageBlock(base64: string, mimeType?: string): Anthropic.ImageBlockParam {
    // 兼容 data URL（data:image/png;base64,xxx）和纯 base64
    const match = base64.match(/^data:([^;]+);base64,([\s\S]*)$/);
    return {
        type: 'image',
        source: {
            type: 'base64',
            media_type: toImageMediaType(match ? match[1] : mimeType),
            data: match ? match[2] : base64,
        },
    };
}

/** 兼容接口沿用的 API 版本：SDK 1.x 默认发送 2026-10-21，第三方兼容接口未必支持 */
export const COMPAT_ANTHROPIC_VERSION = '2023-06-01';

function isOfficialAnthropicHost(baseURL: string): boolean {
    try {
        return new URL(baseURL).hostname === new URL(DEFAULT_ANTHROPIC_BASE_URL).hostname;
    } catch {
        return false;
    }
}

/**
 * 创建 SDK 客户端。apiKey 与 authToken 都显式传入（未用的传 null），避免 SDK 读取环境变量里的 ANTHROPIC_API_KEY。
 * - 官方接口：使用 SDK 默认的 API 版本和鉴权方式。
 * - 兼容接口（自定义地址、MiniMax Code 等）：保持与旧版 SDK 相同的请求头——API Key 以 x-api-key 发送、
 *   anthropic-version 为 2023-06-01。SDK 1.x 改为以 Authorization: Bearer 发送 API Key，不少兼容网关只认 x-api-key。
 * authToken（OAuth 登录的渠道）始终以 Authorization: Bearer 发送。
 */
export function createAnthropicClient(baseURL: string, apiKey?: string, authToken?: string): Anthropic {
    const options = { baseURL, timeout: REQUEST_TIMEOUT_MS, fetch: deadlineFetch };
    if (isOfficialAnthropicHost(baseURL)) {
        return apiKey
            ? new Anthropic({ ...options, apiKey, authToken: null })
            : new Anthropic({ ...options, apiKey: null, authToken });
    }
    const defaultHeaders: Record<string, string> = { 'anthropic-version': COMPAT_ANTHROPIC_VERSION };
    if (apiKey) {
        defaultHeaders['x-api-key'] = apiKey;
        return new Anthropic({ ...options, apiKey: null, authToken: null, defaultHeaders });
    }
    return new Anthropic({ ...options, apiKey: null, authToken, defaultHeaders });
}

/**
 * Anthropic Messages API 及其兼容接口（如各家模型的 /anthropic 端点）
 */
export class AnthropicProvider implements AIService {
    private client: Anthropic;
    private model: string;
    private baseURL: string;

    constructor(config?: AIConfig) {
        const apiKey = config?.apiKey;
        const authToken = config?.authToken;
        if (!apiKey && !authToken) {
            throw new Error("AI_AUTH_ERROR: ANTHROPIC_API_KEY is required for Anthropic provider");
        }

        // SDK 会自动拼接 /v1/messages，这里去掉用户可能多填的 /v1 和末尾斜杠
        this.baseURL = trimTrailingSlashes(config?.baseUrl || DEFAULT_ANTHROPIC_BASE_URL).replace(/\/v1$/, '');
        this.model = config?.model || DEFAULT_ANTHROPIC_MODEL;
        this.client = createAnthropicClient(this.baseURL, apiKey, authToken);

        logger.info({
            provider: 'Anthropic',
            model: this.model,
            baseURL: this.baseURL,
        }, 'AI Provider initialized');
    }

    /** 发送一次单轮对话并返回正文；正文为空且因长度截断时用更大的上限重试 */
    private async complete(system: string, content: UserContent, maxTokens: number): Promise<string> {
        const response = await withTruncationRetry(async (limit) => {
            const message = await this.client.messages.create({
                model: this.model,
                max_tokens: limit,
                system,
                messages: [{ role: 'user', content }],
            });
            // 兼容接口的推理模型会返回 thinking 块，只取正文
            const text = message.content
                .filter((block): block is Anthropic.TextBlock => block.type === 'text')
                .map(block => block.text)
                .join('');
            logger.debug({ stopReason: message.stop_reason, usage: message.usage }, 'Anthropic response received');
            return {
                text,
                choices: [{ finish_reason: message.stop_reason === 'max_tokens' ? 'length' : message.stop_reason, message: { content: text } }],
            };
        }, maxTokens, () => logger.warn('Output truncated by reasoning, retrying with larger max_tokens'), this.model);

        if (!response.text) throw new Error("Empty response from AI");
        return response.text;
    }

    async analyzeImage(imageBase64: string, mimeType: string = "image/jpeg", language: 'zh' | 'en' = 'zh', grade?: GradeLevel | null, subject?: string | null, gradeSemester?: string | null, candidateTags?: CandidateTags): Promise<AnalyzeImageResult> {
        const config = getAppConfig();
        const tagOptions = candidateTags ? { candidateTags } : await prefetchSubjectTags(subject, grade);
        const initialMax = getInitialMaxTokens(this.model);
        const systemPrompt = generateAnalyzeRequest(language, grade, subject, {
            customTemplate: config.prompts?.analyze,
            // 有错题本学段 + 学科时直接使用其全部知识点，否则按学科、年级取标签
            ...tagOptions,
        }, gradeSemester);

        logger.box('🔍 AI Image Analysis Request', {
            provider: 'Anthropic',
            endpoint: `${this.baseURL}/v1/messages`,
            imageSize: `${imageBase64.length} bytes`,
            mimeType,
            model: this.model,
            language,
            grade: grade || 'all'
        });
        logger.box('📝 Full System Prompt', systemPrompt.system);

        try {
            const text = await this.complete(systemPrompt.system, [
                imageBlock(imageBase64, mimeType),
                { type: 'text', text: systemPrompt.user },
            ], initialMax);
            logger.box('🤖 AI Raw Response', text);
            const parsed = parseAnalyzeResponse(text);
            const items = parsed.items.map((item) => normalizeAiQuestionTags(item, tagOptions));
            const parsedResult = toAnalyzeImageResult(items, parsed.failedCount);
            logger.box('✅ Parsed & Validated Result', JSON.stringify(parsedResult, null, 2));
            return parsedResult;
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during AI analysis');
            this.handleError(error);
            throw error;
        }
    }

    async generateSimilarQuestion(originalQuestion: string, knowledgePoints: string[], language: 'zh' | 'en' = 'zh', difficulty: DifficultyLevel = 'medium', gradeSemester?: string | null, originalFigureSvg?: string | null): Promise<ParsedQuestion> {
        const config = getAppConfig();
        const systemPrompt = generateSimilarQuestionRequest(language, originalQuestion, knowledgePoints, difficulty, {
            customTemplate: config.prompts?.similar,
            originalFigureSvg,
        }, gradeSemester);
        const userPrompt = systemPrompt.user;

        logger.info({ provider: 'Anthropic', model: this.model, difficulty, language }, 'Generate Similar Question Request');

        try {
            const text = await this.complete(systemPrompt.system, userPrompt, getInitialMaxTokens(this.model));
            logger.box('🤖 AI Raw Response', text);
            return normalizeGeneratedQuestion(parseQuestionXml(text));
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during question generation');
            this.handleError(error);
        }
    }


    async completeJson(request: { system: string; user: string }): Promise<StructuredCompletion> {
        try {
            const response = await withTruncationRetry(async (limit) => {
                const message = await this.client.messages.create({
                    model: this.model,
                    max_tokens: limit,
                    system: request.system,
                    messages: [{ role: 'user', content: request.user }],
                });
                const text = message.content
                    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
                    .map((block) => block.text)
                    .join('');
                return {
                    text,
                    usage: message.usage,
                    choices: [{ finish_reason: message.stop_reason === 'max_tokens' ? 'length' : message.stop_reason, message: { content: text } }],
                };
            }, 4096, () => logger.warn('Output truncated by reasoning, retrying with larger max_tokens'), this.model);
            return parseJsonCompletion(response.text, usageFromAnthropic(response.usage));
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during structured JSON completion');
            this.handleError(error);
        }
    }

    async reanswerQuestion(questionText: string, language: 'zh' | 'en' = 'zh', subject?: string | null, imageBase64?: string, gradeSemester?: string | null, candidateTags?: CandidateTags): Promise<ReanswerQuestionResult> {
        const prompt = generateReanswerRequest(language, questionText, subject, { candidateTags }, gradeSemester);

        logger.info({
            provider: 'Anthropic',
            model: this.model,
            questionLength: questionText.length,
            subject: subject || 'auto',
            hasImage: !!imageBase64
        }, 'Reanswer Question Request');

        try {
            const content: UserContent = imageBase64
                ? [imageBlock(imageBase64), { type: 'text', text: prompt.user }]
                : prompt.user;
            const text = await this.complete(prompt.system, content, getInitialMaxTokens(this.model));
            logger.debug({ rawResponse: text }, 'AI raw response');

            return parseReanswerXml(text, candidateTags);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during reanswer');
            this.handleError(error);
        }
    }

    async analyzeForGeogebra(questionText: string, answerText: string, analysis: string, previousErrors?: string): Promise<GeogebraAnalysisResult> {
        const prompt = generateGeogebraRequest(questionText, answerText, analysis, previousErrors);
        logger.info({ provider: 'Anthropic', model: this.model, questionLength: questionText.length }, 'GeoGebra Analysis Request');

        try {
            const text = await this.complete(prompt.system, prompt.user, 4096);
            logger.debug({ rawResponse: text }, 'GeoGebra AI raw response');
            return parseGeogebraJson(text);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during GeoGebra analysis');
            this.handleError(error);
        }
    }

    async evaluateMastery(input: MasteryEvaluationInput): Promise<MasteryEvaluationResult> {
        const prompt = generateMasteryRequest(input);
        logger.info({ provider: 'Anthropic', historyCount: input.history.length }, 'Mastery Evaluation Request');

        try {
            const text = await this.complete(prompt.system, prompt.user, 4096);
            logger.debug({ rawResponse: text }, 'Mastery AI raw response');
            return parseMasteryEvaluation(text);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during mastery evaluation');
            this.handleError(error);
            throw error;
        }
    }

    async recognizeGrade(questionText: string): Promise<string | null> {
        const prompt = generateGradeRecognitionRequest(questionText);
        try {
            return parseGradeRecognition(await this.complete(
                prompt.system, prompt.user, 1024,
            ));
        } catch (error) {
            logger.error({ error }, '识别题目年级失败');
            this.handleError(error);
            throw error;
        }
    }

    async gradeAnswer(input: AnswerGradingInput): Promise<AnswerGradingResult> {
        const prompt = generateGradingRequest(input);
        logger.info({ provider: 'Anthropic' }, 'Answer Grading Request');

        try {
            const text = await this.complete(prompt.system, prompt.user, 4096);
            logger.debug({ rawResponse: text }, 'Grading AI raw response');
            return parseAnswerGrading(text);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during answer grading');
            this.handleError(error);
            throw error;
        }
    }

    async readExamPaper(input: ExamPaperReadInput): Promise<ExamPaperReadResult> {
        const prompt = generateExamPaperReadRequest(input);
        logger.info({ provider: 'Anthropic', mode: input.mode, pages: input.images.length }, 'Exam Paper Read Request');

        try {
            const text = await this.complete(prompt.system, [
                ...input.images.map((image) => imageBlock(image.base64, image.mimeType)),
                { type: 'text', text: prompt.user },
            ], getInitialMaxTokens(this.model));
            logger.debug({ rawResponse: text }, 'Exam paper read AI raw response');
            return parseExamPaperByMode(input.mode, text, input.images.length);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during exam paper read');
            this.handleError(error);
            throw error;
        }
    }

    async suggestKnowledgeTags(input: TagSuggestionInput): Promise<TagSuggestionResult> {
        const prompt = generateTagSuggestRequest(input);
        logger.info({ provider: 'Anthropic', subject: input.subject, allowedTagCount: input.allowedTags.length }, 'Tag Suggestion Request');

        try {
            const text = await this.complete(prompt.system, prompt.user, 4096);
            logger.debug({ rawResponse: text }, 'Tag suggestion AI raw response');
            return parseTagSuggestion(text, input.allowedTags);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during tag suggestion');
            this.handleError(error);
            throw error;
        }
    }

    async generateFigureSvg(imageBase64: string, mimeType: string, questionText?: string | null): Promise<FigureResult> {
        const prompt = generateFigureRequest(questionText);
        logger.info({ provider: 'Anthropic', model: this.model, imageSize: imageBase64.length }, 'Figure SVG Request');

        try {
            const text = await this.complete(prompt.system, [
                imageBlock(imageBase64, mimeType),
                { type: 'text', text: prompt.user },
            ], getInitialMaxTokens(this.model));
            logger.debug({ rawResponse: text }, 'Figure SVG AI raw response');
            return parseFigure(extractXmlTag(text, "has_figure"), extractXmlTag(text, "figure_svg"));
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during figure SVG generation');
            this.handleError(error);
        }
    }

    async fixLatex(input: LatexFixInput): Promise<LatexFixResult> {
        const prompt = generateLatexFixRequest(input);
        logger.info({ provider: 'Anthropic', model: this.model, fields: Object.keys(input) }, 'LaTeX Fix Request');

        try {
            const text = await this.complete(prompt.system, prompt.user, getInitialMaxTokens(this.model));
            logger.debug({ rawResponse: text }, 'LaTeX fix AI raw response');
            return parseLatexFix(text, input);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during LaTeX fix');
            this.handleError(error);
        }
    }

    async generateSvgAnimation(questionText: string, answerText: string, analysis: string, figureSvg?: string | null, language: 'zh' | 'en' = 'zh'): Promise<string | null> {
        const prompt = generateSvgAnimationRequest(questionText, answerText, analysis, figureSvg, language);
        logger.info({ provider: 'Anthropic', model: this.model, questionLength: questionText.length }, 'SVG Animation Request');

        try {
            const text = await this.complete(prompt.system, prompt.user, 16384);
            logger.debug({ rawResponse: text }, 'SVG animation AI raw response');
            return sanitizeSvgAnimation(extractXmlTag(text, "svg_animation") || text);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during SVG animation generation');
            this.handleError(error);
        }
    }

    async generateSvgNarration(questionText: string, answerText: string, analysis: string, svgAnimation: string, language: 'zh' | 'en' = 'zh'): Promise<NarrationSegment[] | null> {
        const prompt = generateSvgNarrationRequest(questionText, answerText, analysis, svgAnimation, language);
        logger.info({ provider: 'Anthropic', model: this.model, svgLength: svgAnimation.length }, 'SVG Narration Request');

        try {
            const text = await this.complete(prompt.system, prompt.user, 4096);
            logger.debug({ rawResponse: text }, 'SVG narration AI raw response');
            return parseNarration(extractXmlTag(text, "narration") || text);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during SVG narration generation');
            this.handleError(error);
        }
    }

    private handleError(error: unknown): never {
        normalizeAiError(error, 'Anthropic');
    }
}
