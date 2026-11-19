"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FilterX, GitCompareArrows, Inbox, ListChecks, Printer, SearchX } from "lucide-react";
import { ErrorItemCard } from "@/components/error-list/error-item-card";
import { FilterMenu } from "@/components/error-list/filter-menu";
import { PaperLevelFilter } from "@/components/error-list/paper-level-filter";
import { ErrorListSelectionBar } from "@/components/error-list-selection-bar";
import { KnowledgeFilter } from "@/components/knowledge-filter";
import { MoveToNotebookDialog } from "@/components/move-to-notebook-dialog";
import { ActiveFilterBar, type FilterChipItem } from "@/components/ui/active-filter-bar";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SearchInput } from "@/components/ui/search-input";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { DEFAULT_PAGE_SIZE } from "@/lib/constants/pagination";
import { buildErrorListParams } from "@/lib/error-list-filters";
import { getApiErrorMessage } from "@/lib/error-message";
import { confirmDialog, toast } from "@/lib/feedback";
import { runInChunks } from "@/lib/chunked-batch";
import { frontendLogger } from "@/lib/frontend-logger";
import type { NotebookSubject } from "@/lib/notebook-scope";
import { locateByShortId } from "@/lib/short-id-client";
import { isShortId } from "@/lib/short-id-format";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import type { ErrorListFilters, PaperLevelFilter as PaperLevel, TimeFilter } from "@/lib/error-list-filters";
import type { MasteryStatus } from "@/lib/mastery-status";
import type { ErrorItemSummary, PaginatedResponse } from "@/types/api";
import { groupErrorItems, type ErrorListGroupMode } from "@/lib/error-list-groups";

export interface ErrorListProps {
    subjectId?: string;
    subject?: NotebookSubject | null;
    learnerId?: string | null;
    classId?: string | null;
    /** 批量移动或删除错题后回调，供父页面静默刷新顶部计数 */
    onItemsChanged?: () => void;
}

interface KnowledgeFilterChange {
    gradeSemester?: string;
    chapter?: string;
    tag?: string | null;
}

export function ErrorList({ subjectId, subject = null, learnerId, classId, onItemsChanged }: ErrorListProps = {}) {
    const { t } = useLanguage();
    const router = useRouter();
    const [items, setItems] = useState<ErrorItemSummary[]>([]);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [searchInput, setSearchInput] = useState("");
    const debouncedSearch = useDebouncedValue(searchInput, 220);
    const [masteryFilter, setMasteryFilter] = useState<"all" | MasteryStatus>("all");
    const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
    const [gradeFilter, setGradeFilter] = useState("");
    const [chapterFilter, setChapterFilter] = useState("");
    const [paperLevelFilter, setPaperLevelFilter] = useState<PaperLevel>("all");
    const [selectedTag, setSelectedTag] = useState<string | null>(null);

    const [page, setPage] = useState(1);
    const pageSize = DEFAULT_PAGE_SIZE;
    const [total, setTotal] = useState(0);
    const [totalPages, setTotalPages] = useState(0);

    const [isSelectMode, setIsSelectMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [isDeleting, setIsDeleting] = useState(false);
    const [groupBy, setGroupBy] = useState<ErrorListGroupMode>("date");

    // 递增请求序号，防止快速切换筛选或翻页时旧响应覆盖新结果
    const requestSeqRef = useRef(0);

    const filters: ErrorListFilters = useMemo(() => ({
        subjectId,
        search: debouncedSearch,
        mastery: masteryFilter,
        timeRange: timeFilter,
        tag: selectedTag,
        gradeSemester: gradeFilter,
        chapter: chapterFilter,
        paperLevel: paperLevelFilter,
        learnerId: learnerId || undefined,
        classId: classId || undefined,
    }), [subjectId, debouncedSearch, masteryFilter, timeFilter, selectedTag, gradeFilter, chapterFilter, paperLevelFilter, learnerId, classId]);

    const handleFilterChange = (change: KnowledgeFilterChange) => {
        const { gradeSemester, chapter, tag } = change;
        if (gradeSemester !== undefined) setGradeFilter(gradeSemester);
        if (chapter !== undefined) setChapterFilter(chapter);
        // 仅在调用方显式传入 tag 时才更新，避免章节筛选/清除顺带清空标签
        if ("tag" in change) setSelectedTag(tag ?? null);

        // 清空年级时级联清空章节与标签
        if (gradeSemester !== undefined && !gradeSemester) {
            setChapterFilter("");
            setSelectedTag(null);
        }
        setPage(1);
    };

    const resetAllFilters = useCallback(() => {
        setSearchInput("");
        setMasteryFilter("all");
        setTimeFilter("all");
        setGradeFilter("");
        setChapterFilter("");
        setPaperLevelFilter("all");
        setSelectedTag(null);
        setPage(1);
    }, []);

    const activeChips = useMemo<FilterChipItem[]>(() => {
        const chips: FilterChipItem[] = [];
        if (masteryFilter !== "all") {
            const label = masteryFilter === "new" ? t.filter.review : masteryFilter === "reviewing" ? t.filter.reviewing : t.filter.mastered;
            chips.push({ key: "mastery", label, onRemove: () => setMasteryFilter("all") });
        }
        if (timeFilter !== "all") {
            const label = timeFilter === "week" ? t.filter.lastWeek : t.filter.lastMonth;
            chips.push({ key: "time", label, onRemove: () => setTimeFilter("all") });
        }
        if (paperLevelFilter !== "all") {
            const label = t.editor.paperLevels?.[paperLevelFilter] || paperLevelFilter.toUpperCase();
            chips.push({ key: "paper", label, onRemove: () => setPaperLevelFilter("all") });
        }
        if (gradeFilter) {
            chips.push({ key: "grade", label: gradeFilter, onRemove: () => handleFilterChange({ gradeSemester: "" }) });
        }
        if (chapterFilter) {
            chips.push({ key: "chapter", label: chapterFilter, onRemove: () => handleFilterChange({ chapter: "" }) });
        }
        if (selectedTag) {
            chips.push({ key: "tag", label: selectedTag, onRemove: () => setSelectedTag(null) });
        }
        if (debouncedSearch.trim()) {
            chips.push({
                key: "search",
                label: `${t.common.searchLabel}: ${debouncedSearch.trim()}`,
                onRemove: () => setSearchInput(""),
            });
        }
        return chips;
    }, [masteryFilter, timeFilter, paperLevelFilter, gradeFilter, chapterFilter, selectedTag, debouncedSearch, t]);

    const hasActiveQuery = activeChips.length > 0 || debouncedSearch.trim().length > 0;

    const toggleSelectMode = () => {
        setIsSelectMode((prev) => !prev);
        setSelectedIds(new Set());
    };

    const toggleSelectItem = (id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const fetchItems = useCallback(async () => {
        const seq = ++requestSeqRef.current;
        setLoading(true);
        setError(null);
        try {
            const params = buildErrorListParams(filters);
            params.append("page", page.toString());
            params.append("pageSize", pageSize.toString());
            const response = await apiClient.get<PaginatedResponse<ErrorItemSummary>>(`/api/error-items/list?${params.toString()}`);
            if (seq !== requestSeqRef.current) return;
            const lastPage = Math.max(1, response.totalPages);
            if (page > lastPage) {
                setPage(lastPage);
                return;
            }
            setItems(response.items);
            setTotal(response.total);
            setTotalPages(response.totalPages);
            setHasLoaded(true);
        } catch (err) {
            if (seq !== requestSeqRef.current) return;
            frontendLogger.error("[ErrorList]", "Failed to fetch error items", { error: err });
            setError(getApiErrorMessage(err) || t.common.loadErrorDesc);
        } finally {
            if (seq === requestSeqRef.current) {
                setLoading(false);
            }
        }
    }, [filters, page, pageSize, t.common.loadErrorDesc]);

    const handleBatchDelete = async () => {
        if (selectedIds.size === 0) return;
        const confirmMsg = (t.notebook?.confirmBatchDelete || "Delete {count} items?").replace("{count}", selectedIds.size.toString());
        if (!(await confirmDialog(confirmMsg, { destructive: true }))) return;

        setIsDeleting(true);
        let deleted = 0;
        try {
            const total = selectedIds.size;
            const outcome = await runInChunks(Array.from(selectedIds), (batch) =>
                apiClient.post<{ deleted?: number }>("/api/error-items/batch-delete", { ids: batch }));
            deleted = outcome.results.reduce((sum, result) => sum + (result?.deleted ?? 0), 0);
            if (outcome.error) {
                frontendLogger.error("[ErrorList]", "Batch delete failed", { error: outcome.error, deleted, total });
                if (outcome.processedIds.length > 0) {
                    toast.warning(t.notebook.batchDeletePartial
                        .replace("{done}", String(outcome.processedIds.length))
                        .replace("{total}", String(total)));
                } else {
                    toast.error(t.common?.messages?.deleteFailed || "Delete failed");
                }
                // 只保留未处理的题，方便直接重试
                setSelectedIds(new Set(outcome.unprocessedIds));
            } else {
                toast.success(t.notebook?.batchDeleteSuccess || "Deleted successfully");
                setIsSelectMode(false);
                setSelectedIds(new Set());
            }
        } catch (err) {
            frontendLogger.error("[ErrorList]", "Batch delete failed", { error: err });
            toast.error(t.common?.messages?.deleteFailed || "Delete failed");
        } finally {
            setIsDeleting(false);
            // 分批请求不是原子操作：无论成败都刷新列表与顶部计数，避免显示过期数据
            await fetchItems();
            if (deleted > 0) onItemsChanged?.();
        }
    };

    const [moveOpen, setMoveOpen] = useState(false);
    const [isMoving, setIsMoving] = useState(false);
    const handleBatchMove = async (targetSubjectId: string) => {
        if (selectedIds.size === 0 || !targetSubjectId) return;
        setIsMoving(true);
        let totalMoved = 0;
        try {
            let totalSkipped = 0;
            const total = selectedIds.size;
            const scopePayload = learnerId
                ? { learnerId }
                : classId
                    ? { classId }
                    : {};
            const outcome = await runInChunks(Array.from(selectedIds), (batch) =>
                apiClient.post<{ moved: number; skipped: number }>("/api/error-items/batch-move", {
                    ids: batch,
                    subjectId: targetSubjectId,
                    ...scopePayload,
                }));
            for (const result of outcome.results) {
                totalMoved += result?.moved ?? 0;
                totalSkipped += result?.skipped ?? 0;
            }
            if (outcome.error) {
                frontendLogger.error("[ErrorList]", "Batch move failed", { error: outcome.error, moved: totalMoved, total });
                if (outcome.processedIds.length > 0) {
                    toast.warning(t.notebook.movePartial
                        .replace("{done}", String(outcome.processedIds.length))
                        .replace("{total}", String(total)));
                } else {
                    toast.error(t.notebook.moveFailed);
                }
                setSelectedIds(new Set(outcome.unprocessedIds));
            } else {
                if (totalMoved > 0) {
                    toast.success(t.notebook.moveSuccess.replace("{count}", String(totalMoved)));
                }
                if (totalSkipped > 0) {
                    toast.warning(t.notebook.moveSkipped.replace("{count}", String(totalSkipped)));
                }
                setMoveOpen(false);
                setIsSelectMode(false);
                setSelectedIds(new Set());
            }
        } catch (err) {
            frontendLogger.error("[ErrorList]", "Batch move failed", { error: err });
            toast.error(t.notebook.moveFailed);
        } finally {
            setIsMoving(false);
            // 分批请求不是原子操作：无论成败都刷新列表与顶部计数
            await fetchItems();
            if (totalMoved > 0) onItemsChanged?.();
        }
    };

    const prevFiltersRef = useRef(filters);
    useEffect(() => {
        const filtersChanged = prevFiltersRef.current !== filters;
        prevFiltersRef.current = filters;
        if (filtersChanged) {
            setSelectedIds((prev) => (prev.size > 0 ? new Set() : prev));
        }
        if (filtersChanged && page !== 1) {
            setPage(1);
            return;
        }
        fetchItems();
    }, [page, filters, fetchItems]);

    return (
        <div className={`space-y-5 ${isSelectMode ? "pb-40 sm:pb-24" : ""}`}>
            <div className="flex flex-col gap-3 lg:flex-row">
                <SearchInput
                    placeholder={t.notebook.search}
                    title={t.shortId.searchHint}
                    containerClassName="lg:flex-1"
                    value={searchInput}
                    onValueChange={setSearchInput}
                    onKeyDown={async (e) => {
                        const value = searchInput.trim();
                        if (e.key !== "Enter" || !isShortId(value)) return;
                        const id = await locateByShortId(value);
                        if (id) router.push(`/error-items/${id}`);
                    }}
                />
                <div className="flex flex-wrap gap-2">
                    <FilterMenu
                        mastery={masteryFilter}
                        timeRange={timeFilter}
                        onMasteryChange={setMasteryFilter}
                        onTimeRangeChange={setTimeFilter}
                    />
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-10"
                        onClick={() => router.push(`/print-preview?${buildErrorListParams(filters).toString()}`)}
                    >
                        <Printer className="h-4 w-4" aria-hidden="true" />
                        {t.notebook?.exportPrint || "Export for Print"}
                    </Button>
                    {!isSelectMode && (
                        <Button type="button" variant="outline" size="sm" className="h-10" onClick={toggleSelectMode}>
                            <GitCompareArrows className="h-4 w-4" aria-hidden="true" />
                            {t.questionSimilarity.title}
                        </Button>
                    )}
                    <Button
                        type="button"
                        variant={isSelectMode ? "secondary" : "outline"}
                        size="sm"
                        className="h-10"
                        onClick={toggleSelectMode}
                    >
                        <ListChecks className="h-4 w-4" aria-hidden="true" />
                        {isSelectMode ? t.notebook?.cancelSelect || "Cancel" : t.notebook?.selectMode || "Select"}
                    </Button>
                </div>
            </div>

            <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
                <div className="w-full sm:w-auto">
                    <KnowledgeFilter
                        gradeSemester={gradeFilter}
                        tag={selectedTag}
                        onFilterChange={handleFilterChange}
                        subject={subject}
                        chapter={chapterFilter}
                    />
                </div>
                <PaperLevelFilter value={paperLevelFilter} onChange={setPaperLevelFilter} />
            </div>

            <SegmentedControl
                options={[
                    { value: "date" as const, label: t.notebook.groupDate },
                    { value: "knowledge" as const, label: t.notebook.groupKnowledge },
                    { value: "cause" as const, label: t.notebook.groupCause },
                ]}
                value={groupBy}
                onChange={setGroupBy}
                ariaLabel={t.notebook.groupBy}
            />

            <ActiveFilterBar items={activeChips} onClearAll={resetAllFilters} />

            <AsyncBoundary
                loading={loading}
                error={error}
                hasData={hasLoaded && items.length > 0}
                empty={hasLoaded && items.length === 0}
                onRetry={fetchItems}
                loadingLabel={t.common.loading}
                emptyFallback={
                    hasActiveQuery ? (
                        <EmptyState
                            icon={SearchX}
                            title={t.notebook.emptyFiltered}
                            description={t.notebook.emptyFilteredHint}
                            action={
                                <Button type="button" variant="outline" onClick={resetAllFilters}>
                                    <FilterX className="h-4 w-4" aria-hidden="true" />
                                    {t.common.clearFilters}
                                </Button>
                            }
                        />
                    ) : (
                        <EmptyState icon={Inbox} title={t.notebook.emptyList} description={t.notebook.emptyListHint} />
                    )
                }
            >
                {groupBy === "date" ? (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {items.map((item) => (
                        <ErrorItemCard
                            key={item.id}
                            item={item}
                            selectMode={isSelectMode}
                            selected={selectedIds.has(item.id)}
                            onToggleSelect={() => toggleSelectItem(item.id)}
                            selectedTag={selectedTag}
                            onTagClick={(tag) => setSelectedTag(selectedTag === tag ? null : tag)}
                        />
                    ))}
                </div>
                ) : (
                <div className="space-y-6">
                    {groupErrorItems(items, groupBy, { ungrouped: t.notebook.ungrouped, unknownCause: t.notebook.unknownCause }).map((group) => (
                        <section key={group.key} className="space-y-3">
                            <h2 className="text-sm font-semibold tracking-tight">{group.label}</h2>
                            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                                {group.items.map((item) => (
                                    <ErrorItemCard
                                        key={`${group.key}-${item.id}`}
                                        item={item}
                                        selectMode={isSelectMode}
                                        selected={selectedIds.has(item.id)}
                                        onToggleSelect={() => toggleSelectItem(item.id)}
                                        selectedTag={selectedTag}
                                        onTagClick={(tag) => setSelectedTag(selectedTag === tag ? null : tag)}
                                    />
                                ))}
                            </div>
                        </section>
                    ))}
                </div>
                )}
            </AsyncBoundary>

            <Pagination page={page} totalPages={totalPages} total={total} pageSize={pageSize} onPageChange={setPage} />

            {isSelectMode && (
                <ErrorListSelectionBar
                    selectedIds={[...selectedIds]}
                    deleting={isDeleting}
                    onCancel={toggleSelectMode}
                    onDelete={handleBatchDelete}
                    onMove={() => setMoveOpen(true)}
                    moving={isMoving}
                />
            )}
            <MoveToNotebookDialog
                open={moveOpen}
                onOpenChange={setMoveOpen}
                count={selectedIds.size}
                currentSubjectId={subjectId}
                moving={isMoving}
                onMove={(target) => void handleBatchMove(target)}
            />
        </div>
    );
}
