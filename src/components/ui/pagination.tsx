"use client";

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { MAX_VISIBLE_PAGES } from "@/lib/constants/pagination";

export interface PaginationProps {
    page: number;
    totalPages: number;
    onPageChange: (page: number) => void;
    total?: number;
    pageSize?: number;
}

export function Pagination({
    page,
    totalPages,
    onPageChange,
    total,
    pageSize,
}: PaginationProps) {
    const { t } = useLanguage();

    if (totalPages <= 1) return null;

    const canGoPrev = page > 1;
    const canGoNext = page < totalPages;

    // 生成页码按钮（最多显示 MAX_VISIBLE_PAGES 个）
    const getPageNumbers = () => {
        const pages: (number | "ellipsis")[] = [];

        if (totalPages <= MAX_VISIBLE_PAGES) {
            for (let i = 1; i <= totalPages; i++) pages.push(i);
        } else {
            pages.push(1);
            if (page > 3) pages.push("ellipsis");

            const start = Math.max(2, page - 1);
            const end = Math.min(totalPages - 1, page + 1);
            for (let i = start; i <= end; i++) pages.push(i);

            if (page < totalPages - 2) pages.push("ellipsis");
            pages.push(totalPages);
        }

        return pages;
    };

    const pageNumbers = getPageNumbers();
    const firstLabel = t.pagination?.first || "First page";
    const prevLabel = t.pagination?.prev || "Previous page";
    const nextLabel = t.pagination?.next || "Next page";
    const lastLabel = t.pagination?.last || "Last page";

    return (
        <nav
            aria-label={t.pagination?.navLabel || "Pagination"}
            className="flex flex-col items-center justify-between gap-4 py-4 sm:flex-row"
        >
            {total !== undefined && pageSize !== undefined && (
                <div className="order-2 text-sm tabular-nums text-muted-foreground sm:order-1" aria-live="polite">
                    {(t.pagination?.showing || "Showing {start}-{end} of {total}")
                        .replace("{start}", ((page - 1) * pageSize + 1).toString())
                        .replace("{end}", Math.min(page * pageSize, total).toString())
                        .replace("{total}", total.toString())}
                </div>
            )}
            <div className="order-1 flex items-center gap-1.5 sm:order-2">
                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => onPageChange(1)}
                    disabled={!canGoPrev}
                    aria-label={firstLabel}
                    title={firstLabel}
                >
                    <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
                </Button>

                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => onPageChange(page - 1)}
                    disabled={!canGoPrev}
                    aria-label={prevLabel}
                    title={prevLabel}
                >
                    <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </Button>

                <div className="hidden items-center gap-1 sm:flex">
                    {pageNumbers.map((pageNum, idx) =>
                        pageNum === "ellipsis" ? (
                            <span
                                key={`ellipsis-${idx}`}
                                aria-hidden="true"
                                className="px-2 text-muted-foreground select-none"
                            >
                                …
                            </span>
                        ) : (
                            <Button
                                key={pageNum}
                                type="button"
                                variant={pageNum === page ? "default" : "outline"}
                                size="icon"
                                className="h-9 w-9 tabular-nums"
                                aria-current={pageNum === page ? "page" : undefined}
                                aria-label={(t.pagination?.pageNumber || "Page {page}").replace(
                                    "{page}",
                                    pageNum.toString()
                                )}
                                onClick={() => onPageChange(pageNum)}
                            >
                                {pageNum}
                            </Button>
                        )
                    )}
                </div>

                <span className="px-2.5 text-sm font-medium tabular-nums sm:hidden" aria-live="polite">
                    {page} / {totalPages}
                </span>

                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => onPageChange(page + 1)}
                    disabled={!canGoNext}
                    aria-label={nextLabel}
                    title={nextLabel}
                >
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Button>

                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => onPageChange(totalPages)}
                    disabled={!canGoNext}
                    aria-label={lastLabel}
                    title={lastLabel}
                >
                    <ChevronsRight className="h-4 w-4" aria-hidden="true" />
                </Button>
            </div>
        </nav>
    );
}
