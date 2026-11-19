"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { BookOpen, Plus } from "lucide-react";
import { CreateNotebookDialog, type CreateNotebookInput } from "@/components/create-notebook-dialog";
import { NotebookCard } from "@/components/notebook-card";
import { TeacherScopeBar } from "@/components/notebooks/teacher-scope-bar";
import { ShortIdLocator } from "@/components/short-id-locator";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { useLanguage } from "@/contexts/LanguageContext";
import { ApiError, apiClient } from "@/lib/api-client";
import { getApiErrorMessage } from "@/lib/error-message";
import { toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import { useCurrentChild } from "@/lib/use-current-child";
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

export default function NotebooksPage() {
    const { t } = useLanguage();
    usePageTitle(t.notebooks.title);
    const { isParent, isTeacher, classId, learnerId, childName, setTeacherScope, hrefWithChild } = useCurrentChild();
    const [notebooks, setNotebooks] = useState<Notebook[]>([]);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const requestSeqRef = useRef(0);
    const healedScopeRef = useRef<string | null>(null);

    const fetchNotebooks = useCallback(async () => {
        const seq = ++requestSeqRef.current;
        setHasLoaded(false);
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (learnerId) {
                params.set("learnerId", learnerId);
                if (isTeacher || isParent) params.set("nonEmptyOnly", "1");
            } else if (isTeacher && classId) {
                params.set("classId", classId);
                params.set("nonEmptyOnly", "1");
            }
            const query = params.toString() ? `?${params.toString()}` : "";
            const data = await apiClient.get<Notebook[]>(`/api/notebooks${query}`);
            if (seq !== requestSeqRef.current) return;
            healedScopeRef.current = null;
            setNotebooks(data);
            setHasLoaded(true);
        } catch (err) {
            if (seq !== requestSeqRef.current) return;
            if (err instanceof ApiError && err.status === 404 && isTeacher && (classId || learnerId) && typeof setTeacherScope === "function") {
                const scopeKey = `${classId ?? ""}:${learnerId ?? ""}`;
                if (healedScopeRef.current !== scopeKey) {
                    healedScopeRef.current = scopeKey;
                    clearUrlLearnerParams();
                    setTeacherScope(null);
                    setError(getApiErrorMessage(err) || t.common.loadErrorDesc);
                    return;
                }
            }
            frontendLogger.error("[Notebooks]", "Failed to fetch notebooks", { error: err });
            setError(getApiErrorMessage(err) || t.common.loadErrorDesc);
        } finally {
            if (seq === requestSeqRef.current) setLoading(false);
        }
    }, [t.common.loadErrorDesc, learnerId, isTeacher, isParent, classId, setTeacherScope]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 数据请求：进入页面时拉取错题本列表并更新加载与错误状态
        fetchNotebooks();
        return () => { requestSeqRef.current += 1; };
    }, [fetchNotebooks]);

    const handleCreate = async (input: CreateNotebookInput) => {
        const seq = requestSeqRef.current;
        try {
            await apiClient.post("/api/notebooks", input);
            if (seq === requestSeqRef.current) await fetchNotebooks();
        } catch (err) {
            frontendLogger.error("[Notebooks]", "Failed to create notebook", { error: err });
            const message = getApiErrorMessage(err) || t.notebooks?.createError || "Failed to create";
            toast.error(message);
            throw err;
        }
    };

    return (
        <PageContainer className="space-y-6">
            <PageHeader
                title={t.notebooks?.title || "My Notebooks"}
                description={
                    isParent && childName
                        ? t.persona.parentHome.forChild.replace("{name}", childName)
                        : isTeacher && childName
                            ? t.notebooks.teacherScope.viewingStudent.replace("{name}", childName)
                            : (t.notebooks?.subtitle || "Manage your mistakes by subject")
                }
                actions={
                    <Button onClick={() => setDialogOpen(true)} aria-label={t.notebooks?.create || "New Notebook"}>
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        <span className="hidden sm:inline">{t.notebooks?.create || "New Notebook"}</span>
                    </Button>
                }
            />

            <TeacherScopeBar />
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
                            href={hrefWithChild(`/notebooks/${notebook.id}`)}
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
