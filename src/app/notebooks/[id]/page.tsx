"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { ErrorList } from "@/components/error-list";
import { NotebookScopeLabel } from "@/components/notebook-scope-label";
import { RenameNotebookDialog } from "@/components/rename-notebook-dialog";
import { RetagNotebookButton } from "@/components/retag-notebook-button";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { PageLoading } from "@/components/ui/page-loading";
import { useLanguage } from "@/contexts/LanguageContext";
import { ApiError, apiClient } from "@/lib/api-client";
import { getApiErrorMessage } from "@/lib/error-message";
import { confirmDialog, toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import { usePageTitle } from "@/lib/page-title";
import type { Notebook } from "@/types/api";

export default function NotebookDetailPage() {
    const params = useParams();
    const router = useRouter();
    const { t } = useLanguage();
    const [notebook, setNotebook] = useState<Notebook | null>(null);
    usePageTitle(t.notebooks.title, notebook?.name);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [renameDialogOpen, setRenameDialogOpen] = useState(false);
    // 批量重新生成知识点后递增，用于刷新题目列表
    const [listVersion, setListVersion] = useState(0);

    const notebookId = typeof params.id === "string" ? params.id : "";

    const fetchNotebook = useCallback(async (id: string) => {
        setLoading(true);
        setLoadError(null);
        try {
            const data = await apiClient.get<Notebook>(`/api/notebooks/${id}`);
            setNotebook(data);
        } catch (error) {
            frontendLogger.error("[NotebookDetail]", "Failed to fetch notebook", { error });
            if (error instanceof ApiError && error.status === 404) {
                toast.error(t.notebooks.notFound);
                router.push("/notebooks");
                return;
            }
            setLoadError(getApiErrorMessage(error) || t.common.loadErrorDesc);
        } finally {
            setLoading(false);
        }
    }, [router, t.common.loadErrorDesc, t.notebooks.notFound]);

    useEffect(() => {
        if (notebookId) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- 数据请求：进入页面或路由参数变化时加载错题本详情并同步加载态
            fetchNotebook(notebookId);
        }
    }, [notebookId, fetchNotebook]);

    const handleRename = async (name: string) => {
        if (!notebook) return;
        const updated = await apiClient.put<Notebook>(`/api/notebooks/${notebook.id}`, { name });
        setNotebook(updated);
    };

    const handleDelete = async () => {
        if (!notebook) return;
        try {
            const latest = await apiClient.get<Notebook>(`/api/notebooks/${notebook.id}`);
            if ((latest._count?.errorItems || 0) > 0) {
                toast.warning(t.notebooks?.deleteNotEmpty || "Please clear all items in this notebook first.");
                return;
            }
            if (!(await confirmDialog((t.notebooks?.deleteConfirm || "Are you sure?").replace("{name}", notebook.name), { destructive: true }))) return;
            setDeleting(true);
            await apiClient.delete(`/api/notebooks/${notebook.id}`);
            router.replace("/notebooks");
        } catch (error) {
            frontendLogger.error("[NotebookDetail]", "Failed to delete notebook", { error });
            toast.error(getApiErrorMessage(error) || t.notebooks?.deleteError || "Failed to delete");
        } finally {
            setDeleting(false);
        }
    };

    if (loading && !notebook) {
        return <PageLoading label={t.common.loading} />;
    }

    if (loadError && !notebook) {
        return (
            <PageContainer>
                <ErrorState
                    description={loadError}
                    retrying={loading}
                    onRetry={() => notebookId && fetchNotebook(notebookId)}
                />
            </PageContainer>
        );
    }

    if (!notebook) return null;

    const renameLabel = t.notebooks?.rename || t.common.edit;

    return (
        <PageContainer className="space-y-6">
            <PageHeader
                backHref="/notebooks"
                title={notebook.name}
                titleAddon={
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0 text-muted-foreground"
                        onClick={() => setRenameDialogOpen(true)}
                        title={renameLabel}
                        aria-label={renameLabel}
                    >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                    </Button>
                }
                description={
                    <>
                        <NotebookScopeLabel notebook={notebook} />
                        {" · "}
                        {(t.notebooks?.totalErrors || "Total {count} errors").replace(
                            "{count}",
                            (notebook._count?.errorItems || 0).toString()
                        )}
                    </>
                }
                actions={
                    <>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            loading={deleting}
                            className="text-destructive hover:text-destructive"
                            onClick={handleDelete}
                            aria-label={t.common.delete}
                        >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                            <span className="hidden sm:inline">{t.common.delete}</span>
                        </Button>
                        <RetagNotebookButton notebookId={notebook.id} onFinished={() => setListVersion((v) => v + 1)} />
                        <Button asChild aria-label={t.notebooks?.addError || "Add Error"}>
                            <Link href={`/notebooks/${notebook.id}/add`}>
                                <Plus className="h-4 w-4" aria-hidden="true" />
                                <span className="hidden sm:inline">{t.notebooks?.addError || "Add Error"}</span>
                            </Link>
                        </Button>
                    </>
                }
            />

            <ErrorList key={listVersion} subjectId={notebook.id} subjectName={notebook.name} />

            <RenameNotebookDialog
                open={renameDialogOpen}
                onOpenChange={setRenameDialogOpen}
                currentName={notebook.name}
                onRename={handleRename}
            />
        </PageContainer>
    );
}
