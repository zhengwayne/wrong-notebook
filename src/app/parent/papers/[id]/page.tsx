"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { FileText } from "lucide-react";
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
import { ParentPaperQuestionCard } from "@/components/parent/parent-paper-question-card";
import { ParentPaperResults } from "@/components/parent/parent-paper-results";
import { type ParentReviewVerdict, type QuestionBBox } from "@/lib/parent-paper-review";
import { PARENT_PAPER_STATUS, type ParentPaperQuestionView } from "@/lib/parent-papers";
import { summarizeParentPaperReview, type ImportedNotebookCount } from "@/lib/parent-paper-summary";
import { parentPaperStatusClass, parentPaperStatusLabel } from "@/lib/parent-paper-status";
import { useCurrentChild } from "@/lib/use-current-child";
import { usePageTitle } from "@/lib/page-title";
import { reportOnboardingStep } from "@/lib/onboarding-client";

interface PaperDetail {
    id: string;
    title: string | null;
    subjectKey?: string | null;
    status: string;
    pageCount: number;
    questionCount: number;
    hasAnswerKey: boolean;
    correctCount: number | null;
    errorMessage: string | null;
    pages: Array<{ id: string; position: number; imageUrl: string }>;
    questions: ParentPaperQuestionView[];
    importedNotebooks?: ImportedNotebookCount[];
}

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

    const rotatePage = async (pageIndex: number) => {
        const updated = await apiClient.post<PaperDetail>(`/api/parent/papers/${paperId}/rotate`, { pageIndex, degrees: 90 });
        setPaper(updated);
    };

    const confirm = async () => {
        setBusy("confirm");
        try {
            const result = await apiClient.post<{ importedCount: number; paper: PaperDetail }>(`/api/parent/papers/${paperId}/confirm`, { language });
            setPaper(result.paper);
            toast.success(copy.importedCount.replace("{count}", String(result.importedCount)));
            if (result.importedCount > 0) void reportOnboardingStep("parent", ["paper", "confirm"]);
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

    const canEdit = paper.status === PARENT_PAPER_STATUS.pendingConfirmation;
    const canRotate = paper.status !== PARENT_PAPER_STATUS.recognizing;
    const canRecognize = paper.status === PARENT_PAPER_STATUS.pendingRecognition || paper.status === PARENT_PAPER_STATUS.failed;
    const selectedWrong = paper.questions.filter((question) => question.selected && question.effectiveVerdict !== "correct");
    const reviewSummary = summarizeParentPaperReview(paper.questions);
    const showResults = paper.status === PARENT_PAPER_STATUS.pendingConfirmation || paper.status === PARENT_PAPER_STATUS.confirmed;
    const scoreLabel = paper.hasAnswerKey && paper.correctCount != null
        ? copy.correctCount.replace("{correct}", String(paper.correctCount)).replace("{total}", String(paper.questionCount))
        : null;
    const importedNotebooks = paper.importedNotebooks ?? [];
    const importedCount = importedNotebooks.reduce((sum, item) => sum + item.count, 0);

    return (
        <PageContainer className="pb-8">
            <div className="mx-auto max-w-3xl space-y-6 pb-[calc(7rem+env(safe-area-inset-bottom,0px))] md:pb-8">
                <PageHeader
                    title={paper.title || copy.untitled}
                    description={paper.subjectKey && t.tags.subjects[paper.subjectKey as keyof typeof t.tags.subjects]
                        ? `${t.tags.subjects[paper.subjectKey as keyof typeof t.tags.subjects]} · ${copy.reviewDesc}`
                        : copy.reviewDesc}
                    backHref={hrefWithChild("/parent/papers")}
                    actions={
                        <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${parentPaperStatusClass(paper.status)}`}>
                            {parentPaperStatusLabel(copy, paper.status)}
                        </span>
                    }
                />

                {error && <p className="text-sm text-destructive">{error}</p>}

                {paper.status === PARENT_PAPER_STATUS.recognizing && (
                    <p className="text-sm text-muted-foreground">{copy.recognizingHint}</p>
                )}
                {paper.status === PARENT_PAPER_STATUS.failed && (
                    <p className="text-sm text-destructive">{copy.failedHint}</p>
                )}

                {showResults && (
                    <ParentPaperResults
                        summary={reviewSummary}
                        hasAnswerKey={paper.hasAnswerKey}
                        scoreLabel={scoreLabel}
                        confirmed={paper.status === PARENT_PAPER_STATUS.confirmed}
                        importedNotebooks={importedNotebooks}
                        importedCount={importedCount}
                        hrefWithChild={hrefWithChild}
                    />
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
                        canRotate={canRotate}
                        onRotatePage={rotatePage}
                        onSaveBbox={saveBbox}
                    />
                ) : null}

                <ul className="space-y-4">
                    {paper.questions.map((question) => (
                        <ParentPaperQuestionCard
                            key={question.id}
                            question={question}
                            copy={copy}
                            selected={question.id === activeQuestionId}
                            canEdit={canEdit}
                            busy={busy === question.id}
                            onLocate={(id) => selectQuestion(id, "card")}
                            onPatch={(id, body) => void patchQuestion(id, body)}
                        />
                    ))}
                </ul>

                {canEdit && (
                    <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] z-30 space-y-2 rounded-2xl border border-border bg-card/95 p-3 md:static md:bottom-auto md:border-0 md:bg-transparent md:p-0">
                        {!selectedWrong.length && <p className="text-sm text-muted-foreground">{copy.confirmEmpty}</p>}
                        <Button
                            type="button"
                            size="lg"
                            className="w-full sm:w-auto"
                            onClick={() => void confirm()}
                            loading={busy === "confirm"}
                            loadingText={copy.confirming}
                        >
                            {selectedWrong.length
                                ? copy.confirmOneTap.replace("{count}", String(selectedWrong.length))
                                : copy.confirmNone}
                        </Button>
                    </div>
                )}
            </div>
        </PageContainer>
    );
}
