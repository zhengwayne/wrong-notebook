/**
 * 变式题与原题、已练习题、本轮已生成题的重复检测，复用题干相似度算法。
 */
import { DEFAULT_QUESTION_DUPLICATE_THRESHOLD, duplicateQuestionSimilarity } from '@/lib/question-similarity';

export interface DedupCandidate {
    id: string;
    text: string;
    /** original 原题；practice 已练习/已生成；batch 本轮其它变式 */
    kind: 'original' | 'practice' | 'batch';
}

export interface DedupResult {
    tooSimilar: boolean;
    similarity: number | null;
    similarTo: string | null;
}

export const DEFAULT_VARIANT_SIMILARITY_THRESHOLD = DEFAULT_QUESTION_DUPLICATE_THRESHOLD;

/** 与候选题干比较，取超过阈值的最高相似度；超过则视为过近，应拒题或重生成 */
export function checkVariantSimilarity(
    questionText: string,
    candidates: DedupCandidate[],
    threshold = DEFAULT_VARIANT_SIMILARITY_THRESHOLD,
): DedupResult {
    const text = questionText.trim();
    if (!text) return { tooSimilar: false, similarity: null, similarTo: null };
    let best: DedupResult = { tooSimilar: false, similarity: null, similarTo: null };
    for (const candidate of candidates) {
        if (!candidate.text.trim()) continue;
        const similarity = duplicateQuestionSimilarity(text, candidate.text, threshold);
        if (similarity === null) continue;
        if (best.similarity === null || similarity > best.similarity) {
            best = { tooSimilar: true, similarity, similarTo: `${candidate.kind}:${candidate.id}` };
            if (similarity === 1) return best;
        }
    }
    return best;
}

export function toDedupCandidates(
    original: { id?: string | null; text?: string | null } | null,
    practiced: Array<{ id: string; text: string | null | undefined }>,
    batch: Array<{ id: string; text: string | null | undefined }> = [],
): DedupCandidate[] {
    const candidates: DedupCandidate[] = [];
    if (original?.text?.trim()) {
        candidates.push({ id: original.id || 'original', text: original.text, kind: 'original' });
    }
    for (const item of practiced) {
        if (item.text?.trim()) candidates.push({ id: item.id, text: item.text, kind: 'practice' });
    }
    for (const item of batch) {
        if (item.text?.trim()) candidates.push({ id: item.id, text: item.text, kind: 'batch' });
    }
    return candidates;
}
