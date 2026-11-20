"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { getApiErrorMessage } from "@/lib/error-message";
import { frontendLogger } from "@/lib/frontend-logger";
import { toast } from "@/lib/feedback";
import { MAX_CHILD_LEARNERS } from "@/lib/learners";

export interface ChildLearner {
    id: string;
    name: string;
    itemCount: number;
}

export function ChildLearnersManager({ className, onChanged }: { className?: string; onChanged?: () => void }) {
    const { t } = useLanguage();
    const copy = t.persona.children;
    const [children, setChildren] = useState<ChildLearner[]>([]);
    const [loading, setLoading] = useState(true);
    const [name, setName] = useState("");
    const [saving, setSaving] = useState(false);
    const [editing, setEditing] = useState<ChildLearner | null>(null);
    const [editName, setEditName] = useState("");
    const [removing, setRemoving] = useState<ChildLearner | null>(null);
    const [deleteQuestions, setDeleteQuestions] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const data = await apiClient.get<{ children: ChildLearner[] }>("/api/learners");
            setChildren(data.children);
        } catch (error) {
            frontendLogger.error("[Children]", "Failed to load children", { error });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 数据请求：进入页面时加载孩子档案
        void load();
    }, [load]);

    const addChild = async () => {
        const trimmed = name.trim();
        if (!trimmed || saving) return;
        setSaving(true);
        try {
            const created = await apiClient.post<ChildLearner, { name: string }>("/api/learners", { name: trimmed });
            setChildren((current) => [...current, created]);
            setName("");
            toast.success(copy.saved);
            onChanged?.();
        } catch (error) {
            toast.error(getApiErrorMessage(error) || copy.saveFailed);
        } finally {
            setSaving(false);
        }
    };

    const saveEdit = async () => {
        if (!editing) return;
        const trimmed = editName.trim();
        if (!trimmed) return;
        setBusyId(editing.id);
        try {
            const updated = await apiClient.patch<ChildLearner, { name: string }>(`/api/learners/${editing.id}`, { name: trimmed });
            setChildren((current) => current.map((child) => (child.id === updated.id ? { ...child, name: updated.name } : child)));
            setEditing(null);
            toast.success(copy.saved);
            onChanged?.();
        } catch (error) {
            toast.error(getApiErrorMessage(error) || copy.saveFailed);
        } finally {
            setBusyId(null);
        }
    };

    const confirmDelete = async () => {
        if (!removing) return;
        setBusyId(removing.id);
        try {
            await apiClient.delete(`/api/learners/${removing.id}`, {
                body: JSON.stringify({
                    deleteQuestions,
                    confirmDeleteQuestions: deleteQuestions,
                }),
            });
            setChildren((current) => current.filter((child) => child.id !== removing.id));
            setRemoving(null);
            setDeleteQuestions(false);
            toast.success(copy.deleted);
            onChanged?.();
        } catch (error) {
            toast.error(getApiErrorMessage(error) || copy.deleteFailed);
        } finally {
            setBusyId(null);
        }
    };

    const atLimit = children.length >= MAX_CHILD_LEARNERS;

    return (
        <div className={className}>
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h3 className="text-sm font-semibold">{copy.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{copy.desc}</p>
                </div>
            </div>

            {loading ? (
                <div className="mt-4 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
            ) : (
                <ul className="mt-4 space-y-2" role="list">
                    {children.length === 0 && (
                        <li className="rounded-xl border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                            {copy.empty}
                        </li>
                    )}
                    {children.map((child) => (
                        <li key={child.id} className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2">
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium">{child.name}</div>
                                <div className="text-xs text-muted-foreground">{copy.itemCount.replace("{count}", String(child.itemCount))}</div>
                            </div>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                aria-label={copy.rename}
                                onClick={() => { setEditing(child); setEditName(child.name); }}
                            >
                                <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                aria-label={copy.remove}
                                onClick={() => { setRemoving(child); setDeleteQuestions(false); }}
                            >
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}

            <form
                className="mt-4 flex gap-2"
                onSubmit={(event) => { event.preventDefault(); void addChild(); }}
            >
                <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={copy.namePlaceholder}
                    disabled={atLimit || saving}
                    maxLength={40}
                    aria-label={copy.namePlaceholder}
                />
                <Button type="submit" disabled={atLimit || saving || !name.trim()}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    <span className="ml-1">{copy.add}</span>
                </Button>
            </form>
            {atLimit && <p className="mt-2 text-xs text-muted-foreground">{copy.limit}</p>}

            <Dialog open={Boolean(editing)} onOpenChange={(open) => { if (!open) setEditing(null); }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{copy.rename}</DialogTitle>
                        <DialogDescription>{copy.renameDesc}</DialogDescription>
                    </DialogHeader>
                    <Input value={editName} onChange={(event) => setEditName(event.target.value)} maxLength={40} />
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="outline" onClick={() => setEditing(null)}>{t.common.cancel}</Button>
                        <Button type="button" onClick={() => void saveEdit()} disabled={!editName.trim() || busyId === editing?.id}>
                            {t.common.save}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog open={Boolean(removing)} onOpenChange={(open) => { if (!open) { setRemoving(null); setDeleteQuestions(false); } }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{copy.removeTitle}</DialogTitle>
                        <DialogDescription>
                            {copy.removeDesc.replace("{name}", removing?.name ?? "")}
                        </DialogDescription>
                    </DialogHeader>
                    <label className="flex items-start gap-3 rounded-xl border border-border p-3 text-sm">
                        <Checkbox
                            checked={deleteQuestions}
                            onCheckedChange={(state) => setDeleteQuestions(state === true)}
                        />
                        <span>{copy.deleteQuestions.replace("{count}", String(removing?.itemCount ?? 0))}</span>
                    </label>
                    <p className="text-xs text-muted-foreground">{copy.deleteQuestionsHint}</p>
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="outline" onClick={() => setRemoving(null)}>{t.common.cancel}</Button>
                        <Button type="button" variant="destructive" onClick={() => void confirmDelete()} disabled={busyId === removing?.id}>
                            {t.common.delete}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
