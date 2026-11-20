"use client";

import { MarkdownRenderer } from "@/components/markdown-renderer";
import { Button } from "@/components/ui/button";
import { isLowConfidence, type ParentReviewVerdict } from "@/lib/parent-paper-review";
import { verdictButtonClass } from "@/lib/parent-paper-verdict-style";
import type { ParentPaperQuestionView } from "@/lib/parent-papers";

const VERDICTS: ParentReviewVerdict[] = ["correct", "partial", "wrong"];

export interface ParentPaperQuestionCardCopy {
    questionN: string;
    needsConfirm: string;
    confidence: string;
    locateOnPhoto: string;
    studentAnswer: string;
    correctAnswer: string;
    errorCause: string;
    knowledgePoints: string;
    override: string;
    verdictCorrect: string;
    verdictPartial: string;
    verdictWrong: string;
    selectForImport: string;
}

interface ParentPaperQuestionCardProps {
    question: ParentPaperQuestionView;
    copy: ParentPaperQuestionCardCopy;
    selected: boolean;
    canEdit: boolean;
    busy: boolean;
    onLocate: (questionId: string) => void;
    onPatch: (questionId: string, body: { overrideVerdict?: ParentReviewVerdict | null; selected?: boolean }) => void;
}

/**
 * 题目卡片本身不可点；只有「在照片中查看」会跳到试卷照片。
 * 点标记框高亮卡片由照片叠层负责，不经过这张卡片。
 */
export function ParentPaperQuestionCard({
    question,
    copy,
    selected,
    canEdit,
    busy,
    onLocate,
    onPatch,
}: ParentPaperQuestionCardProps) {
    const low = isLowConfidence(question.confidence);
    const verdictLabel = (verdict: ParentReviewVerdict) => {
        if (verdict === "correct") return copy.verdictCorrect;
        if (verdict === "partial") return copy.verdictPartial;
        return copy.verdictWrong;
    };

    return (
        <li
            id={`parent-paper-q-${question.id}`}
            data-testid="parent-paper-question-card"
            className={`space-y-3 rounded-2xl border bg-card p-4 ${selected ? "border-[#7c6bb5] ring-2 ring-[#c4b5fd]" : "border-border"}`}
        >
            <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 className="font-semibold">{copy.questionN.replace("{number}", question.number)}</h2>
                <div className="flex flex-wrap items-center gap-2">
                    {low && (
                        <span className="rounded-full border border-[#c4b5fd] bg-[#f5f3ff] px-2 py-0.5 text-xs font-medium text-[#6d28d9]">
                            {copy.needsConfirm}
                        </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                        {copy.confidence.replace("{value}", `${Math.round(question.confidence * 100)}%`)}
                    </span>
                    {question.bbox && (
                        <Button type="button" size="sm" variant="outline" onClick={() => onLocate(question.id)}>
                            {copy.locateOnPhoto}
                        </Button>
                    )}
                </div>
            </div>

            {question.questionText ? (
                <MarkdownRenderer content={question.questionText} className="text-sm" />
            ) : null}

            <section className="space-y-1">
                <h3 className="text-xs font-medium text-muted-foreground">{copy.studentAnswer}</h3>
                {question.studentAnswer ? (
                    <MarkdownRenderer content={question.studentAnswer} variant="compact" className="text-sm" />
                ) : (
                    <p className="text-sm text-muted-foreground">—</p>
                )}
            </section>

            <section className="space-y-1">
                <h3 className="text-xs font-medium text-muted-foreground">{copy.correctAnswer}</h3>
                {question.correctAnswer ? (
                    <MarkdownRenderer content={question.correctAnswer} variant="compact" className="text-sm" />
                ) : (
                    <p className="text-sm text-muted-foreground">—</p>
                )}
            </section>

            {question.errorCause && question.effectiveVerdict !== "correct" && (
                <section className="space-y-1">
                    <h3 className="text-xs font-medium text-muted-foreground">{copy.errorCause}</h3>
                    <MarkdownRenderer content={question.errorCause} variant="compact" className="text-sm" />
                </section>
            )}

            {question.knowledgePoints.length > 0 && (
                <p className="text-xs text-muted-foreground">
                    {copy.knowledgePoints}：{question.knowledgePoints.join("、")}
                </p>
            )}

            <div className="flex flex-wrap gap-2" role="group" aria-label={copy.override}>
                {VERDICTS.map((verdict) => {
                    const active = question.effectiveVerdict === verdict;
                    return (
                        <Button
                            key={verdict}
                            type="button"
                            size="sm"
                            variant="outline"
                            aria-pressed={active}
                            className={verdictButtonClass(verdict, active)}
                            disabled={!canEdit || busy}
                            onClick={() => onPatch(question.id, { overrideVerdict: verdict })}
                        >
                            {verdictLabel(verdict)}
                        </Button>
                    );
                })}
            </div>

            {canEdit && question.effectiveVerdict !== "correct" && (
                <label className="flex items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-border accent-[#7c6bb5]"
                        checked={question.selected}
                        disabled={busy}
                        onChange={(event) => onPatch(question.id, { selected: event.target.checked })}
                    />
                    {copy.selectForImport}
                </label>
            )}
        </li>
    );
}
