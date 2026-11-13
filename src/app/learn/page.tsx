"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
    BookOpen, CalendarCheck, Check, ChevronDown, ChevronUp, Flag, Lock, LockOpen,
    PenLine, RefreshCw, Route, Sparkles,
} from "lucide-react";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient, ApiError } from "@/lib/api-client";
import { getApiErrorMessage } from "@/lib/error-message";
import { frontendLogger } from "@/lib/frontend-logger";
import { usePageTitle } from "@/lib/page-title";
import { cn } from "@/lib/utils";
import type { StepType } from "@/lib/learning-path/types";

type Tab = "today" | "path" | "class";

interface PathStep {
    id?: string;
    position?: number;
    type: StepType;
    title: string;
    reason: string;
    knowledgePoints: string[];
    errorItemIds: string[];
    href?: string | null;
    status: "pending" | "in_progress" | "completed" | "skipped";
    locked: boolean;
    teacherNote?: string | null;
    variantRunId?: string | null;
    fingerprint?: string;
}

interface PathView {
    id: string;
    studentKey: string;
    studentName: string;
    classId: string | null;
    version: number;
    planReason: string | null;
    plannedAt: string;
    steps: PathStep[];
    today: PathStep[];
    mastery: Array<{ knowledgePoint: string; score: number; evidenceCount: number; dueAt: string | null }>;
    replanned?: boolean;
}

interface ClassView {
    classId?: string | null;
    className?: string;
    classes?: Array<{ id: string; name: string; _count?: { students: number } }>;
    students?: Array<{
        studentId: string;
        name: string;
        studentNo?: string | null;
        pathId: string;
        weakCount: number;
        averageMastery: number;
        nextStep: PathStep | null;
    }>;
    classWeaknesses?: Array<{ knowledgePoint: string; studentCount: number; averageScore: number }>;
}

const TYPE_ICON = {
    review_explanation: BookOpen,
    variant_practice: PenLine,
    spaced_review: CalendarCheck,
    checkpoint: Flag,
} as const;

function scoreLabel(score: number) {
    return `${Math.round(score * 100)}%`;
}

function LearnPage() {
    const { t, language } = useLanguage();
    const router = useRouter();
    const params = useSearchParams();
    usePageTitle(t.learn.title);

    const [tab, setTab] = useState<Tab>((params.get("tab") as Tab) || "today");
    const [studentKey, setStudentKey] = useState(params.get("studentKey") || "self");
    const [classId, setClassId] = useState(params.get("classId") || "");
    const [path, setPath] = useState<PathView | null>(null);
    const [classView, setClassView] = useState<ClassView | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const requestSeq = useRef(0);

    const langQuery = language === "en" ? "en" : "zh";

    const loadPath = useCallback(async (key: string, opts: { replan?: boolean } = {}) => {
        const seq = ++requestSeq.current;
        setLoading(true);
        setError(null);
        try {
            const query = new URLSearchParams({ studentKey: key, language: langQuery });
            if (opts.replan) query.set("replan", "1");
            const data = await apiClient.get<PathView>(`/api/learning-path?${query}`);
            if (seq !== requestSeq.current) return;
            setPath(data);
            setStudentKey(data.studentKey);
        } catch (err) {
            if (seq !== requestSeq.current) return;
            frontendLogger.error("[Learn]", "Failed to load path", { error: err });
            setError(getApiErrorMessage(err) || t.learn.loadError);
        } finally {
            if (seq === requestSeq.current) setLoading(false);
        }
    }, [langQuery, t.learn.loadError]);

    const loadClass = useCallback(async (id?: string) => {
        setError(null);
        try {
            const query = new URLSearchParams({ language: langQuery });
            if (id) query.set("classId", id);
            const data = await apiClient.get<ClassView>(`/api/learning-path/class?${query}`);
            setClassView(data);
            if (data.classId) setClassId(data.classId);
        } catch (err) {
            frontendLogger.error("[Learn]", "Failed to load class paths", { error: err });
            setError(getApiErrorMessage(err) || t.learn.loadError);
        }
    }, [langQuery, t.learn.loadError]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 进入页面或切换学生时拉取路径
        loadPath(studentKey);
    }, [studentKey, loadPath]);

    useEffect(() => {
        if (tab !== "class") return;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 切换到班级页或更换班级时拉取总览
        void loadClass(classId || undefined);
    }, [tab, classId, loadClass]);

    const patch = async (stepId: string, body: Record<string, unknown>) => {
        setBusy(true);
        try {
            const next = await apiClient.patch<PathView>(`/api/learning-path/steps/${stepId}`, body);
            setPath(next);
        } catch (err) {
            frontendLogger.error("[Learn]", "Failed to update step", { error: err });
            setError(getApiErrorMessage(err) || t.learn.loadError);
        } finally {
            setBusy(false);
        }
    };

    const handleReplan = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const next = await apiClient.post<PathView>("/api/learning-path", { action: "replan", studentKey, language: langQuery });
            setPath(next);
            setMessage(t.learn.replanned);
        } catch (err) {
            setError(getApiErrorMessage(err) || t.learn.loadError);
        } finally {
            setBusy(false);
        }
    };

    const handleSuggest = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const result = await apiClient.post<{ suggestion: { order: string[]; usedAi: boolean }; path: PathView }>("/api/learning-path", {
                action: "suggest-order", studentKey, language: langQuery,
            });
            setMessage(`${t.learn.suggestUsed} ${result.suggestion.order.join(language === "en" ? ", " : "、")}`);
        } catch (err) {
            if (err instanceof ApiError && err.status === 429) setMessage(t.learn.suggestCapped);
            else setError(getApiErrorMessage(err) || t.learn.loadError);
        } finally {
            setBusy(false);
        }
    };

    const tabs = useMemo(() => {
        const options: Array<{ value: Tab; label: string }> = [
            { value: "today", label: t.learn.tabToday },
            { value: "path", label: t.learn.tabPath },
            { value: "class", label: t.learn.tabClass },
        ];
        return options;
    }, [t.learn.tabToday, t.learn.tabPath, t.learn.tabClass]);

    const visibleSteps = tab === "today" ? (path?.today ?? []) : (path?.steps ?? []);
    const openCount = path?.today.length ?? 0;

    const ctaFor = (step: PathStep) => {
        if (step.type === "review_explanation") {
            const href = step.href || (step.errorItemIds[0] ? `/error-items/${step.errorItemIds[0]}` : null);
            return href ? { href, label: t.learn.openExplanation } : null;
        }
        if (step.type === "variant_practice") {
            const href = step.href || (step.errorItemIds[0] ? `/practice?itemId=${step.errorItemIds[0]}` : "/variants");
            return { href, label: t.learn.generateVariant };
        }
        if (step.type === "spaced_review") return { href: "/review", label: t.learn.openReview };
        return { href: "/practice", label: t.learn.openPractice };
    };

    return (
        <PageContainer className="space-y-6 pb-24 md:pb-8">
            <PageHeader
                title={tab === "class" ? t.learn.classTitle : t.learn.title}
                description={tab === "class" ? t.learn.classSubtitle : t.learn.subtitle}
            />
            <div className="flex flex-wrap items-center gap-2">
                {path && (
                    <Badge variant="outline" className="tabular-nums">
                        {t.learn.version.replace("{version}", String(path.version))}
                    </Badge>
                )}
                <Button type="button" variant="outline" size="sm" onClick={handleSuggest} loading={busy} loadingText={t.common.pleaseWait}>
                    <Sparkles className="h-4 w-4" aria-hidden="true" />
                    {t.learn.suggestOrder}
                </Button>
                <Button type="button" size="sm" onClick={handleReplan} loading={busy} loadingText={t.common.pleaseWait}>
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    {t.learn.replan}
                </Button>
            </div>

            <SegmentedControl
                ariaLabel={t.learn.title}
                value={tab}
                onChange={setTab}
                options={tabs}
            />

            {studentKey !== "self" && path && tab !== "class" && (
                <p className="text-sm text-muted-foreground">
                    {path.studentName}
                    <Button type="button" variant="link" className="ml-2 h-auto p-0" onClick={() => { setStudentKey("self"); setTab("today"); }}>
                        {t.learn.me}
                    </Button>
                </p>
            )}

            {message && <p className="text-sm text-primary" role="status">{message}</p>}
            {path?.planReason && tab !== "class" && (
                <p className="text-sm text-muted-foreground">{t.learn.planReason}：{path.planReason}</p>
            )}

            {tab !== "class" ? (
                <AsyncBoundary
                    loading={loading && !path}
                    error={error}
                    hasData={Boolean(path)}
                    onRetry={() => loadPath(studentKey)}
                    emptyFallback={
                        <EmptyState
                            icon={Route}
                            title={t.learn.empty}
                            description={t.learn.emptyHint}
                            action={<Button type="button" onClick={handleReplan}>{t.learn.replan}</Button>}
                        />
                    }
                    empty={Boolean(path) && visibleSteps.length === 0 && openCount === 0 && (path?.steps.length ?? 0) === 0}
                >
                    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
                        <ol className="space-y-3">
                            {visibleSteps.length === 0 && (
                                <EmptyState icon={Route} title={t.learn.empty} description={t.learn.emptyHint} />
                            )}
                            {visibleSteps.map((step, index) => {
                                const Icon = TYPE_ICON[step.type];
                                const cta = ctaFor(step);
                                const done = step.status === "completed" || step.status === "skipped";
                                return (
                                    <li key={step.id || `${step.fingerprint ?? index}`} className="surface-paper rounded-2xl border bg-card p-4 sm:p-5">
                                        <div className="flex items-start gap-3">
                                            <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", done ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary")}>
                                                <Icon className="h-5 w-5" aria-hidden="true" />
                                            </div>
                                            <div className="min-w-0 flex-1 space-y-2">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <h2 className="text-base font-semibold tracking-tight sm:text-lg">{step.title}</h2>
                                                    <Badge variant="secondary">{t.learn.types[step.type]}</Badge>
                                                    <Badge variant={done ? "outline" : "default"}>{t.learn.status[step.status]}</Badge>
                                                    {step.locked && <Badge variant="outline"><Lock className="mr-1 h-3 w-3" aria-hidden="true" />{t.learn.locked}</Badge>}
                                                </div>
                                                <p className="text-sm text-muted-foreground">{step.reason}</p>
                                                {step.type === "checkpoint" && !done && (
                                                    <p className="text-sm text-muted-foreground">{t.learn.checkpointHint}</p>
                                                )}
                                                <div className="flex flex-wrap gap-1.5">
                                                    {step.knowledgePoints.map((point) => (
                                                        <Badge key={point} variant="outline">{point}</Badge>
                                                    ))}
                                                </div>
                                                {step.teacherNote && <p className="text-sm">{t.learn.teacherNote}：{step.teacherNote}</p>}
                                                <div className="flex flex-wrap gap-2 pt-1">
                                                    {cta && !done && (
                                                        <Button asChild size="sm">
                                                            <Link href={cta.href} onClick={() => step.id && patch(step.id, { action: "start" })}>{cta.label}</Link>
                                                        </Button>
                                                    )}
                                                    {step.id && !done && (
                                                        <Button type="button" size="sm" variant="secondary" onClick={() => patch(step.id!, { action: "complete" })} loading={busy}>
                                                            <Check className="h-4 w-4" aria-hidden="true" />
                                                            {t.learn.complete}
                                                        </Button>
                                                    )}
                                                    {tab === "path" && step.id && (
                                                        <>
                                                            <Button type="button" size="sm" variant="ghost" onClick={() => patch(step.id!, { action: step.locked ? "unlock" : "lock" })}>
                                                                {step.locked ? <LockOpen className="h-4 w-4" aria-hidden="true" /> : <Lock className="h-4 w-4" aria-hidden="true" />}
                                                                {step.locked ? t.learn.unlock : t.learn.lock}
                                                            </Button>
                                                            <Button type="button" size="sm" variant="ghost" onClick={() => patch(step.id!, { action: "move", direction: "up" })} aria-label={t.learn.moveUp}>
                                                                <ChevronUp className="h-4 w-4" aria-hidden="true" />
                                                            </Button>
                                                            <Button type="button" size="sm" variant="ghost" onClick={() => patch(step.id!, { action: "move", direction: "down" })} aria-label={t.learn.moveDown}>
                                                                <ChevronDown className="h-4 w-4" aria-hidden="true" />
                                                            </Button>
                                                            {!done && (
                                                                <Button type="button" size="sm" variant="ghost" onClick={() => patch(step.id!, { action: "skip" })}>{t.learn.skip}</Button>
                                                            )}
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </li>
                                );
                            })}
                        </ol>
                        <aside className="space-y-3">
                            <h2 className="text-sm font-semibold">{t.learn.mastery}</h2>
                            <ul className="space-y-2">
                                {(path?.mastery ?? []).slice(0, 8).map((item) => (
                                    <li key={item.knowledgePoint} className="rounded-xl border bg-card px-3 py-2">
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="truncate text-sm font-medium">{item.knowledgePoint}</span>
                                            <span className="tabular-nums text-sm">{scoreLabel(item.score)}</span>
                                        </div>
                                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                                            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(item.score * 100)}%` }} />
                                        </div>
                                        <p className="mt-1 text-xs text-muted-foreground">{t.learn.evidence.replace("{count}", String(item.evidenceCount))}</p>
                                    </li>
                                ))}
                            </ul>
                        </aside>
                    </div>
                </AsyncBoundary>
            ) : (
                <AsyncBoundary
                    loading={!classView && !error}
                    error={error}
                    hasData={Boolean(classView)}
                    onRetry={() => loadClass(classId || undefined)}
                    emptyFallback={<EmptyState icon={Route} title={t.learn.noClasses} />}
                    empty={Boolean(classView) && (classView?.classes?.length ?? 0) === 0 && !classView?.classId}
                >
                    {classView && (
                        <div className="space-y-5">
                            {(classView.classes?.length ?? 0) > 1 && (
                                <label className="block text-sm">
                                    <span className="mb-1 block text-muted-foreground">{t.learn.tabClass}</span>
                                    <select
                                        className="h-9 rounded-lg border bg-background px-3 text-sm"
                                        value={classView.classId || classId}
                                        onChange={(event) => setClassId(event.target.value)}
                                    >
                                        {classView.classes!.map((item) => (
                                            <option key={item.id} value={item.id}>{item.name}</option>
                                        ))}
                                    </select>
                                </label>
                            )}
                            {classView.classWeaknesses && classView.classWeaknesses.length > 0 && (
                                <section className="space-y-2">
                                    <h2 className="text-sm font-semibold">{t.learn.commonWeaknesses}</h2>
                                    <div className="flex flex-wrap gap-2">
                                        {classView.classWeaknesses.map((item) => (
                                            <Badge key={item.knowledgePoint} variant="secondary">
                                                {item.knowledgePoint} · {item.studentCount}
                                            </Badge>
                                        ))}
                                    </div>
                                </section>
                            )}
                            <section className="space-y-2">
                                <h2 className="text-sm font-semibold">{t.learn.students}</h2>
                                <ul className="divide-y rounded-2xl border bg-card">
                                    {(classView.students ?? []).map((student) => (
                                        <li key={student.studentId}>
                                            <button
                                                type="button"
                                                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-accent/50"
                                                onClick={() => { setStudentKey(student.studentId); setTab("path"); router.replace(`/learn?studentKey=${student.studentId}`); }}
                                            >
                                                <span>
                                                    <span className="font-medium">{student.name}</span>
                                                    {student.studentNo && <span className="ml-2 text-xs text-muted-foreground">{student.studentNo}</span>}
                                                </span>
                                                <span className="text-right text-xs text-muted-foreground">
                                                    {t.learn.weakCount.replace("{count}", String(student.weakCount))}
                                                    <br />
                                                    {t.learn.avgMastery.replace("{score}", scoreLabel(student.averageMastery))}
                                                    {student.nextStep && <><br />{t.learn.nextStep}：{student.nextStep.title}</>}
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        </div>
                    )}
                </AsyncBoundary>
            )}
        </PageContainer>
    );
}

export default function LearnPageRoute() {
    return (
        <Suspense>
            <LearnPage />
        </Suspense>
    );
}
