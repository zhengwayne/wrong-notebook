"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarCheck, RefreshCw } from "lucide-react";
import { ErrorItemCard } from "@/components/error-list/error-item-card";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTimeZone } from "@/contexts/TimeZoneContext";
import { apiClient } from "@/lib/api-client";
import { DEFAULT_PAGE_SIZE } from "@/lib/constants/pagination";
import { formatDateTime, getDayRange } from "@/lib/date-time";
import { getApiErrorMessage } from "@/lib/error-message";
import { frontendLogger } from "@/lib/frontend-logger";
import { usePageTitle } from "@/lib/page-title";
import { REVIEW_INTERVALS } from "@/lib/review-schedule";
import type { DueReviewItem, PaginatedResponse } from "@/types/api";

export default function ReviewPage() {
    const router = useRouter();
    const { t } = useLanguage();
    const { timeZone } = useTimeZone();
    usePageTitle(t.review.title);
    const [data, setData] = useState<PaginatedResponse<DueReviewItem> | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [page, setPage] = useState(1);
    const requestSeqRef = useRef(0);

    const fetchDue = useCallback(async (targetPage: number) => {
        const seq = ++requestSeqRef.current;
        setLoading(true);
        setError(null);
        try {
            const response = await apiClient.get<PaginatedResponse<DueReviewItem>>(
                `/api/review/due?page=${targetPage}&pageSize=${DEFAULT_PAGE_SIZE}`
            );
            if (seq !== requestSeqRef.current) return;
            setData(response);
        } catch (err) {
            if (seq !== requestSeqRef.current) return;
            frontendLogger.error("[Review]", "Failed to fetch due reviews", { error: err });
            setError(getApiErrorMessage(err) || t.common.loadErrorDesc);
        } finally {
            if (seq === requestSeqRef.current) {
                setLoading(false);
            }
        }
    }, [t.common.loadErrorDesc]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 数据请求：进入页面或翻页时拉取待复习题目并更新加载状态
        fetchDue(page);
    }, [page, fetchDue]);

    const todayStart = getDayRange(new Date(), timeZone).start;
    const dueLabel = (item: DueReviewItem) => {
        const date = formatDateTime(item.nextReviewAt, "MM/dd", timeZone);
        return new Date(item.nextReviewAt) < todayStart
            ? t.review.overdue.replace("{date}", date)
            : t.review.dueOn.replace("{date}", date);
    };

    const items = data?.items ?? [];

    return (
        <PageContainer className="space-y-6">
            <PageHeader
                title={t.review.title}
                description={t.review.desc}
                actions={
                    data && data.total > 0 && (
                        <span className="rounded-full border border-warning/35 bg-warning/15 px-3 py-1 text-sm font-semibold tabular-nums text-amber-800 dark:text-warning">
                            {t.review.dueCount.replace("{count}", String(data.total))}
                        </span>
                    )
                }
            />

            <AsyncBoundary
                loading={loading}
                error={error}
                hasData={items.length > 0}
                empty={!!data && data.total === 0}
                onRetry={() => fetchDue(page)}
                loadingLabel={t.common.loading}
                emptyFallback={
                    <EmptyState icon={CalendarCheck} title={t.review.empty} description={t.review.emptyHint} />
                }
            >
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {items.map((item) => (
                        <div key={item.id} className="flex flex-col gap-2.5">
                            <div className="flex-1">
                                <ErrorItemCard
                                    item={item}
                                    selectMode={false}
                                    selected={false}
                                    onToggleSelect={() => {}}
                                    selectedTag={null}
                                    onTagClick={() => {}}
                                />
                            </div>
                            <div className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-card/70 px-3 py-2 text-xs text-muted-foreground">
                                <span className="truncate tabular-nums">
                                    {dueLabel(item)} ·{" "}
                                    {t.review.round
                                        .replace("{round}", String(item.reviewStage + 1))
                                        .replace("{total}", String(REVIEW_INTERVALS.length))}
                                </span>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-8 shrink-0"
                                    onClick={() => router.push(`/practice?id=${item.id}`)}
                                >
                                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                                    {t.review.practice}
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            </AsyncBoundary>

            {data && (
                <Pagination
                    page={page}
                    totalPages={data.totalPages}
                    total={data.total}
                    pageSize={data.pageSize}
                    onPageChange={setPage}
                />
            )}
        </PageContainer>
    );
}
