/**
 * 家长试卷结果汇总：对错统计、需确认题、错因与知识点，以及入库后的错题本分组。
 */
import { isLowConfidence, type ParentReviewVerdict } from "@/lib/parent-paper-review";

export interface ReviewCountSource {
    effectiveVerdict: ParentReviewVerdict;
    confidence: number;
    overrideVerdict?: ParentReviewVerdict | null;
    errorCause: string | null;
    knowledgePoints: string[];
}

export interface ParentPaperReviewSummary {
    total: number;
    correct: number;
    wrong: number;
    partial: number;
    needsConfirmation: number;
    errorCauses: string[];
    knowledgePoints: string[];
}

export interface ImportedNotebookCount {
    subjectId: string;
    subjectName: string;
    count: number;
}

export function summarizeParentPaperReview(questions: ReviewCountSource[]): ParentPaperReviewSummary {
    let correct = 0;
    let wrong = 0;
    let partial = 0;
    let needsConfirmation = 0;
    const errorCauses: string[] = [];
    const knowledgePoints: string[] = [];
    const seenCauses = new Set<string>();
    const seenPoints = new Set<string>();

    for (const question of questions) {
        if (question.effectiveVerdict === "correct") correct += 1;
        else if (question.effectiveVerdict === "partial") partial += 1;
        else wrong += 1;
        if (!question.overrideVerdict && isLowConfidence(question.confidence)) needsConfirmation += 1;
        const cause = question.errorCause?.trim();
        if (cause && !seenCauses.has(cause)) {
            seenCauses.add(cause);
            errorCauses.push(cause);
        }
        for (const point of question.knowledgePoints) {
            const name = point.trim();
            if (!name || seenPoints.has(name)) continue;
            seenPoints.add(name);
            knowledgePoints.push(name);
        }
    }

    return {
        total: questions.length,
        correct,
        wrong,
        partial,
        needsConfirmation,
        errorCauses,
        knowledgePoints,
    };
}

export function groupImportedNotebooks(
    items: Array<{ subjectId: string; subjectName: string }>,
): ImportedNotebookCount[] {
    const byId = new Map<string, ImportedNotebookCount>();
    for (const item of items) {
        const current = byId.get(item.subjectId);
        if (current) current.count += 1;
        else byId.set(item.subjectId, { subjectId: item.subjectId, subjectName: item.subjectName, count: 1 });
    }
    return [...byId.values()];
}
