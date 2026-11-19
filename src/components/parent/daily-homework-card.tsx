"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Circle, Clock, Flame, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import {
    HOMEWORK_CATEGORIES,
    HOMEWORK_SUBJECTS,
    type HomeworkCategory,
    type HomeworkSubjectKey,
} from "@/lib/daily-homework";
import { getApiErrorMessage } from "@/lib/error-message";

interface HomeworkItemDto {
    id: string;
    subjectKey: HomeworkSubjectKey;
    category: HomeworkCategory;
    title: string;
    estimatedMinutes: number | null;
    completed: boolean;
}

interface HomeworkListResponse {
    dateKey: string;
    items: HomeworkItemDto[];
    summary: {
        total: number;
        completed: number;
        estimatedMinutes: number;
        streakDays: number;
    };
}

export function DailyHomeworkCard({ learnerId }: { learnerId: string }) {
    const { t } = useLanguage();
    const copy = t.dailyHomework;
    const [data, setData] = useState<HomeworkListResponse | null>(null);
    const [subjectKey, setSubjectKey] = useState<HomeworkSubjectKey>("math");
    const [category, setCategory] = useState<HomeworkCategory>("written");
    const [title, setTitle] = useState("");
    const [minutes, setMinutes] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!learnerId) return;
        try {
            const res = await apiClient.get<HomeworkListResponse>(
                `/api/parent/homeworks?learnerId=${encodeURIComponent(learnerId)}`,
            );
            setData(res);
        } catch (err) {
            setError(getApiErrorMessage(err) || "操作失败");
        }
    }, [learnerId]);

    useEffect(() => {
        if (!learnerId) return;
        let cancelled = false;
        apiClient.get<HomeworkListResponse>(
            `/api/parent/homeworks?learnerId=${encodeURIComponent(learnerId)}`,
        )
            .then((res) => {
                if (!cancelled) {
                    setError(null);
                    setData(res);
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setError(getApiErrorMessage(err) || "操作失败");
                }
            });
        return () => {
            cancelled = true;
        };
    }, [learnerId]);

    const handleAdd = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = title.trim();
        if (!trimmed) return;
        setError(null);
        setSubmitting(true);
        try {
            const parsedMin = minutes.trim() ? Number(minutes) : null;
            await apiClient.post("/api/parent/homeworks", {
                learnerId,
                subjectKey,
                category,
                title: trimmed,
                estimatedMinutes: parsedMin && parsedMin > 0 ? Math.min(480, Math.round(parsedMin)) : null,
            });
            setTitle("");
            setMinutes("");
            await load();
        } catch (err) {
            setError(getApiErrorMessage(err) || "操作失败");
        } finally {
            setSubmitting(false);
        }
    };

    const toggleItem = async (item: HomeworkItemDto) => {
        try {
            await apiClient.patch(`/api/parent/homeworks/${item.id}`, {
                completed: !item.completed,
            });
            await load();
        } catch (err) {
            setError(getApiErrorMessage(err) || "操作失败");
        }
    };

    const removeItem = async (id: string) => {
        try {
            await apiClient.delete(`/api/parent/homeworks/${id}`);
            await load();
        } catch (err) {
            setError(getApiErrorMessage(err) || "操作失败");
        }
    };

    const items = data?.items ?? [];
    const summary = data?.summary ?? { total: 0, completed: 0, estimatedMinutes: 0, streakDays: 0 };

    return (
        <section className="rounded-2xl border border-border bg-card p-5 shadow-2xs space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2.5">
                    <h3 className="text-base font-semibold">{copy.title}</h3>
                    {summary.total > 0 && (
                        <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                            {copy.progress
                                .replace("{completed}", String(summary.completed))
                                .replace("{total}", String(summary.total))}
                        </span>
                    )}
                    {summary.estimatedMinutes > 0 && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                            {copy.estimatedMinutes.replace("{minutes}", String(summary.estimatedMinutes))}
                        </span>
                    )}
                </div>
                {summary.streakDays > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-700 dark:text-amber-300">
                        <Flame className="h-3.5 w-3.5" aria-hidden="true" />
                        {copy.streakBadge.replace("{days}", String(summary.streakDays))}
                    </span>
                )}
            </div>

            <form onSubmit={handleAdd} className="flex flex-wrap items-center gap-2">
                <select
                    value={subjectKey}
                    onChange={(e) => setSubjectKey(e.target.value as HomeworkSubjectKey)}
                    className="h-9 rounded-lg border border-input bg-background px-2.5 text-xs font-medium"
                >
                    {HOMEWORK_SUBJECTS.map((key) => (
                        <option key={key} value={key}>{copy.subjects[key]}</option>
                    ))}
                </select>
                <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as HomeworkCategory)}
                    className="h-9 rounded-lg border border-input bg-background px-2.5 text-xs font-medium"
                >
                    {HOMEWORK_CATEGORIES.map((cat) => (
                        <option key={cat} value={cat}>{copy.categories[cat]}</option>
                    ))}
                </select>
                <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={copy.titlePlaceholder}
                    className="h-9 min-w-48 flex-1 text-sm"
                />
                <Input
                    type="number"
                    min={1}
                    max={480}
                    value={minutes}
                    onChange={(e) => setMinutes(e.target.value)}
                    placeholder={copy.minutesPlaceholder}
                    className="h-9 w-20 text-sm"
                />
                <Button type="submit" size="sm" disabled={submitting || !title.trim()}>
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    {copy.addButton}
                </Button>
            </form>

            {!data && !error ? (
                <p className="text-sm text-muted-foreground" role="status">{t.common.loading}</p>
            ) : items.length === 0 ? (
                <p className="text-sm text-muted-foreground">{copy.empty}</p>
            ) : (
                <ul className="divide-y divide-border/60">
                    {items.map((item) => (
                        <li key={item.id} className="flex items-center justify-between gap-3 py-2.5">
                            <button
                                type="button"
                                onClick={() => void toggleItem(item)}
                                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                            >
                                {item.completed ? (
                                    <CheckCircle2 className="h-4.5 w-4.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                                ) : (
                                    <Circle className="h-4.5 w-4.5 shrink-0 text-muted-foreground" />
                                )}
                                <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                                    {copy.subjects[item.subjectKey] ?? item.subjectKey}
                                </span>
                                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                                    {copy.categories[item.category] ?? item.category}
                                </span>
                                <span className={`truncate text-sm ${item.completed ? "line-through text-muted-foreground" : "font-medium"}`}>
                                    {item.title}
                                </span>
                                {item.estimatedMinutes && (
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        {item.estimatedMinutes}m
                                    </span>
                                )}
                            </button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                                onClick={() => void removeItem(item.id)}
                                aria-label={copy.deleteLabel}
                            >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
        </section>
    );
}
