import { AzureOpenAI } from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type { AIService, GradeLevel, ParsedQuestion, DifficultyLevel, ReanswerQuestionResult, GeogebraAnalysisResult, MasteryEvaluationInput, MasteryEvaluationResult, AnswerGradingInput, AnswerGradingResult, TagSuggestionInput, TagSuggestionResult, CandidateTags, AnalyzeExtraImage, FigureResult, StructuredCompletion, AnalyzeImageResult } from "./types";
import { parseJsonCompletion, usageFromOpenAi } from "./usage";
import { generateGradeRecognitionRequest, generateAnalyzeRequest, generateSimilarQuestionRequest, generateReanswerRequest, generateGeogebraRequest, generateMasteryRequest, generateGradingRequest, generateTagSuggestRequest, generateFigureRequest, generateSvgAnimationRequest, generateSvgNarrationRequest, generateLatexFixRequest } from './prompt-requests';
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
import { withTruncationRetry } from './truncation';
import { normalizeGeneratedQuestion } from './generated-question';
import { normalizeAiQuestionTags } from './knowledge-points';
import { parseAnalyzeResponse, toAnalyzeImageResult } from './parse-analyze';
import { getInitialMaxTokens } from './model-output-limits';
import { extractXmlTag, parseGeogebraJson, parseQuestionXml, parseReanswerXml } from './base-xml-parser';
import { currentAiDeadlineSignal, deadlineFetch } from './deadline';
import { normalizeAiError } from './error-normalizer';

const logger = createLogger('ai:azure');

type AzureUserContent = string | Array<
    { type: "text"; text: string } |
    { type: "image_url"; image_url: { url: string } }
>;

// Azure 配置接口
export interface AzureConfig {
    apiKey?: string;
    endpoint?: string;       // Azure 资源端点 (https://xxx.openai.azure.com)
    deploymentName?: string; // 部署名称
    apiVersion?: string;     // API 版本
    model?: string;          // 显示用模型名
}

export class AzureOpenAIProvider implements AIService {
    private client: AzureOpenAI;
    private model: string;
    private deployment: string;
    private endpoint: string;

    constructor(config?: AzureConfig) {
        const apiKey = config?.apiKey;
        const endpoint = config?.endpoint;
        const deployment = config?.deploymentName;

        if (!apiKey) {
            throw new Error("AI_AUTH_ERROR: AZURE_OPENAI_API_KEY is required for Azure OpenAI provider");
        }

        if (!endpoint) {
            throw new Error("AI_AUTH_ERROR: AZURE_OPENAI_ENDPOINT is required for Azure OpenAI provider");
        }

        if (!deployment) {
            throw new Error("AI_AUTH_ERROR: AZURE_OPENAI_DEPLOYMENT is required for Azure OpenAI provider");
        }

        this.client = new AzureOpenAI({
            apiKey: apiKey,
            endpoint: endpoint,
            deployment: deployment,
            apiVersion: config?.apiVersion || '2024-02-15-preview',
            fetch: deadlineFetch,
        });

        this.model = config?.model || deployment;
        this.deployment = deployment;
        this.endpoint = endpoint;

        logger.info({
            provider: 'Azure OpenAI',
            model: this.model,
            deployment: this.deployment,
            endpoint: endpoint,
        }, 'Azure AI Provider initialized');
    }

    private createChatCompletion(params: ChatCompletionCreateParamsNonStreaming) {
        const signal = currentAiDeadlineSignal();
        return signal
            ? this.client.chat.completions.create(params, { signal })
            : this.client.chat.completions.create(params);
    }

    private extractTag(text: string, tagName: string): string | null {
        return extractXmlTag(text, tagName);
    }

    private parseResponse(text: string): ParsedQuestion {
        return parseQuestionXml(text);
    }

    async analyzeImage(
        imageBase64: string,
        mimeType: string = 'image/jpeg',
        language: 'zh' | 'en' = 'zh',
        grade?: GradeLevel | null,
        subject?: string | null,
        gradeSemester?: string | null,
        candidateTags?: CandidateTags,
        extraImages: AnalyzeExtraImage[] = []
    ): Promise<AnalyzeImageResult> {
        const config = getAppConfig();

        // 有错题本学段 + 学科时直接使用其全部知识点，否则按学科、年级取标签
        const tagOptions = candidateTags ? { candidateTags } : await prefetchSubjectTags(subject, grade);
        const systemPrompt = generateAnalyzeRequest(language, grade, subject, {
            customTemplate: config.prompts?.analyze,
            ...tagOptions,
            pageCount: 1 + extraImages.length,
        }, gradeSemester);

        logger.box('🔍 AI Image Analysis Request', {
            provider: 'Azure OpenAI',
            endpoint: this.endpoint,
            imageSize: `${imageBase64.length} bytes`,
            mimeType,
            model: this.model,
            deployment: this.deployment,
            language,
            grade: grade || 'all'
        });
        logger.box('📝 Full System Prompt', systemPrompt.system);

        try {
            const response = await withTruncationRetry((maxTokens) => this.createChatCompletion({
                model: this.deployment,
                messages: [
                    {
                        role: "system",
                        content: systemPrompt.system,
                    },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: systemPrompt.user },
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:${mimeType};base64,${imageBase64}`,
                                },
                            },
                            ...extraImages.map((image) => ({ type: "image_url" as const, image_url: { url: `data:${image.mimeType};base64,${image.base64}` } })),
                        ],
                    },
                ],
                max_tokens: maxTokens,
            }), getInitialMaxTokens(this.model), () => logger.warn('Output truncated by reasoning, retrying with larger max_tokens'), this.model);

            logger.box('📦 Full API Response', JSON.stringify(response, null, 2));

            // 检查响应是否有效
            if (!response || !response.choices || response.choices.length === 0) {
                logger.error({ response: JSON.stringify(response) }, 'Invalid API response - no choices array');
                throw new Error("AI_RESPONSE_ERROR: API returned empty or invalid response");
            }

            const text = response.choices[0]?.message?.content || "";

            logger.box('🤖 AI Raw Response', text);

            if (!text) throw new Error("Empty response from AI");
            const parsed = parseAnalyzeResponse(text);
            const items = parsed.items.map((item) => normalizeAiQuestionTags(item, tagOptions));
            const parsedResult = toAnalyzeImageResult(items, parsed.failedCount, undefined, parsed.continuity);

            logger.box('✅ Parsed & Validated Result', JSON.stringify(parsedResult, null, 2));

            return parsedResult;

        } catch (error) {
            logger.box('❌ Error during AI analysis', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            this.handleError(error);
            throw error;
        }
    }

    async generateSimilarQuestion(
        originalQuestion: string,
        knowledgePoints: string[],
        language: 'zh' | 'en' = 'zh',
        difficulty: DifficultyLevel = 'medium',
        gradeSemester?: string | null,
        originalFigureSvg?: string | null
    ): Promise<ParsedQuestion> {
        const config = getAppConfig();
        const systemPrompt = generateSimilarQuestionRequest(language, originalQuestion, knowledgePoints, difficulty, {
            customTemplate: config.prompts?.similar,
            originalFigureSvg,
        }, gradeSemester);
        const userPrompt = systemPrompt.user;

        logger.box('🎯 Generate Similar Question Request', {
            provider: 'Azure OpenAI',
            endpoint: this.endpoint,
            model: this.model,
            deployment: this.deployment,
            originalQuestion: originalQuestion.substring(0, 100) + '...',
            knowledgePoints: knowledgePoints.join(', '),
            difficulty,
            language
        });
        logger.box('📝 System Prompt', systemPrompt.system);
        logger.box('📝 User Prompt', userPrompt);

        try {
            const response = await withTruncationRetry((maxTokens) => this.createChatCompletion({
                model: this.deployment,
                messages: [
                    {
                        role: "system",
                        content: systemPrompt.system,
                    },
                    {
                        role: "user",
                        content: userPrompt,
                    },
                ],
                max_tokens: maxTokens,
            }), getInitialMaxTokens(this.model), () => logger.warn('Output truncated by reasoning, retrying with larger max_tokens'), this.model);

            const text = response.choices[0]?.message?.content || "";

            logger.box('🤖 AI Raw Response', text);

            if (!text) throw new Error("Empty response from AI");
            const parsedResult = this.parseResponse(text);

            logger.box('✅ Parsed & Validated Result', JSON.stringify(parsedResult, null, 2));

            return normalizeGeneratedQuestion(parsedResult);

        } catch (error) {
            logger.box('❌ Error during similar question generation', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            this.handleError(error);
            throw error;
        }
    }


    async completeJson(request: { system: string; user: string }): Promise<StructuredCompletion> {
        try {
            const response = await withTruncationRetry((maxTokens) => this.createChatCompletion({
                model: this.deployment,
                messages: [
                    { role: "system", content: request.system },
                    { role: "user", content: request.user },
                ],
                max_tokens: maxTokens,
            }), 4096, () => logger.warn('Output truncated by reasoning, retrying with larger max_tokens'), this.model);
            const text = response.choices[0]?.message?.content || "";
            return parseJsonCompletion(text, usageFromOpenAi(response.usage));
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during structured JSON completion');
            this.handleError(error);
        }
    }

    async reanswerQuestion(
        questionText: string,
        language: 'zh' | 'en' = 'zh',
        subject?: string | null,
        imageBase64?: string,
        gradeSemester?: string | null,
        candidateTags?: CandidateTags
    ): Promise<ReanswerQuestionResult> {
        const prompt = generateReanswerRequest(language, questionText, subject, { candidateTags }, gradeSemester);

        logger.box('🔄 Reanswer Question Request', {
            provider: 'Azure OpenAI',
            endpoint: this.endpoint,
            model: this.model,
            deployment: this.deployment,
            questionLength: questionText.length,
            subject: subject || 'auto',
            hasImage: !!imageBase64
        });
        logger.debug({ prompt }, 'Full prompt');

        try {
            // 根据是否有图片构建不同的消息内容
            let userContent: AzureUserContent = prompt.user;
            if (imageBase64) {
                // 如果有图片，构建多模态消息
                const imageUrl = imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
                logger.debug({ imageLength: imageUrl.length }, 'Image added to request');
                userContent = [
                    { type: "text", text: prompt.user },
                    { type: "image_url", image_url: { url: imageUrl } }
                ];
            } else {
                logger.debug({ imageBase64Type: typeof imageBase64, hasValue: !!imageBase64 }, 'No image data');
            }

            const response = await withTruncationRetry((maxTokens) => this.createChatCompletion({
                model: this.deployment,
                messages: [
                    { role: "system", content: prompt.system },
                    { role: "user", content: userContent }
                ],
                max_tokens: maxTokens,
            }), getInitialMaxTokens(this.model), () => logger.warn('Output truncated by reasoning, retrying with larger max_tokens'), this.model);

            logger.debug({ response: JSON.stringify(response) }, 'Full API response');

            // 检查响应是否有效
            if (!response || !response.choices || response.choices.length === 0) {
                logger.error({ response: JSON.stringify(response) }, 'Invalid API response - no choices array');
                throw new Error("AI_RESPONSE_ERROR: API returned empty or invalid response");
            }

            const text = response.choices[0]?.message?.content || "";

            logger.debug({ rawResponse: text }, 'AI raw response');

            if (!text) throw new Error("Empty response from AI");

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
            provider: 'Azure OpenAI',
            model: this.model,
            deployment: this.deployment,
            questionLength: questionText.length,
        }, 'GeoGebra Analysis Request');

        try {
            const response = await withTruncationRetry((maxTokens) => this.createChatCompletion({
                model: this.deployment,
                messages: [
                    { role: "system", content: prompt.system },
                    { role: "user", content: prompt.user }
                ],
                max_tokens: maxTokens,
            }), 4096, () => logger.warn('Output truncated by reasoning, retrying with larger max_tokens'), this.model);

            const text = response.choices[0]?.message?.content || '';
            logger.debug({ rawResponse: text }, 'GeoGebra AI raw response');

            if (!text) throw new Error("Empty response from AI");
            return parseGeogebraJson(text);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during GeoGebra analysis');
            this.handleError(error);
        }
    }

    async evaluateMastery(input: MasteryEvaluationInput): Promise<MasteryEvaluationResult> {
        const prompt = generateMasteryRequest(input);

        logger.info({
            provider: 'Azure OpenAI',
            historyCount: input.history.length,
        }, 'Mastery Evaluation Request');

        try {
            const response = await withTruncationRetry((maxTokens) => this.createChatCompletion({
                model: this.deployment,
                messages: [
                    { role: "system", content: prompt.system },
                    { role: "user", content: prompt.user }
                ],
                max_tokens: maxTokens,
            }), 4096, () => logger.warn('Output truncated by reasoning, retrying with larger max_tokens'), this.model);

            const text = response.choices[0]?.message?.content || '';
            logger.debug({ rawResponse: text }, 'Mastery AI raw response');

            if (!text) throw new Error("Empty response from AI");
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
            const response = await withTruncationRetry((maxTokens) => this.createChatCompletion({
                model: this.deployment,
                messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
                max_tokens: maxTokens,
            }), 1024, () => logger.warn('年级识别输出截断，增加上限重试'), this.model);
            return parseGradeRecognition(response.choices[0]?.message?.content || '');
        } catch (error) {
            logger.error({ error }, '识别题目年级失败');
            this.handleError(error);
        }
    }

    async gradeAnswer(input: AnswerGradingInput): Promise<AnswerGradingResult> {
        const prompt = generateGradingRequest(input);
        logger.info({ provider: 'Azure OpenAI' }, 'Answer Grading Request');

        try {
            const response = await withTruncationRetry((maxTokens) => this.createChatCompletion({
                model: this.deployment,
                messages: [
                    { role: "system", content: prompt.system },
                    { role: "user", content: prompt.user }
                ],
                max_tokens: maxTokens,
            }), 4096, () => logger.warn('Output truncated by reasoning, retrying with larger max_tokens'), this.model);

            const text = response.choices[0]?.message?.content || '';
            logger.debug({ rawResponse: text }, 'Grading AI raw response');

            if (!text) throw new Error("Empty response from AI");
            return parseAnswerGrading(text);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during answer grading');
            this.handleError(error);
            throw error;
        }
    }

    async readExamPaper(input: ExamPaperReadInput): Promise<ExamPaperReadResult> {
        const prompt = generateExamPaperReadRequest(input);
        logger.info({ provider: 'Azure OpenAI', mode: input.mode, pages: input.images.length }, 'Exam Paper Read Request');

        try {
            const response = await withTruncationRetry((maxTokens) => this.createChatCompletion({
                model: this.deployment,
                messages: [
                    { role: "system", content: prompt.system },
                    { role: "user", content: [
                        ...input.images.map((image) => ({ type: "image_url" as const, image_url: { url: `data:${image.mimeType};base64,${image.base64}` } })),
                        { type: "text" as const, text: prompt.user },
                    ] },
                ],
                max_tokens: maxTokens,
            }), getInitialMaxTokens(this.model), () => logger.warn('Output truncated by reasoning, retrying with larger max_tokens'), this.model);

            const text = response.choices[0]?.message?.content || '';
            logger.debug({ rawResponse: text }, 'Exam paper read AI raw response');

            if (!text) throw new Error("Empty response from AI");
            return parseExamPaperByMode(input.mode, text, input.images.length);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during exam paper read');
            this.handleError(error);
            throw error;
        }
    }

    async suggestKnowledgeTags(input: TagSuggestionInput): Promise<TagSuggestionResult> {
        const prompt = generateTagSuggestRequest(input);

        logger.info({
            provider: 'Azure OpenAI',
            subject: input.subject,
            allowedTagCount: input.allowedTags.length,
        }, 'Tag Suggestion Request');

        try {
            const response = await withTruncationRetry((maxTokens) => this.createChatCompletion({
                model: this.deployment,
                messages: [
                    { role: "system", content: prompt.system },
                    { role: "user", content: prompt.user }
                ],
                max_tokens: maxTokens,
            }), 4096, () => logger.warn('Output truncated by reasoning, retrying with larger max_tokens'), this.model);

            const text = response.choices[0]?.message?.content || '';
            logger.debug({ rawResponse: text }, 'Tag suggestion AI raw response');

            if (!text) throw new Error("Empty response from AI");
            return parseTagSuggestion(text, input.allowedTags);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during tag suggestion');
            this.handleError(error);
            throw error;
        }
    }

    async generateFigureSvg(imageBase64: string, mimeType: string, questionText?: string | null): Promise<FigureResult> {
        const prompt = generateFigureRequest(questionText);
        logger.info({ provider: 'Azure OpenAI', deployment: this.deployment, imageSize: imageBase64.length }, 'Figure SVG Request');

        try {
            const response = await withTruncationRetry((maxTokens) => this.createChatCompletion({
                model: this.deployment,
                messages: [
                    { role: "system", content: prompt.system },
                    { role: "user", content: [{ type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } }, { type: "text", text: prompt.user }] },
                ],
                max_tokens: maxTokens,
            }), getInitialMaxTokens(this.model), () => logger.warn('Output truncated by reasoning, retrying with larger max_tokens'), this.model);

            const text = response.choices[0]?.message?.content || '';
            logger.debug({ rawResponse: text }, 'Figure SVG AI raw response');

            if (!text) throw new Error("Empty response from AI");
            return parseFigure(this.extractTag(text, "has_figure"), this.extractTag(text, "figure_svg"));
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during figure SVG generation');
            this.handleError(error);
            throw error;
        }
    }

    async fixLatex(input: LatexFixInput): Promise<LatexFixResult> {
        const prompt = generateLatexFixRequest(input);
        logger.info({ provider: 'Azure OpenAI', deployment: this.deployment, fields: Object.keys(input) }, 'LaTeX Fix Request');

        try {
            const response = await withTruncationRetry((maxTokens) => this.createChatCompletion({
                model: this.deployment,
                messages: [
                    { role: "system", content: prompt.system },
                    { role: "user", content: prompt.user },
                ],
                max_tokens: maxTokens,
            }), getInitialMaxTokens(this.model), () => logger.warn('Output truncated by reasoning, retrying with larger max_tokens'), this.model);

            const text = response.choices[0]?.message?.content || '';
            logger.debug({ rawResponse: text }, 'LaTeX fix AI raw response');

            if (!text) throw new Error("Empty response from AI");
            return parseLatexFix(text, input);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during LaTeX fix');
            this.handleError(error);
            throw error;
        }
    }

    async generateSvgAnimation(questionText: string, answerText: string, analysis: string, figureSvg?: string | null, language: 'zh' | 'en' = 'zh'): Promise<string | null> {
        const prompt = generateSvgAnimationRequest(questionText, answerText, analysis, figureSvg, language);
        logger.info({ provider: 'Azure OpenAI', deployment: this.deployment, questionLength: questionText.length }, 'SVG Animation Request');

        try {
            const response = await withTruncationRetry((maxTokens) => this.createChatCompletion({
                model: this.deployment,
                messages: [
                    { role: "system", content: prompt.system },
                    { role: "user", content: prompt.user },
                ],
                max_tokens: maxTokens,
            }), 16384, () => logger.warn('Output truncated by reasoning, retrying with larger max_tokens'), this.model);

            const text = response.choices[0]?.message?.content || '';
            logger.debug({ rawResponse: text }, 'SVG animation AI raw response');

            if (!text) throw new Error("Empty response from AI");
            return sanitizeSvgAnimation(this.extractTag(text, "svg_animation") || text);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during SVG animation generation');
            this.handleError(error);
            throw error;
        }
    }

    async generateSvgNarration(questionText: string, answerText: string, analysis: string, svgAnimation: string, language: 'zh' | 'en' = 'zh'): Promise<NarrationSegment[] | null> {
        const prompt = generateSvgNarrationRequest(questionText, answerText, analysis, svgAnimation, language);
        logger.info({ provider: 'Azure OpenAI', deployment: this.deployment, svgLength: svgAnimation.length }, 'SVG Narration Request');

        try {
            const response = await withTruncationRetry((maxTokens) => this.createChatCompletion({
                model: this.deployment,
                messages: [
                    { role: "system", content: prompt.system },
                    { role: "user", content: prompt.user },
                ],
                max_tokens: maxTokens,
            }), 4096, () => logger.warn('Output truncated by reasoning, retrying with larger max_tokens'), this.model);

            const text = response.choices[0]?.message?.content || '';
            logger.debug({ rawResponse: text }, 'SVG narration AI raw response');

            if (!text) throw new Error("Empty response from AI");
            return parseNarration(this.extractTag(text, "narration") || text);
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during SVG narration generation');
            this.handleError(error);
            throw error;
        }
    }

    private handleError(error: unknown): never {
        normalizeAiError(error, 'Azure OpenAI');
    }
}
