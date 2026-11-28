"use client";

import { useEffect, useRef, useState, useCallback } from "react";
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
import { useCurrentChild } from "@/lib/use-current-child";
import { resolveNotebookScope } from "@/lib/notebook-scope";
import { usePageTitle } from "@/lib/page-title";
import type { Notebook } from "@/types/api";

function clearUrlLearnerParams() {
    if (typeof window === "undefined") return;
    const urlParams = new URLSearchParams(window.location.search);
    if (!urlParams.has("learnerId") && !urlParams.has("studentKey")) return;
    urlParams.delete("learnerId");
    urlParams.delete("studentKey");
    const nextQuery = urlParams.toString();
    const targetUrl = nextQuery ? `${window.location.pathname}?${nextQuery}` : window.location.pathname;
    window.history.replaceState(window.history.state, "", targetUrl);
}

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
    const requestSeqRef = useRef(0);
    const healedScopeRef = useRef<string | null>(null);

    const notebookId = typeof params.id === "string" ? params.id : "";
    const { isTeacher, isParent, learnerId, classId, setTeacherScope, setLearner, hrefWithChild } = useCurrentChild();
    const classFilter = learnerId ? null : classId;

    const fetchNotebook = useCallback(async (id: string) => {
        const seq = ++requestSeqRef.current;
        setNotebook(null);
        setLoading(true);
        setLoadError(null);
        try {
            const query = learnerId ? `?learnerId=${encodeURIComponent(learnerId)}`
                : classFilter ? `?classId=${encodeURIComponent(classFilter)}` : "";
            const data = await apiClient.get<Notebook>(`/api/notebooks/${id}${query}`);
            if (seq !== requestSeqRef.current) return;
            healedScopeRef.current = null;
            setNotebook(data);
        } catch (error) {
            if (seq !== requestSeqRef.current) return;
            frontendLogger.error("[NotebookDetail]", "Failed to fetch notebook", { error });
            if (error instanceof ApiError && error.status === 404) {
                const errorCode = error.code || getApiErrorMessage(error);
                const isScopeNotFound = errorCode === "Class not found"
                    || errorCode === "Learner not found"
                    || (Boolean(classFilter || learnerId) && errorCode !== "Notebook not found");
                if (isScopeNotFound) {
                    const scopeKey = `${isTeacher ? "T" : "P"}:${classFilter ?? ""}:${learnerId ?? ""}`;
                    const canHeal = isTeacher ? typeof setTeacherScope === "function" : (isParent && typeof setLearner === "function");
                    if (healedScopeRef.current !== scopeKey && canHeal) {
                        healedScopeRef.current = scopeKey;
                        clearUrlLearnerParams();
                        if (isTeacher) setTeacherScope(null);
                        else if (isParent) setLearner(null);
                    }
                    setLoadError(getApiErrorMessage(error) || t.common.loadErrorDesc);
                    return;
                }
                toast.error(t.notebooks.notFound);
                router.push(learnerId ? hrefWithChild("/notebooks") : "/notebooks");
                return;
            }
            setLoadError(getApiErrorMessage(error) || t.common.loadErrorDesc);
        } finally {
            if (seq === requestSeqRef.current) setLoading(false);
        }
    }, [router, t.common.loadErrorDesc, t.notebooks.notFound, isTeacher, isParent, learnerId, classFilter, setTeacherScope, setLearner, hrefWithChild]);

    useEffect(() => {
        if (notebookId) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- 数据请求：进入页面或路由参数变化时加载错题本详情并同步加载态
            fetchNotebook(notebookId);
        }
        return () => { requestSeqRef.current += 1; };
    }, [notebookId, fetchNotebook]);

    const refreshNotebookCount = useCallback(async () => {
        if (!notebookId) return;
        const seq = requestSeqRef.current;
        try {
            const query = learnerId ? `?learnerId=${encodeURIComponent(learnerId)}`
                : classFilter ? `?classId=${encodeURIComponent(classFilter)}` : "";
            const data = await apiClient.get<Notebook>(`/api/notebooks/${notebookId}${query}`);
            if (seq !== requestSeqRef.current) return;
            setNotebook(data);
        } catch (error) {
            frontendLogger.warn("[NotebookDetail]", "Failed to refresh notebook count", { error });
        }
    }, [notebookId, learnerId, classFilter]);

    const handleRename = async (name: string) => {
        if (!notebook) return;
        const updated = await apiClient.put<Notebook>(`/api/notebooks/${notebook.id}`, { name });
        setNotebook((previous) => previous?.id === updated.id ? { ...previous, name: updated.name } : previous);
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
            router.replace(hrefWithChild("/notebooks"));
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
                backHref={hrefWithChild("/notebooks")}
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
                            <Link href={hrefWithChild(`/notebooks/${notebook.id}/add`)}>
                                <Plus className="h-4 w-4" aria-hidden="true" />
                                <span className="hidden sm:inline">{t.notebooks?.addError || "Add Error"}</span>
                            </Link>
                        </Button>
                    </>
                }
            />

            <ErrorList
                key={`${listVersion}-${learnerId || classFilter || "all"}`}
                subjectId={notebook.id}
                subject={resolveNotebookScope(notebook).subject}
                learnerId={learnerId}
                classId={classFilter}
                onItemsChanged={() => void refreshNotebookCount()}
            />

            <RenameNotebookDialog
                open={renameDialogOpen}
                onOpenChange={setRenameDialogOpen}
                currentName={notebook.name}
                onRename={handleRename}
            />
        </PageContainer>
    );
}
