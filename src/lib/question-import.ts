import { apiClient } from "@/lib/api-client";
import { processImageFile } from "@/lib/image-utils";
import type { ParsedQuestion } from "@/lib/ai";
import type { AnalyzeResponse, UserProfile } from "@/types/api";
import { reportLearningProgress } from "@/lib/onboarding-client";

/** 导入成功后的题目摘要 */
export interface ImportedQuestion {
    id: string;
    shortId: string | null;
    subjectId: string | null;
    notebookName: string | null;
    duplicate?: boolean;
    /** 单张图片解析出多道题时，全部已保存的题目列表 */
    savedItems?: ImportedQuestion[];
}

interface CreatedErrorItem {
    id: string;
    shortId?: string | null;
    subjectId?: string | null;
    subject?: { id: string; name: string } | null;
    duplicate?: boolean;
}

/** 读取用户的「导入前人工确认」偏好，读取失败时按默认值（不确认）处理 */
export async function fetchConfirmBeforeImport(): Promise<boolean> {
    try {
        const user = await apiClient.get<UserProfile>("/api/user");
        return !!user.confirmBeforeImport;
    } catch {
        return false;
    }
}

/** 调用 AI 识别一张图片中的题目 */
export async function analyzeQuestionImage(
    imageBase64: string,
    options: { language: 'zh' | 'en'; subjectId?: string | null; timeout?: number }
): Promise<AnalyzeResponse> {
    const data = await apiClient.post<AnalyzeResponse>("/api/analyze", {
        imageBase64,
        language: options.language,
        subjectId: options.subjectId || undefined,
    }, { timeout: options.timeout, recoverable: true });
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid API response: data is null or not an object');
    }
    return data;
}

/**
 * 将识别结果直接保存为错题；未指定错题本时由服务端按学科匹配或新建错题本
 */
export async function saveParsedQuestion(
    parsed: ParsedQuestion,
    options: { subjectId?: string | null; imageUrl?: string | null; learnerId?: string | null; provenanceId?: string | null }
): Promise<ImportedQuestion> {
    const provenanceId = options.provenanceId ?? (parsed as ParsedQuestion & { provenanceId?: string | null }).provenanceId;
    const created = await apiClient.post<CreatedErrorItem>("/api/error-items", {
        questionText: parsed.questionText,
        answerText: parsed.answerText,
        analysis: parsed.analysis,
        wrongAnswerText: parsed.wrongAnswerText || null,
        mistakeAnalysis: parsed.mistakeAnalysis || null,
        mistakeStatus: parsed.mistakeStatus || "unknown",
        knowledgePoints: parsed.knowledgePoints || [],
        difficultyStars: parsed.difficultyStars ?? null,
        recognizedGradeSemester: parsed.gradeSemester ?? null,
        hasFigure: parsed.hasFigure ?? false,
        figureSvg: parsed.figureSvg ?? null,
        subjectId: options.subjectId || undefined,
        subjectName: options.subjectId ? undefined : parsed.subject,
        originalImageUrl: options.imageUrl || "",
        learnerId: options.learnerId || undefined,
        ...(provenanceId ? { provenanceId } : {}),
    });
    reportLearningProgress("item", options.learnerId);
    return {
        id: created.id,
        shortId: created.shortId ?? null,
        subjectId: created.subjectId ?? null,
        notebookName: created.subject?.name ?? null,
        duplicate: created.duplicate,
    };
}

type SaveQuestionOptions = { subjectId?: string | null; imageUrl?: string | null; learnerId?: string | null; provenanceId?: string | null };

/** 识别完成但尚未全部保存的导入进度；重试时只补存未成功的题，不重新识别、不重复保存 */
export interface PendingQuestionImport {
    questions: ParsedQuestion[];
    saveOptions: SaveQuestionOptions;
    /** 与 questions 一一对应，已保存的题目为保存结果，未保存为 null */
    saved: Array<ImportedQuestion | null>;
}

/** 保存阶段有题目失败：已保存的题保留在 pending.saved 中，可用 resumeQuestionImport 只重试失败的题 */
export class PartialQuestionImportError extends Error {
    readonly pending: PendingQuestionImport;
    /** 首个失败请求的原始错误 */
    readonly original: unknown;
    /** 透传首个失败请求的后端错误体，便于界面按错误码翻译 */
    readonly data?: unknown;

    constructor(pending: PendingQuestionImport, cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = 'PartialQuestionImportError';
        this.pending = pending;
        this.original = cause;
        this.data = (cause as { data?: unknown } | null)?.data;
    }

    get savedCount(): number {
        return this.pending.saved.filter(Boolean).length;
    }

    get totalCount(): number {
        return this.pending.questions.length;
    }
}

async function saveRemainingQuestions(pending: PendingQuestionImport): Promise<ImportedQuestion> {
    let firstError: unknown = null;
    let hasError = false;
    for (let index = 0; index < pending.questions.length; index++) {
        if (pending.saved[index]) continue;
        try {
            pending.saved[index] = await saveParsedQuestion(pending.questions[index], pending.saveOptions);
        } catch (error) {
            // 逐题捕获：一题失败不影响其余题继续保存
            if (!hasError) firstError = error;
            hasError = true;
        }
    }
    if (hasError) {
        throw new PartialQuestionImportError(pending, firstError);
    }
    const savedItems = pending.saved as ImportedQuestion[];
    if (savedItems.length === 1) return savedItems[0];
    return { ...savedItems[0], savedItems };
}

/** 重试保存阶段失败的题目：只补存未成功的题，已保存的题不会重复写入 */
export function resumeQuestionImport(pending: PendingQuestionImport): Promise<ImportedQuestion> {
    return saveRemainingQuestions(pending);
}

/**
 * 压缩、识别并保存一张题目图片（批量导入时每个框调用一次；单图解析出多题时全部保存）。
 * 保存阶段失败时抛出 PartialQuestionImportError，调用方应改用 resumeQuestionImport 重试，避免重复题。
 */
export async function importQuestionImage(
    file: Blob,
    options: { language: 'zh' | 'en'; subjectId?: string | null; learnerId?: string | null; timeout?: number; onStage?: (stage: 'analyzing' | 'saving') => void }
): Promise<ImportedQuestion> {
    const imageBase64 = await processImageFile(file instanceof File ? file : new File([file], "question.jpg", { type: file.type || "image/jpeg" }));
    options.onStage?.('analyzing');
    const parsed = await analyzeQuestionImage(imageBase64, options);
    options.onStage?.('saving');
    const provenanceId = parsed.provenanceId ?? undefined;
    const questions = Array.isArray(parsed.items) && parsed.items.length > 0 ? parsed.items : [parsed];
    const saveOptions: SaveQuestionOptions = provenanceId
        ? { subjectId: options.subjectId, imageUrl: imageBase64, learnerId: options.learnerId, provenanceId }
        : { subjectId: options.subjectId, imageUrl: imageBase64, learnerId: options.learnerId };
    return saveRemainingQuestions({ questions, saveOptions, saved: questions.map(() => null) });
}
