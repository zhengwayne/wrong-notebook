"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { Camera, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { PageLoading } from "@/components/ui/page-loading";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTimeZone } from "@/contexts/TimeZoneContext";
import { apiClient } from "@/lib/api-client";
import { withChildParam } from "@/lib/current-child";
import { getApiErrorMessage } from "@/lib/error-message";
import { frontendLogger } from "@/lib/frontend-logger";
import { PARENT_PAPER_STATUS } from "@/lib/parent-papers";
import { parentPaperStatusClass, parentPaperStatusLabel } from "@/lib/parent-paper-status";
import { useCurrentChild } from "@/lib/use-current-child";
import { usePageTitle } from "@/lib/page-title";

interface PaperSummary {
    id: string;
    learnerId: string;
    learnerName: string;
    title: string | null;
    subjectKey?: string | null;
    status: string;
    pageCount: number;
    questionCount?: number;
    hasAnswerKey?: boolean;
    correctCount?: number | null;
    errorMessage?: string | null;
    createdAt: string;
}

export default function ParentPapersPage() {
    const { t, language } = useLanguage();
    const copy = t.parentPapers;
    const { timeZone } = useTimeZone();
    const { learnerId, childName, hrefWithChild } = useCurrentChild();
    usePageTitle(t.pageTitle.parentPapers);
    const [papers, setPapers] = useState<PaperSummary[] | null>(null);
    const [loadedFor, setLoadedFor] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [retryingId, setRetryingId] = useState<string | null>(null);
    const requestSeqRef = useRef(0);
    // 独立记录孩子切换序号，避免 2 秒轮询刷新请求吞掉 retry() 的错误提示
    const learnerSwitchSeqRef = useRef(0);
    const activeLearnerRef = useRef<string | null>(learnerId);

    const load = useCallback(async (id: string, silent = false) => {
        const seq = ++requestSeqRef.current;
        if (!silent) setError(null);
        try {
            const data = await apiClient.get<{ papers: PaperSummary[] }>(`/api/parent/papers?learnerId=${encodeURIComponent(id)}`);
            if (seq !== requestSeqRef.current || activeLearnerRef.current !== id) return;
            setLoadedFor(id);
            setPapers(data.papers);
        } catch (err) {
            if (seq !== requestSeqRef.current || activeLearnerRef.current !== id) return;
            frontendLogger.error("[ParentPapers]", "Failed to list papers", { error: err });
            if (!silent) {
                setError(getApiErrorMessage(err) || copy.loadError);
                setLoadedFor(id);
                setPapers([]);
            }
        }
    }, [copy.loadError]);

    useEffect(() => {
        activeLearnerRef.current = learnerId;
        learnerSwitchSeqRef.current += 1;
        requestSeqRef.current += 1;
        // 切换孩子时立即清空旧娃试卷并作废在途请求与定时器回调，防止闪烁或旧数据覆盖
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 切换孩子时重置界面状态并拉取新孩子卷子列表
        setPapers(null);
        setLoadedFor(null);
        setError(null);
        setRetryingId(null);
        if (!learnerId) return;
        void load(learnerId);
        return () => {
            requestSeqRef.current += 1;
        };
    }, [learnerId, load]);

    useEffect(() => {
        if (!learnerId || loadedFor !== learnerId || !papers?.some((paper) => paper.status === PARENT_PAPER_STATUS.recognizing)) return;
        let cancelled = false;
        const timer = window.setInterval(() => {
            if (cancelled || activeLearnerRef.current !== learnerId) return;
            void load(learnerId, true);
        }, 2000);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, [learnerId, loadedFor, papers, load]);

    const retry = async (paperId: string, event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const targetLearnerId = learnerId;
        const switchSeqAtStart = learnerSwitchSeqRef.current;
        setRetryingId(paperId);
        try {
            await apiClient.post(`/api/parent/papers/${paperId}/recognize`, { language });
            if (targetLearnerId && activeLearnerRef.current === targetLearnerId && switchSeqAtStart === learnerSwitchSeqRef.current) {
                await load(targetLearnerId, true);
            }
        } catch (err) {
            if (activeLearnerRef.current === targetLearnerId && switchSeqAtStart === learnerSwitchSeqRef.current) {
                frontendLogger.error("[ParentPapers]", "Failed to retry recognition", { error: err });
                setError(getApiErrorMessage(err) || copy.recognizeError);
            }
        } finally {
            if (activeLearnerRef.current === targetLearnerId && switchSeqAtStart === learnerSwitchSeqRef.current) {
                setRetryingId(null);
            }
        }
    };

    if (!learnerId) {
        return (
            <PageContainer>
                <div className="mx-auto max-w-3xl space-y-6 py-6">
                    <PageHeader title={copy.title} description={copy.noChildHint} backHref="/parent" />
                    <EmptyState icon={FileText} title={copy.noChild} />
                </div>
            </PageContainer>
        );
    }

    const visiblePapers = loadedFor === learnerId ? papers : null;
    if (!visiblePapers && !error) return <PageLoading />;

    const dateLabel = (value: string) => new Date(value).toLocaleString(language === "en" ? "en" : "zh-CN", { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

    return (
        <PageContainer>
            <div className="mx-auto max-w-3xl space-y-6 py-6">
                <PageHeader
                    title={copy.title}
                    description={childName ? copy.forChild.replace("{name}", childName) : copy.desc}
                    backHref={hrefWithChild("/parent")}
                    actions={
                        <Button asChild>
                            <Link href={withChildParam("/parent/papers/new", learnerId)}>
                                <Camera className="h-4 w-4" aria-hidden="true" />
                                {copy.upload}
                            </Link>
                        </Button>
                    }
                />

                {error && <p className="text-sm text-destructive">{error}</p>}

                {!visiblePapers?.length ? (
                    <EmptyState icon={FileText} title={copy.empty} description={copy.emptyHint} />
                ) : (
                    <ul className="space-y-3">
                        {visiblePapers.map((paper) => (
                            <li key={paper.id}>
                                <Link
                                    href={withChildParam(`/parent/papers/${paper.id}`, learnerId)}
                                    className="block rounded-2xl border border-border bg-card p-4"
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="truncate font-semibold">{paper.title || copy.untitled}</div>
                                            <p className="mt-1 text-sm text-muted-foreground">
                                                {paper.subjectKey && t.tags.subjects[paper.subjectKey as keyof typeof t.tags.subjects]
                                                    ? `${t.tags.subjects[paper.subjectKey as keyof typeof t.tags.subjects]} · `
                                                    : ""}
                                                {dateLabel(paper.createdAt)}
                                                {" · "}
                                                {copy.pageCount.replace("{count}", String(paper.pageCount))}
                                                {paper.hasAnswerKey && paper.correctCount != null ? (
                                                    <>
                                                        {" · "}
                                                        {copy.correctCount
                                                            .replace("{correct}", String(paper.correctCount))
                                                            .replace("{total}", String(paper.questionCount ?? 0))}
                                                    </>
                                                ) : null}
                                            </p>
                                        </div>
                                        <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${parentPaperStatusClass(paper.status)}`}>
                                            {parentPaperStatusLabel(copy, paper.status)}
                                        </span>
                                    </div>
                                    {paper.status === PARENT_PAPER_STATUS.failed && (
                                        <div className="mt-3">
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                loading={retryingId === paper.id}
                                                loadingText={copy.retrying}
                                                onClick={(event) => void retry(paper.id, event)}
                                            >
                                                {copy.retry}
                                            </Button>
                                        </div>
                                    )}
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </PageContainer>
    );
}
