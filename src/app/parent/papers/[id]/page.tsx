"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { FileText } from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { PageLoading } from "@/components/ui/page-loading";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { getApiErrorMessage } from "@/lib/error-message";
import { toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import { ParentPaperOverlay } from "@/components/parent/parent-paper-overlay";
import { isLowConfidence, type ParentReviewVerdict, type QuestionBBox } from "@/lib/parent-paper-review";
import { PARENT_PAPER_STATUS, type ParentPaperQuestionView } from "@/lib/parent-papers";
import { parentPaperStatusClass, parentPaperStatusLabel } from "@/lib/parent-paper-status";
import { useCurrentChild } from "@/lib/use-current-child";
import { usePageTitle } from "@/lib/page-title";

interface PaperDetail {
    id: string;
    title: string | null;
    status: string;
    pageCount: number;
    questionCount: number;
    hasAnswerKey: boolean;
    correctCount: number | null;
    errorMessage: string | null;
    pages: Array<{ id: string; position: number; imageUrl: string }>;
    questions: ParentPaperQuestionView[];
}

const VERDICTS: ParentReviewVerdict[] = ["correct", "partial", "wrong"];

export default function ParentPaperReviewPage() {
    const { t, language } = useLanguage();
    const copy = t.parentPapers;
    const params = useParams<{ id: string }>();
    const paperId = params.id;
    const { hrefWithChild } = useCurrentChild();
    usePageTitle(copy.reviewTitle);
    const [paper, setPaper] = useState<PaperDetail | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<"recognize" | "confirm" | string | null>(null);
    const [activeQuestionId, setActiveQuestionId] = useState<string | null>(null);
    const [revealToken, setRevealToken] = useState(0);

    const load = useCallback(async (silent = false) => {
        if (!silent) setError(null);
        try {
            const data = await apiClient.get<PaperDetail>(`/api/parent/papers/${paperId}`);
            setPaper(data);
        } catch (err) {
            frontendLogger.error("[ParentPaperReview]", "Failed to load paper", { error: err });
            if (!silent) {
                setError(getApiErrorMessage(err) || copy.loadError);
                setPaper(null);
            }
        }
    }, [paperId, copy.loadError]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 进入页面时拉取试卷详情
        void load();
    }, [load]);

    useEffect(() => {
        if (paper?.status !== PARENT_PAPER_STATUS.recognizing) return;
        const timer = window.setInterval(() => { void load(true); }, 2000);
        return () => window.clearInterval(timer);
    }, [paper?.status, load]);

    const startRecognition = async () => {
        setBusy("recognize");
        try {
            const started = await apiClient.post<{ paper: PaperDetail }>(`/api/parent/papers/${paperId}/recognize`, { language });
            setPaper(started.paper);
        } catch (err) {
            frontendLogger.error("[ParentPaperReview]", "Failed to start recognition", { error: err });
            toast.error(getApiErrorMessage(err) || copy.recognizeError);
        } finally {
            setBusy(null);
        }
    };

    const patchQuestion = async (questionId: string, body: { overrideVerdict?: ParentReviewVerdict | null; selected?: boolean }) => {
        setBusy(questionId);
        try {
            const updated = await apiClient.patch<PaperDetail>(`/api/parent/papers/${paperId}/questions/${questionId}`, body);
            setPaper(updated);
        } catch (err) {
            frontendLogger.error("[ParentPaperReview]", "Failed to update question", { error: err });
            toast.error(getApiErrorMessage(err) || copy.saveError);
        } finally {
            setBusy(null);
        }
    };


    const selectQuestion = (questionId: string, from: "card" | "overlay") => {
        setActiveQuestionId(questionId);
        if (from === "card") setRevealToken((token) => token + 1);
        const target = from === "overlay" ? `parent-paper-q-${questionId}` : "parent-paper-overlay";
        window.requestAnimationFrame(() => {
            document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
    };

    const saveBbox = async (questionId: string, bbox: QuestionBBox) => {
        const updated = await apiClient.patch<PaperDetail>(`/api/parent/papers/${paperId}/questions/${questionId}`, { bbox });
        setPaper(updated);
    };

    const confirm = async () => {
        setBusy("confirm");
        try {
            const result = await apiClient.post<{ importedCount: number; paper: PaperDetail }>(`/api/parent/papers/${paperId}/confirm`, { language });
            setPaper(result.paper);
            toast.success(copy.importedCount.replace("{count}", String(result.importedCount)));
        } catch (err) {
            frontendLogger.error("[ParentPaperReview]", "Failed to confirm paper", { error: err });
            toast.error(getApiErrorMessage(err) || copy.confirmError);
        } finally {
            setBusy(null);
        }
    };

    if (!paper && !error) return <PageLoading />;

    if (!paper) {
        return (
            <PageContainer>
                <div className="mx-auto max-w-3xl space-y-6 py-6">
                    <PageHeader title={copy.reviewTitle} backHref={hrefWithChild("/parent/papers")} />
                    <p className="text-sm text-destructive">{error}</p>
                </div>
            </PageContainer>
        );
    }

    const verdictLabel = (verdict: ParentReviewVerdict) => {
        if (verdict === "correct") return copy.verdictCorrect;
        if (verdict === "partial") return copy.verdictPartial;
        return copy.verdictWrong;
    };

    const canEdit = paper.status === PARENT_PAPER_STATUS.pendingConfirmation;
    const canRecognize = paper.status === PARENT_PAPER_STATUS.pendingRecognition || paper.status === PARENT_PAPER_STATUS.failed;
    const selectedWrong = paper.questions.filter((question) => question.selected && question.effectiveVerdict !== "correct");

    return (
        <PageContainer>
            <div className="mx-auto max-w-3xl space-y-6 py-6">
                <PageHeader
                    title={paper.title || copy.untitled}
                    description={copy.reviewDesc}
                    backHref={hrefWithChild("/parent/papers")}
                    actions={
                        <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${parentPaperStatusClass(paper.status)}`}>
                            {parentPaperStatusLabel(copy, paper.status)}
                        </span>
                    }
                />

                {error && <p className="text-sm text-destructive">{error}</p>}

                {paper.hasAnswerKey && paper.correctCount != null ? (
                    <p className="text-sm text-muted-foreground">
                        {copy.correctCount
                            .replace("{correct}", String(paper.correctCount))
                            .replace("{total}", String(paper.questionCount))}
                    </p>
                ) : paper.status === PARENT_PAPER_STATUS.pendingConfirmation || paper.status === PARENT_PAPER_STATUS.confirmed ? (
                    <p className="text-sm text-muted-foreground">{copy.noScore}</p>
                ) : null}

                {paper.status === PARENT_PAPER_STATUS.recognizing && (
                    <p className="text-sm text-muted-foreground">{copy.recognizingHint}</p>
                )}
                {paper.status === PARENT_PAPER_STATUS.failed && (
                    <p className="text-sm text-destructive">{copy.failedHint}</p>
                )}
                {paper.status === PARENT_PAPER_STATUS.confirmed && (
                    <p className="text-sm text-muted-foreground">{copy.confirmedHint}</p>
                )}

                {canRecognize && (
                    <Button type="button" onClick={() => void startRecognition()} loading={busy === "recognize"} loadingText={copy.retrying}>
                        {paper.status === PARENT_PAPER_STATUS.failed ? copy.retry : copy.startRecognition}
                    </Button>
                )}

                {canEdit && !paper.questions.length && (
                    <EmptyState icon={FileText} title={copy.noQuestions} />
                )}

                {paper.pages.length > 0 && (paper.status === PARENT_PAPER_STATUS.pendingConfirmation || paper.status === PARENT_PAPER_STATUS.confirmed) ? (
                    <ParentPaperOverlay
                        title={paper.title || copy.untitled}
                        pages={paper.pages}
                        questions={paper.questions}
                        activeQuestionId={activeQuestionId}
                        revealToken={revealToken}
                        onSelectQuestion={(id) => selectQuestion(id, "overlay")}
                        canEdit={canEdit}
                        onSaveBbox={saveBbox}
                    />
                ) : null}

                <ul className="space-y-4">
                    {paper.questions.map((question) => {
                        const low = isLowConfidence(question.confidence);
                        const selected = question.id === activeQuestionId;
                        return (
                            <li
                                key={question.id}
                                id={`parent-paper-q-${question.id}`}
                                className={`space-y-3 rounded-2xl border bg-card p-4 ${selected ? "border-[#7c6bb5] ring-2 ring-[#c4b5fd]" : "border-border"}`}
                                onClick={() => selectQuestion(question.id, "card")}
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
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    selectQuestion(question.id, "card");
                                                }}
                                            >
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
                                                variant={active ? "default" : "outline"}
                                                disabled={!canEdit || busy === question.id}
                                                onClick={() => void patchQuestion(question.id, { overrideVerdict: verdict })}
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
                                            disabled={busy === question.id}
                                            onChange={(event) => void patchQuestion(question.id, { selected: event.target.checked })}
                                        />
                                        {copy.selectForImport}
                                    </label>
                                )}
                            </li>
                        );
                    })}
                </ul>

                {canEdit && (
                    <div className="space-y-2 pb-4">
                        {!selectedWrong.length && <p className="text-sm text-muted-foreground">{copy.confirmEmpty}</p>}
                        <Button
                            type="button"
                            size="lg"
                            className="w-full sm:w-auto"
                            onClick={() => void confirm()}
                            loading={busy === "confirm"}
                            loadingText={copy.confirming}
                        >
                            {copy.confirm}
                        </Button>
                    </div>
                )}
            </div>
        </PageContainer>
    );
}
