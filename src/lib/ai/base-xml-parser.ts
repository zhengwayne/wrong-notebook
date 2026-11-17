/**
 * 多 AI 提供商共享的 XML / GeoGebra 响应解析器。
 * 保证 Gemini / OpenAI / Azure / Anthropic 在标签提取、未闭合 <analysis> 兜底与字段规范化上完全一致。
 */
import { createLogger } from '../logger';
import { normalizeMistakeStatusForSave } from '../mistake-status';
import { parseRecognizedGrade } from '../question-grade';
import { normalizeAiQuestionTags } from './knowledge-points';
import {
    extractJsonObject,
    normalizeSubject,
    parseDifficultyStars,
    parseFigure,
    safeParseParsedQuestion,
} from './schema';
import type {
    CandidateTags,
    GeogebraAnalysisResult,
    ParsedQuestion,
    ReanswerQuestionResult,
} from './types';

const logger = createLogger('ai:parser');

/**
 * 提取 <tagName>…</tagName> 内容。
 * 当闭合标签因输出截断丢失时，若为最后的 <analysis> 标签则读取至末尾并记录告警。
 */
export function extractXmlTag(text: string, tagName: string): string | null {
    const startTag = `<${tagName}>`;
    const endTag = `</${tagName}>`;
    const startIndex = text.indexOf(startTag);
    if (startIndex === -1) {
        return null;
    }

    const contentStartIndex = startIndex + startTag.length;
    const endIndex = text.lastIndexOf(endTag);

    if (endIndex === -1 && tagName === 'analysis') {
        logger.warn({ tagName }, 'Tag was verified unclosed, treating as truncated and reading to end');
        return text.substring(contentStartIndex).trim();
    }

    if (endIndex === -1 || contentStartIndex >= endIndex) {
        return null;
    }

    return text.substring(contentStartIndex, endIndex).trim();
}

export function splitKnowledgePoints(raw: string | null | undefined): string[] {
    return (raw || '')
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

/** 解析单题 XML（用于举一反三、兼容解析等场景） */
export function parseQuestionXml(text: string): ParsedQuestion {
    logger.debug({ textLength: text.length }, 'Parsing AI response');

    const questionText = extractXmlTag(text, 'question_text');
    const answerText = extractXmlTag(text, 'answer_text');
    const analysis = extractXmlTag(text, 'analysis');
    if (!questionText || !answerText || !analysis) {
        logger.error({ rawTextLength: text.length }, 'Missing critical XML tags');
        throw new Error('Invalid AI response: Missing critical XML tags (<question_text>, <answer_text>, or <analysis>)');
    }

    const wrongAnswerText = extractXmlTag(text, 'wrong_answer_text') || '';
    const result: ParsedQuestion = {
        questionText,
        answerText,
        analysis,
        wrongAnswerText,
        mistakeAnalysis: extractXmlTag(text, 'mistake_analysis') || '',
        mistakeStatus: normalizeMistakeStatusForSave(extractXmlTag(text, 'mistake_status'), wrongAnswerText),
        subject: normalizeSubject(extractXmlTag(text, 'subject')) || '其他',
        knowledgePoints: splitKnowledgePoints(extractXmlTag(text, 'knowledge_points')),
        requiresImage: extractXmlTag(text, 'requires_image')?.toLowerCase().trim() === 'true',
        gradeSemester: parseRecognizedGrade(extractXmlTag(text, 'grade_semester')),
        difficultyStars: parseDifficultyStars(extractXmlTag(text, 'difficulty_stars')),
        ...parseFigure(extractXmlTag(text, 'has_figure'), extractXmlTag(text, 'figure_svg')),
    };

    const validation = safeParseParsedQuestion(result);
    if (validation.success) {
        logger.debug('Validated successfully via XML tags');
        return validation.data;
    }
    logger.warn({ validationError: validation.error.format() }, 'Schema validation warning');
    return result;
}

/** 解析重新解题 XML 响应，并按候选标签集过滤知识点 */
export function parseReanswerXml(text: string, candidateTags?: CandidateTags): ReanswerQuestionResult {
    const answerText = extractXmlTag(text, 'answer_text') || '';
    const analysis = extractXmlTag(text, 'analysis') || '';
    const knowledgePoints = splitKnowledgePoints(extractXmlTag(text, 'knowledge_points'));
    const wrongAnswerText = extractXmlTag(text, 'wrong_answer_text') || '';
    const mistakeAnalysis = extractXmlTag(text, 'mistake_analysis') || '';
    const mistakeStatus = normalizeMistakeStatusForSave(extractXmlTag(text, 'mistake_status'), wrongAnswerText);

    return normalizeAiQuestionTags(
        {
            answerText,
            analysis,
            knowledgePoints,
            wrongAnswerText,
            mistakeAnalysis,
            mistakeStatus,
            subject: normalizeSubject(extractXmlTag(text, 'subject')),
            gradeSemester: parseRecognizedGrade(extractXmlTag(text, 'grade_semester')),
            difficultyStars: parseDifficultyStars(extractXmlTag(text, 'difficulty_stars')),
        },
        { candidateTags },
    );
}

/** 解析 GeoGebra 分析 JSON 响应（复用 extractJsonObject 兼容 LaTeX 与代码块） */
export function parseGeogebraJson(text: string): GeogebraAnalysisResult {
    const parsed = extractJsonObject(text) as {
        suitable?: unknown;
        commands?: unknown;
        description?: unknown;
    };
    return {
        suitable: Boolean(parsed.suitable),
        commands: Array.isArray(parsed.commands) ? parsed.commands : [],
        description: typeof parsed.description === 'string' ? parsed.description : '',
    };
}
