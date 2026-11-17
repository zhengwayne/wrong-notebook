"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Camera, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { PageLoading } from "@/components/ui/page-loading";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { withChildParam } from "@/lib/current-child";
import { getApiErrorMessage } from "@/lib/error-message";
import { frontendLogger } from "@/lib/frontend-logger";
import { useCurrentChild } from "@/lib/use-current-child";
import { usePageTitle } from "@/lib/page-title";

interface PaperSummary {
    id: string;
    learnerId: string;
    learnerName: string;
    title: string | null;
    status: string;
    pageCount: number;
    createdAt: string;
}

export default function ParentPapersPage() {
    const { t, language } = useLanguage();
    const copy = t.parentPapers;
    const { learnerId, childName, hrefWithChild } = useCurrentChild();
    usePageTitle(t.pageTitle.parentPapers);
    const [papers, setPapers] = useState<PaperSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (id: string) => {
        setError(null);
        try {
            const data = await apiClient.get<{ papers: PaperSummary[] }>(`/api/parent/papers?learnerId=${encodeURIComponent(id)}`);
            setPapers(data.papers);
        } catch (err) {
            frontendLogger.error("[ParentPapers]", "Failed to list papers", { error: err });
            setError(getApiErrorMessage(err) || copy.loadError);
            setPapers([]);
        }
    }, [copy.loadError]);

    useEffect(() => {
        if (!learnerId) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 进入页面或切换孩子时拉取卷子列表
        void load(learnerId);
    }, [learnerId, load]);

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

    if (!papers && !error) return <PageLoading />;

    const dateLabel = (value: string) => new Date(value).toLocaleString(language === "en" ? "en" : "zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

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

                {!papers?.length ? (
                    <EmptyState icon={FileText} title={copy.empty} description={copy.emptyHint} />
                ) : (
                    <ul className="space-y-3">
                        {papers.map((paper) => (
                            <li key={paper.id} className="rounded-2xl border border-border bg-card p-4">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="truncate font-semibold">{paper.title || copy.untitled}</div>
                                        <p className="mt-1 text-sm text-muted-foreground">
                                            {dateLabel(paper.createdAt)}
                                            {" · "}
                                            {copy.pageCount.replace("{count}", String(paper.pageCount))}
                                        </p>
                                    </div>
                                    <span className="shrink-0 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                                        {copy.pendingRecognition}
                                    </span>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </PageContainer>
    );
}
