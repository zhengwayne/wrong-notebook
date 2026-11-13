"use client";

import { useEffect, useState, useCallback } from "react";
import { BookOpen, Plus } from "lucide-react";
import { CreateNotebookDialog, type CreateNotebookInput } from "@/components/create-notebook-dialog";
import { NotebookCard } from "@/components/notebook-card";
import { ShortIdLocator } from "@/components/short-id-locator";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { getApiErrorMessage } from "@/lib/error-message";
import { toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import { usePageTitle } from "@/lib/page-title";
import type { Notebook } from "@/types/api";

export default function NotebooksPage() {
    const { t } = useLanguage();
    usePageTitle(t.notebooks.title);
    const [notebooks, setNotebooks] = useState<Notebook[]>([]);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);

    const fetchNotebooks = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await apiClient.get<Notebook[]>("/api/notebooks");
            setNotebooks(data);
            setHasLoaded(true);
        } catch (err) {
            frontendLogger.error("[Notebooks]", "Failed to fetch notebooks", { error: err });
            setError(getApiErrorMessage(err) || t.common.loadErrorDesc);
        } finally {
            setLoading(false);
        }
    }, [t.common.loadErrorDesc]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 数据请求：进入页面时拉取错题本列表并更新加载与错误状态
        fetchNotebooks();
    }, [fetchNotebooks]);

    const handleCreate = async (input: CreateNotebookInput) => {
        try {
            await apiClient.post("/api/notebooks", input);
            await fetchNotebooks();
        } catch (err) {
            frontendLogger.error("[Notebooks]", "Failed to create notebook", { error: err });
            const message = getApiErrorMessage(err) || t.notebooks?.createError || "Failed to create";
            toast.error(message);
        }
    };

    return (
        <PageContainer className="space-y-6">
            <PageHeader
                title={t.notebooks?.title || "My Notebooks"}
                description={t.notebooks?.subtitle || "Manage your mistakes by subject"}
                actions={
                    <Button onClick={() => setDialogOpen(true)} aria-label={t.notebooks?.create || "New Notebook"}>
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        <span className="hidden sm:inline">{t.notebooks?.create || "New Notebook"}</span>
                    </Button>
                }
            />

            <ShortIdLocator />

            <AsyncBoundary
                loading={loading}
                error={error}
                hasData={hasLoaded && notebooks.length > 0}
                empty={hasLoaded && notebooks.length === 0}
                onRetry={fetchNotebooks}
                loadingLabel={t.common.loading}
                emptyFallback={
                    <EmptyState
                        icon={BookOpen}
                        title={t.notebooks?.empty || "No notebooks yet."}
                        action={
                            <Button onClick={() => setDialogOpen(true)}>
                                <Plus className="h-4 w-4" aria-hidden="true" />
                                {t.notebooks?.createFirst || "Create Notebook"}
                            </Button>
                        }
                    />
                }
            >
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {notebooks.map((notebook) => (
                        <NotebookCard
                            key={notebook.id}
                            name={notebook.name}
                            stage={notebook.stage}
                            subjectKey={notebook.subjectKey}
                            errorCount={notebook._count?.errorItems || 0}
                            href={`/notebooks/${notebook.id}`}
                            itemLabel={t.notebooks.cardItems}
                        />
                    ))}
                </div>
            </AsyncBoundary>

            <CreateNotebookDialog
                key={t.common.loading}
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                onCreate={handleCreate}
            />
        </PageContainer>
    );
}
