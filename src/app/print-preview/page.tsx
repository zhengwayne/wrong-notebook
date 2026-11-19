"use client";

import { useEffect, useState, Suspense, useRef } from "react";
import { flushSync } from "react-dom";
import { useSearchParams } from "next/navigation";
import { ErrorState } from "@/components/ui/error-state";
import { Pagination } from "@/components/ui/pagination";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { PrintItemPicker } from "@/components/print-preview/print-item-picker";
import { PrintOptions, type PrintDisplayOptions } from "@/components/print-preview/print-options";
import { PrintableQuestion } from "@/components/print-preview/printable-question";
import { apiClient } from "@/lib/api-client";
import type { PaginatedResponse, PrintableErrorItem } from "@/types/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { usePageTitle } from "@/lib/page-title";
import { PRINT_PREVIEW_PAGE_SIZE } from "@/lib/constants/pagination";
import { frontendLogger } from "@/lib/frontend-logger";
import {
    getPrintPreviewCountLabel,
    getPrintPreviewEmptyState,
    getSelectedPrintItems,
    shouldReserveAnswerSpace,
} from "@/lib/print-preview";

const PRINT_IMAGE_BATCH_SIZE = 20;

function PrintPreviewContent() {
    const query = useSearchParams().toString();
    return <PrintPreviewResults key={query} query={query} />;
}

function PrintPreviewResults({ query }: { query: string }) {
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const { t } = useLanguage();
    const [items, setItems] = useState<PrintableErrorItem[]>([]);
    usePageTitle(t.printPreview.title);
    const [loading, setLoading] = useState(true);
    const [options, setOptions] = useState<PrintDisplayOptions>({
        showQuestionText: false,
        showAnswers: false,
        showAnalysis: false,
        showTags: false,
        showOriginalImage: true,
        imageScale: 70,
    });
    const updateOptions = (patch: Partial<PrintDisplayOptions>) => setOptions((prev) => ({ ...prev, ...patch }));
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [visibleImageLimit, setVisibleImageLimit] = useState(PRINT_IMAGE_BATCH_SIZE);
    const loadMoreAnchorRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        let active = true;
        const params = new URLSearchParams(query);
        params.set("page", String(page));
        params.set("pageSize", String(PRINT_PREVIEW_PAGE_SIZE));
        params.set("view", "print");
        apiClient.get<PaginatedResponse<PrintableErrorItem>>(`/api/error-items/list?${params}`)
            .then(response => {
                if (!active) return;
                const lastPage = Math.max(1, response.totalPages);
                if (page > lastPage) {
                    setPage(lastPage);
                    return;
                }
                setItems(response.items);
                setSelectedIds(new Set(response.items.map(item => item.id)));
                setTotal(response.total);
                setLoading(false);
            })
            .catch(error => {
                if (!active) return;
                frontendLogger.error('[PrintPreview]', 'Failed to fetch items', { error });
                setFailed(true);
                setLoading(false);
            });
        return () => { active = false; };
    }, [query, page, attempt]);

    useEffect(() => {
        const expandAll = () => flushSync(() => setVisibleImageLimit(Number.POSITIVE_INFINITY));
        window.addEventListener("beforeprint", expandAll);
        return () => window.removeEventListener("beforeprint", expandAll);
    }, []);

    const selectedItems = getSelectedPrintItems(items, selectedIds);

    useEffect(() => {
        if (visibleImageLimit >= selectedItems.length) return;
        const anchor = loadMoreAnchorRef.current;
        if (!anchor || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                setVisibleImageLimit((limit) => Math.min(selectedItems.length, limit + PRINT_IMAGE_BATCH_SIZE));
            }
        }, { rootMargin: "400px" });
        observer.observe(anchor);
        return () => observer.disconnect();
    }, [visibleImageLimit, selectedItems.length]);

    const handlePrint = () => {
        flushSync(() => setVisibleImageLimit(Number.POSITIVE_INFINITY));
        window.print();
    };
    const reserveAnswerSpace = shouldReserveAnswerSpace(options.showAnswers, options.showAnalysis);
    const countLabel = getPrintPreviewCountLabel(items.length, selectedItems.length);
    const emptyState = getPrintPreviewEmptyState(items.length, selectedItems.length);

    const toggleSelectedItem = (id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const selectAllItems = () => {
        setSelectedIds(new Set(items.map((item) => item.id)));
    };

    const clearSelectedItems = () => {
        setSelectedIds(new Set());
    };

    if (failed) {
        return <ErrorState onRetry={() => {
            setLoading(true);
            setFailed(false);
            setAttempt(value => value + 1);
        }} />;
    }

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <p className="text-muted-foreground">{t.common.loading}</p>
            </div>
        );
    }

    return (
        <>
            {/* Print Controls - Hidden when printing */}
            <div className="print:hidden sticky top-0 z-10 bg-background border-b p-3 sm:p-4 shadow-sm">
                <div className="max-w-6xl mx-auto space-y-3">
                    {/* Header Row */}
                    <div className="flex items-center gap-3">
                        <BackButton fallbackUrl="/notebooks" />
                        <h1 className="text-lg sm:text-xl font-bold flex-1">
                            {t.printPreview?.title || 'Print Preview'} ({countLabel} {t.notebooks?.items || 'items'})
                        </h1>
                        <Button onClick={handlePrint} size="sm" className="whitespace-nowrap" disabled={selectedItems.length === 0}>
                            {t.printPreview?.printButton || 'Print / Save PDF'}
                        </Button>
                    </div>

                    <PrintOptions options={options} onChange={updateOptions} />
                    {total > PRINT_PREVIEW_PAGE_SIZE && (
                        <div className="space-y-1">
                            <p className="text-sm text-muted-foreground">{t.printPreview.batchHint}</p>
                            <Pagination
                                page={page}
                                totalPages={Math.ceil(total / PRINT_PREVIEW_PAGE_SIZE)}
                                total={total}
                                pageSize={PRINT_PREVIEW_PAGE_SIZE}
                                onPageChange={nextPage => {
                                    if (nextPage === page) return;
                                    setLoading(true);
                                    setItems([]);
                                    setSelectedIds(new Set());
                                    setVisibleImageLimit(PRINT_IMAGE_BATCH_SIZE);
                                    setPage(nextPage);
                                }}
                            />
                        </div>
                    )}
                    <PrintItemPicker
                        items={items}
                        selectedIds={selectedIds}
                        selectedCount={selectedItems.length}
                        onToggle={toggleSelectedItem}
                        onSelectAll={selectAllItems}
                        onClear={clearSelectedItems}
                    />
                </div>
            </div>

            {/* Print Content */}
            <main id="main-content" tabIndex={-1} className="max-w-4xl mx-auto p-8 print:p-0">
                {selectedItems.map((item, index) => (
                    <PrintableQuestion
                        key={item.id}
                        item={item}
                        index={index}
                        options={options}
                        reserveAnswerSpace={reserveAnswerSpace}
                        deferImage={index >= visibleImageLimit}
                    />
                ))}
                {visibleImageLimit < selectedItems.length && (
                    <div ref={loadMoreAnchorRef} className="h-4 print:hidden" aria-hidden="true" />
                )}

                {emptyState && (
                    <div className="text-center py-12 text-muted-foreground">
                        {emptyState === 'noSelection'
                            ? (t.printPreview?.noSelection || 'No items selected')
                            : (t.printPreview?.noItems || 'No matching error items')}
                    </div>
                )}
            </main>
        </>
    );
}

export default function PrintPreviewPage() {
    const { t } = useLanguage();
    return (
        <Suspense fallback={<div className="min-h-screen flex items-center justify-center">{t.common.loading}</div>}>
            <PrintPreviewContent />
        </Suspense>
    );
}
