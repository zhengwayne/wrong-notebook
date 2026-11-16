/**
 * 解析识别接口返回的 XML：兼容单题旧格式，以及多题 <item> 包裹。
 */
import { parseRecognizedGrade } from "../question-grade";
import { normalizeMistakeStatusForSave } from "../mistake-status";
import { parseDifficultyStars, parseFigure } from "./schema";
import { safeParseParsedQuestion, type ParsedQuestionFromSchema } from "./schema";

export function extractXmlTag(text: string, tagName: string): string | null {
    const startTag = `<${tagName}>`;
    const endTag = `</${tagName}>`;
    const startIndex = text.indexOf(startTag);
    if (startIndex === -1) return null;
    const contentStart = startIndex + startTag.length;
    const endIndex = text.indexOf(endTag, contentStart);
    if (endIndex === -1) {
        if (tagName === "analysis") {
            return text.substring(contentStart).trim();
        }
        return null;
    }
    return text.substring(contentStart, endIndex).trim();
}

export function splitAnalyzeItems(text: string): string[] {
    const chunks: string[] = [];
    const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        const body = match[1]?.trim();
        if (body) chunks.push(body);
    }
    return chunks.length > 0 ? chunks : [text];
}


/** 填空括号里的下划线，允许中间夹杂空白或换行 */
const BLANK_PARENS = /[（(][ \t]*(_+(?:[ \t\n\r]+_+)*)[ \t\n\r]*[）)]/g;

/**
 * 整理识别得到的题干：把跨行的 ( ____ ) 收拢，并让大题标题单独成行、后面再跟题号。
 * 保留 <u> 等原样标记，只调整空白与换行。
 */
export function normalizeQuestionText(text: string): string {
    let out = text.replace(/\r\n/g, '\n');
    out = out.replace(BLANK_PARENS, (full, fills: string) => {
        const open = full.startsWith('（') ? '（' : '(';
        const close = full.endsWith('）') ? '）' : ')';
        const underscores = fills.replace(/\s+/g, '');
        return `${open} ${underscores} ${close}`;
    });
    // 标题后的填空括号另起一行：") ( ____ )"
    out = out.replace(/([）)])[ \t]+([（(] _)/g, '$1\n\n$2');
    // 标题或填空括号后紧跟题号时换行：")2.The" / ") 4.He"（两个换行才能在 Markdown 中分段）
    out = out.replace(/([）)])[ \t]*(\d+\.)/g, '$1\n\n$2');
    return out.replace(/[ \t]+\n/g, '\n').trim();
}

export function parseOneAnalyzeItem(text: string): ParsedQuestionFromSchema {
    const questionTextRaw = extractXmlTag(text, "question_text");
    const questionText = questionTextRaw ? normalizeQuestionText(questionTextRaw) : questionTextRaw;
    const answerText = extractXmlTag(text, "answer_text");
    const analysis = extractXmlTag(text, "analysis");
    if (!questionText || !answerText || !analysis) {
        throw new Error("Invalid AI response: Missing critical XML tags (<question_text>, <answer_text>, or <analysis>)");
    }

    const subjectRaw = extractXmlTag(text, "subject");
    const validSubjects: ParsedQuestionFromSchema["subject"][] = ["数学", "物理", "化学", "生物", "英语", "语文", "历史", "地理", "政治", "其他"];
    const subject = subjectRaw && (validSubjects as string[]).includes(subjectRaw)
        ? (subjectRaw as ParsedQuestionFromSchema["subject"])
        : "其他";

    const knowledgePointsRaw = extractXmlTag(text, "knowledge_points");
    const knowledgePoints = knowledgePointsRaw
        ? knowledgePointsRaw.split(/[,，\n]/).map((item) => item.trim()).filter((item) => item.length > 0)
        : [];

    const wrongAnswerText = extractXmlTag(text, "wrong_answer_text") || "";
    const mistakeAnalysis = extractXmlTag(text, "mistake_analysis") || "";
    const result: ParsedQuestionFromSchema = {
        questionText,
        answerText,
        analysis,
        wrongAnswerText,
        mistakeAnalysis,
        mistakeStatus: normalizeMistakeStatusForSave(extractXmlTag(text, "mistake_status"), wrongAnswerText),
        subject,
        knowledgePoints,
        requiresImage: extractXmlTag(text, "requires_image")?.toLowerCase().trim() === "true",
        gradeSemester: parseRecognizedGrade(extractXmlTag(text, "grade_semester")),
        difficultyStars: parseDifficultyStars(extractXmlTag(text, "difficulty_stars")),
        ...parseFigure(extractXmlTag(text, "has_figure"), extractXmlTag(text, "figure_svg")),
    };
    const validation = safeParseParsedQuestion(result);
    return validation.success ? validation.data : result;
}

export function parseAnalyzeResponse(text: string): ParsedQuestionFromSchema[] {
    const items: ParsedQuestionFromSchema[] = [];
    for (const chunk of splitAnalyzeItems(text)) {
        try {
            items.push(parseOneAnalyzeItem(chunk));
        } catch {
            // 某一条缺字段时跳过，只要还有能解析的题
        }
    }
    if (items.length === 0) {
        throw new Error("Invalid AI response: Missing critical XML tags (<question_text>, <answer_text>, or <analysis>)");
    }
    return items;
}

export type AnalyzeImageResult = ParsedQuestionFromSchema & { items: ParsedQuestionFromSchema[] };

export function toAnalyzeImageResult(items: ParsedQuestionFromSchema[]): AnalyzeImageResult {
    return { ...items[0], items };
}

/** 默认勾选：只保存 visibly 做错的题 */
export function defaultSelectedAnalyzeItems(items: ParsedQuestionFromSchema[]): boolean[] {
    const wrong = items.map((item) => item.mistakeStatus === "wrong_attempt");
    return wrong.some(Boolean) ? wrong : items.map(() => true);
}
