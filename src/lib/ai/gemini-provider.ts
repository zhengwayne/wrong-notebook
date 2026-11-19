import { GoogleGenAI } from "@google/genai";
import type { AIService, GradeLevel, ParsedQuestion, DifficultyLevel, AIConfig, ReanswerQuestionResult, GeogebraAnalysisResult, MasteryEvaluationInput, MasteryEvaluationResult, AnswerGradingInput, AnswerGradingResult, TagSuggestionInput, TagSuggestionResult, CandidateTags, FigureResult, StructuredCompletion } from "./types";
import type { AnalyzeImageResult } from './types';
import { parseJsonCompletion, usageFromGemini } from "./usage";
import { generateGradeRecognitionRequest, generateAnalyzeRequest, generateSimilarQuestionRequest, generateGeogebraRequest, generateMasteryRequest, generateGradingRequest, generateTagSuggestRequest, generateFigureRequest, generateSvgAnimationRequest, generateSvgNarrationRequest, generateLatexFixRequest } from './prompt-requests';
import { parseNarration, sanitizeSvgAnimation } from '../svg-animation';
import type { NarrationSegment } from '../svg-animation';
import { parseLatexFix } from './latex-fix';
import type { LatexFixInput, LatexFixResult } from './latex-fix';
import { parseGradeRecognition, parseMasteryEvaluation, parseAnswerGrading, parseTagSuggestion, parseFigure } from './schema';
import { getAppConfig } from '../config';
import { prefetchSubjectTags } from './tag-service';
import { generateExamPaperReadRequest } from './prompt-requests';
import { parseExamPaperByMode } from './exam-paper-read';
import type { ExamPaperReadInput, ExamPaperReadResult } from './exam-paper-read';
import { createLogger } from '../logger';
import { withTruncationRetry } from './truncation';
import { normalizeGeneratedQuestion } from './generated-question';
import { normalizeAiQuestionTags } from './knowledge-points';
import { parseAnalyzeResponse, toAnalyzeImageResult } from './parse-analyze';
import { getInitialMaxTokens } from './model-output-limits';
import { extractXmlTag, parseGeogebraJson, parseQuestionXml, parseReanswerXml } from './base-xml-parser';
import { isAiDeadlineExceeded } from './deadline';
import { normalizeAiError } from './error-normalizer';

const logger = createLogger('ai:gemini');

type GeminiContent = string | Array<
    { text: string } |
    { inlineData: { mimeType: string; data: string } }
>;

export class GeminiProvider implements AIService {
    private ai: GoogleGenAI;
    private modelName: string;
    private baseUrl: string;

    constructor(config?: AIConfig) {
        const apiKey = config?.apiKey;
        const baseUrl = config?.baseUrl;

        if (!apiKey) {
            throw new Error("AI_AUTH_ERROR: GOOGLE_API_KEY is required for Gemini provider");
        }

        // 使用 httpOptions.baseUrl 来配置自定义 API 地址，避免全局 setDefaultBaseUrls 的竞态条件
        // 参考：@google/genai 的 GoogleGenAIOptions.httpOptions.baseUrl
        this.ai = new GoogleGenAI({
            apiKey,
            httpOptions: baseUrl ? {
                baseUrl: baseUrl
            } : undefined
        });

        this.modelName = config?.model || 'gemini-2.0-flash';
        this.baseUrl = baseUrl || 'https://generativelanguage.googleapis.com';

        logger.info({
            provider: 'Gemini',
            model: this.modelName,
            baseUrl: this.baseUrl,
        }, 'AI Provider initialized');
    }

    private async retryOperation<T>(operation: () => Promise<T>, maxRetries: number = 3): Promise<T> {
        let lastError: unknown;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                const msg = error instanceof Error ? error.message.toLowerCase() : String(error);

                // Identify retryable errors
                const isRetryable =
                    msg.includes('fetch failed') ||
                    msg.includes('network') ||
                    msg.includes('connect') ||
                    msg.includes('503') ||
                    msg.includes('502') ||  // Bad Gateway
                    msg.includes('504') ||  // Gateway Timeout
                    msg.includes('overloaded') ||
                    msg.includes('timeout') ||
                    msg.includes('etimedout') ||  // Connection timeout
                    msg.includes('enotfound') ||  // DNS resolution failed
                    msg.includes('econnreset') ||
                    msg.includes('econnrefused') ||  // Connection refused
                    msg.includes('unavailable');

                // 总时限已到时不再重试
                if (!isRetryable || attempt === maxRetries || isAiDeadlineExceeded()) {
                    throw error;
                }

                const delay = Math.pow(2, attempt - 1) * 1000; // Exponential backoff: 1s, 2s, 4s
                logger.warn({ attempt, maxRetries, error: msg, nextRetryDelayMs: delay }, 'Gemini operation failed, retrying...');
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        throw lastError;
    }

    private extractTag(text: string, tagName: string): string | null {
        return extractXmlTag(text, tagName);
    }

    private parseResponse(text: string): ParsedQuestion {
        return parseQuestionXml(text);
    }

    private async generateWithRetry(
        systemInstruction: string,
        contents: GeminiContent,
        initialMaxTokens: number = getInitialMaxTokens(this.modelName),
    ) {
        const result = await withTruncationRetry(async (maxOutputTokens) => {
            const raw = await this.retryOperation(() => this.ai.models.generateContent({
                model: this.modelName,
                config: { systemInstruction, maxOutputTokens },
                contents,
            }));
            const text = raw.text || '';
            const rawReason = raw.candidates?.[0]?.finishReason;
            const finishReason = rawReason === 'MAX_TOKENS' ? 'length' : rawReason;
            return {
                raw,
                text,
                choices: [{ finish_reason: finishReason, message: { content: text } }],
            };
        }, initialMaxTokens, () => logger.warn('Output truncated by reasoning, retrying with larger max_tokens'), this.modelName);

        if (!result.text) {
            throw new Error('Empty response from AI');
        }
        return result;
    }

    async analyzeImage(imageBase64: string, mimeType: string = "image/jpeg", language: 'zh' | 'en' = 'zh', grade?: GradeLevel | null, subject?: string | null, gradeSemester?: string | null, candidateTags?: CandidateTags): Promise<AnalyzeImageResult> {
        const config = getAppConfig();

        // 有错题本学段 + 学科时直接使用其全部知识点，否则按学科、年级取标签
        const tagOptions = candidateTags ? { candidateTags } : await prefetchSubjectTags(subject, grade);

        const prompt = generateAnalyzeRequest(language, grade, subject, {
            customTemplate: config.prompts?.analyze,
            ...tagOptions,
        }, gradeSemester);

        logger.box('🔍 AI Image Analysis Request', {
            provider: 'Gemini',
            endpoint: `${this.baseUrl}/v1beta/models/${this.modelName}:generateContent`,
            imageSize: `${imageBase64.length} bytes`,
            mimeType,
            model: this.modelName,
            language,
            grade: grade || 'all'
        });
        logger.box('📝 Full Prompt', prompt.system);

        try {
            // 构建请求参数（用于日志显示）
            const requestParamsForLog = {
                model: this.modelName,
                contents: [
                    {
                        text: prompt.user
                    },
                    {
                        inlineData: {
                            data: `[...${imageBase64.length} bytes base64 data...]`,
                            mimeType: mimeType
                        }
                    }
                ]
            };

            logger.box('📤 API Request (发送给 AI 的原始请求)', JSON.stringify(requestParamsForLog, null, 2));

            const response = await this.generateWithRetry(
                prompt.system,
                [
                    { text: prompt.user },
                    { inlineData: { data: imageBase64, mimeType } },
                ],
                getInitialMaxTokens(this.modelName),
            );

            logger.box('📦 Full API Response Metadata', {
                usageMetadata: response.raw.usageMetadata
            });

            const text = response.text;

            logger.box('🤖 AI Raw Response', text);

            const parsed = parseAnalyzeResponse(text);
            const items = parsed.items.map((item) => normalizeAiQuestionTags(item, tagOptions));
            const parsedResult = toAnalyzeImageResult(items, parsed.failedCount);

            logger.box('✅ Parsed & Validated Result', JSON.stringify(parsedResult, null, 2));

            return parsedResult;

        } catch (error) {
            logger.box('❌ Error during AI analysis', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            this.handleError(error);
        }
    }

    async generateSimilarQuestion(originalQuestion: string, knowledgePoints: string[], language: 'zh' | 'en' = 'zh', difficulty: DifficultyLevel = 'medium', gradeSemester?: string | null, originalFigureSvg?: string | null): Promise<ParsedQuestion> {
        const config = getAppConfig();
        const prompt = generateSimilarQuestionRequest(language, originalQuestion, knowledgePoints, difficulty, {
            customTemplate: config.prompts?.similar,
            originalFigureSvg,
        }, gradeSemester);

        logger.box('🎯 Generate Similar Question Request', {
            provider: 'Gemini',
            endpoint: `${this.baseUrl}/v1beta/models/${this.modelName}:generateContent`,
            originalQuestion: originalQuestion.substring(0, 100) + '...',
            knowledgePoints: knowledgePoints.join(', '),
            difficulty,
            language
        });
        logger.box('📝 Full Prompt', prompt.system);

        try {
            const { text } = await this.generateWithRetry(prompt.system, prompt.user, getInitialMaxTokens(this.modelName));

            logger.box('🤖 AI Raw Response', text);

            const parsedResult = this.parseResponse(text);

            logger.box('✅ Parsed & Validated Result', JSON.stringify(parsedResult, null, 2));

            return normalizeGeneratedQuestion(parsedResult);

        } catch (error) {
            logger.box('❌ Error during question generation', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            this.handleError(error);
        }
    }


    async completeJson(request: { system: string; user: string }): Promise<StructuredCompletion> {
        try {
            const { raw, text } = await this.generateWithRetry(request.system, request.user, 4096);
            return parseJsonCompletion(text, usageFromGemini(raw.usageMetadata));
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during structured JSON completion');
            this.handleError(error);
        }
    }

    async reanswerQuestion(questionText: string, language: 'zh' | 'en' = 'zh', subject?: string | null, imageBase64?: string, gradeSemester?: string | null, candidateTags?: CandidateTags): Promise<ReanswerQuestionResult> {
        const { generateReanswerRequest } = await import('./prompt-requests');
        const prompt = generateReanswerRequest(language, questionText, subject, { candidateTags }, gradeSemester);

        logger.info({
            provider: 'Gemini',
            endpoint: `${this.baseUrl}/v1beta/models/${this.modelName}:generateContent`,
            questionLength: questionText.length,
            subject: subject || 'auto',
            hasImage: !!imageBase64
        }, 'Reanswer Question Request');
        logger.debug({ prompt }, 'Full prompt');

        try {
            // 根据是否有图片构建不同的请求内容
            let contents: GeminiContent;
            if (imageBase64) {
                // 移除 data:image/xxx;base64, 前缀（如果存在）
                const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
                contents = [
                    { text: prompt.user },
                    { inlineData: { mimeType: 'image/jpeg', data: base64Data } }
                ];
            } else {
                contents = prompt.user;
            }

            const { text } = await this.generateWithRetry(prompt.system, contents, getInitialMaxTokens(this.modelName));

            logger.debug({ rawResponse: text }, 'AI raw response');
            logger.info('Reanswer parsed successfully');

            return parseReanswerXml(text, candidateTags);

        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during reanswer');
            this.handleError(error);
        }
    }

    async analyzeForGeogebra(questionText: string, answerText: string, analysis: string, previousErrors?: string): Promise<GeogebraAnalysisResult> {
        const prompt = generateGeogebraRequest(questionText, answerText, analysis, previousErrors);

        logger.info({
            provider: 'Gemini',
            model: this.modelName,
            questionLength: questionText.length,
        }, 'GeoGebra Analysis Request');

        try {
            const { text } = await this.generateWithRetry(prompt.system, prompt.user, 4096);
            logger.debug({ rawResponse: text }, 'GeoGebra AI raw response');
            return parseGeogebraJson(text);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during GeoGebra analysis');
            this.handleError(error);
        }
    }

    async evaluateMastery(input: MasteryEvaluationInput): Promise<MasteryEvaluationResult> {
        const prompt = generateMasteryRequest(input);

        logger.info({
            provider: 'Gemini',
            historyCount: input.history.length,
        }, 'Mastery Evaluation Request');

        try {
            const { text } = await this.generateWithRetry(prompt.system, prompt.user, 4096);
            logger.debug({ rawResponse: text }, 'Mastery AI raw response');
            return parseMasteryEvaluation(text);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during mastery evaluation');
            this.handleError(error);
        }
    }

    async recognizeGrade(questionText: string): Promise<string | null> {
        const prompt = generateGradeRecognitionRequest(questionText);
        try {
            const { text } = await this.generateWithRetry(prompt.system, prompt.user, 1024);
            return parseGradeRecognition(text);
        } catch (error) {
            logger.error({ error }, '识别题目年级失败');
            this.handleError(error);
        }
    }

    async gradeAnswer(input: AnswerGradingInput): Promise<AnswerGradingResult> {
        const prompt = generateGradingRequest(input);
        logger.info({ provider: 'Gemini' }, 'Answer Grading Request');

        try {
            const { text } = await this.generateWithRetry(prompt.system, prompt.user, 4096);
            logger.debug({ rawResponse: text }, 'Grading AI raw response');
            return parseAnswerGrading(text);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during answer grading');
            this.handleError(error);
        }
    }

    async readExamPaper(input: ExamPaperReadInput): Promise<ExamPaperReadResult> {
        const prompt = generateExamPaperReadRequest(input);
        logger.info({ provider: 'Gemini', mode: input.mode, pages: input.images.length }, 'Exam Paper Read Request');

        try {
            const { text } = await this.generateWithRetry(
                prompt.system,
                [
                    { text: prompt.user },
                    ...input.images.map((image) => ({ inlineData: { data: image.base64, mimeType: image.mimeType } })),
                ],
                getInitialMaxTokens(this.modelName),
            );
            logger.debug({ rawResponse: text }, 'Exam paper read AI raw response');
            return parseExamPaperByMode(input.mode, text, input.images.length);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during exam paper read');
            this.handleError(error);
        }
    }

    async suggestKnowledgeTags(input: TagSuggestionInput): Promise<TagSuggestionResult> {
        const prompt = generateTagSuggestRequest(input);

        logger.info({
            provider: 'Gemini',
            subject: input.subject,
            allowedTagCount: input.allowedTags.length,
        }, 'Tag Suggestion Request');

        try {
            const { text } = await this.generateWithRetry(prompt.system, prompt.user, 4096);
            logger.debug({ rawResponse: text }, 'Tag suggestion AI raw response');
            return parseTagSuggestion(text, input.allowedTags);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during tag suggestion');
            this.handleError(error);
        }
    }

    async generateFigureSvg(imageBase64: string, mimeType: string, questionText?: string | null): Promise<FigureResult> {
        const prompt = generateFigureRequest(questionText);
        logger.info({ provider: 'Gemini', model: this.modelName, imageSize: imageBase64.length }, 'Figure SVG Request');

        try {
            const { text } = await this.generateWithRetry(
                prompt.system,
                [
                    { text: prompt.user },
                    { inlineData: { data: imageBase64, mimeType } },
                ],
                getInitialMaxTokens(this.modelName),
            );
            logger.debug({ rawResponse: text }, 'Figure SVG AI raw response');
            return parseFigure(this.extractTag(text, "has_figure"), this.extractTag(text, "figure_svg"));
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during figure SVG generation');
            this.handleError(error);
        }
    }

    async fixLatex(input: LatexFixInput): Promise<LatexFixResult> {
        const prompt = generateLatexFixRequest(input);
        logger.info({ provider: 'Gemini', model: this.modelName, fields: Object.keys(input) }, 'LaTeX Fix Request');

        try {
            const { text } = await this.generateWithRetry(prompt.system, [{ text: prompt.user }], getInitialMaxTokens(this.modelName));
            logger.debug({ rawResponse: text }, 'LaTeX fix AI raw response');
            return parseLatexFix(text, input);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during LaTeX fix');
            this.handleError(error);
        }
    }

    async generateSvgAnimation(questionText: string, answerText: string, analysis: string, figureSvg?: string | null, language: 'zh' | 'en' = 'zh'): Promise<string | null> {
        const prompt = generateSvgAnimationRequest(questionText, answerText, analysis, figureSvg, language);
        logger.info({ provider: 'Gemini', model: this.modelName, questionLength: questionText.length }, 'SVG Animation Request');

        try {
            const { text } = await this.generateWithRetry(prompt.system, [{ text: prompt.user }], 16384);
            logger.debug({ rawResponse: text }, 'SVG animation AI raw response');
            return sanitizeSvgAnimation(this.extractTag(text, "svg_animation") || text);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during SVG animation generation');
            this.handleError(error);
        }
    }

    async generateSvgNarration(questionText: string, answerText: string, analysis: string, svgAnimation: string, language: 'zh' | 'en' = 'zh'): Promise<NarrationSegment[] | null> {
        const prompt = generateSvgNarrationRequest(questionText, answerText, analysis, svgAnimation, language);
        logger.info({ provider: 'Gemini', model: this.modelName, svgLength: svgAnimation.length }, 'SVG Narration Request');

        try {
            const { text } = await this.generateWithRetry(prompt.system, [{ text: prompt.user }], 4096);
            logger.debug({ rawResponse: text }, 'SVG narration AI raw response');
            return parseNarration(this.extractTag(text, "narration") || text);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during SVG narration generation');
            this.handleError(error);
        }
    }

    private handleError(error: unknown): never {
        normalizeAiError(error, 'Gemini');
    }
}
