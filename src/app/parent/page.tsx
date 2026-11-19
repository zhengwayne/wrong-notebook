"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { BookOpen, CalendarCheck, Camera, FileText, Route, Users } from "lucide-react";
import { ChildLearnersManager } from "@/components/child-learners-manager";
import { HomeSection, MasteryList, PracticeTrendChart, TodayStepList, WeakPointList } from "@/components/home/home-panels";
import { DailyHomeworkCard } from "@/components/parent/daily-homework-card";
import { ParentKidModeCard } from "@/components/parent/kid-mode-lock-bar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { PageLoading } from "@/components/ui/page-loading";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { getApiErrorMessage } from "@/lib/error-message";
import { frontendLogger } from "@/lib/frontend-logger";
import { useCurrentChild } from "@/lib/use-current-child";
import { usePageTitle } from "@/lib/page-title";
import { withChildParam } from "@/lib/current-child";
import type { PracticeTrendDay } from "@/lib/home-aggregates";
import type { ParentPaperSummary } from "@/lib/parent-papers";
import { parentPaperStatusClass, parentPaperStatusLabel } from "@/lib/parent-paper-status";

interface ParentHomeData {
    children: Array<{ id: string; name: string; itemCount: number }>;
    selectedLearnerId: string | null;
    child: {
        id: string;
        name: string;
        weakPoints: Array<{ knowledgePoint: string; itemCount: number; unmasteredCount?: number; score?: number }>;
        mastery: Array<{ knowledgePoint: string; score: number; evidenceCount: number; dueAt: string | null }>;
        today: Array<{ id?: string; title: string; reason?: string; type: string; status: string; knowledgePoints?: string[] }>;
        practiceTrend: PracticeTrendDay[];
        practiceSummary: { attempted: number; correct: number };
        latestPaper: ParentPaperSummary | null;
    } | null;
}

function ParentHome() {
    const { t, language } = useLanguage();
    const copy = t.persona.parentHome;
    const router = useRouter();
    const params = useSearchParams();
    usePageTitle(t.pageTitle.parentHome);
    const { setLearner, hrefWithChild } = useCurrentChild();
    const learnerId = params.get("learnerId") || "";
    const paramsString = params.toString();
    const [data, setData] = useState<ParentHomeData | null>(null);
    const [loadedFor, setLoadedFor] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [managing, setManaging] = useState(false);

    const requestSeq = useRef(0);
    const load = useCallback(async (id?: string) => {
        const seq = ++requestSeq.current;
        setError(null);
        try {
            const query = new URLSearchParams({ language: language === "en" ? "en" : "zh" });
            if (id) query.set("learnerId", id);
            const result = await apiClient.get<ParentHomeData>(`/api/parent/home?${query}`);
            if (seq !== requestSeq.current) return;
            const effectiveId = result.child?.id ?? result.selectedLearnerId ?? "";
            setLoadedFor(id || "");
            setData(result);
            if (result.child) setLearner({ id: result.child.id, name: result.child.name });
            else if (result.selectedLearnerId) setLearner(result.selectedLearnerId);
            else setLearner(null);

            // 若当前 URL 指向已归档/失效的孩子，自动切换到后端选中的首个活跃孩子或清空 URL 参数
            if (id && effectiveId !== id) {
                const nextQuery = new URLSearchParams(paramsString);
                if (effectiveId) nextQuery.set("learnerId", effectiveId);
                else nextQuery.delete("learnerId");
                const qs = nextQuery.toString();
                router.replace(qs ? `/parent?${qs}` : "/parent", { scroll: false });
            }
        } catch (err) {
            if (seq !== requestSeq.current) return;
            frontendLogger.error("[ParentHome]", "Failed to load parent home", { error: err });
            setError(getApiErrorMessage(err) || copy.loadError);
        }
    }, [language, copy.loadError, setLearner, paramsString, router]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 进入页面或切换孩子时拉取首页数据
        void load(learnerId || undefined);
    }, [learnerId, load]);

    const selectChild = (id: string) => {
        const query = new URLSearchParams(params.toString());
        query.set("learnerId", id);
        router.replace(`/parent?${query.toString()}`, { scroll: false });
    };

    if (!data && !error) return <PageLoading />;

    const children = data?.children ?? [];
    const child = loadedFor === learnerId ? data?.child : null;
    const selectedId = child?.id || learnerId || children[0]?.id || "";
    const followUps = child ? [
        { href: hrefWithChild("/review"), icon: CalendarCheck, title: copy.review, desc: copy.todayDesc },
        { href: hrefWithChild("/notebooks"), icon: BookOpen, title: copy.practice, desc: copy.practiceDesc },
        { href: hrefWithChild("/learn"), icon: Route, title: copy.path, desc: copy.pathDesc },
        { href: withChildParam("/parent/papers", child.id), icon: FileText, title: copy.viewPapers, desc: copy.uploadDesc },
    ] : [];

    return (
        <PageContainer>
            <div className="mx-auto max-w-5xl space-y-8 py-6">
                <PageHeader
                    title={copy.title}
                    description={error || copy.desc}
                    actions={(
                        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                            {selectedId && (
                                <Button asChild className="w-full sm:w-auto">
                                    <Link href={withChildParam("/parent/papers/new", selectedId)}>
                                        <Camera className="h-4 w-4" aria-hidden="true" />
                                        {copy.upload}
                                    </Link>
                                </Button>
                            )}
                            <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setManaging((open) => !open)}>
                                {managing ? copy.hideManage : copy.manageChildren}
                            </Button>
                        </div>
                    )}
                />

                {managing && <ChildLearnersManager onChanged={() => void load(learnerId || undefined)} />}

                {children.length === 0 ? (
                    <>
                        {!managing && <ChildLearnersManager onChanged={() => void load(learnerId || undefined)} />}
                        <EmptyState icon={Users} title={copy.empty} className="py-8" />
                    </>
                ) : (
                    <>
                        {children.length > 1 && (
                            <SegmentedControl
                                ariaLabel={copy.selectChild}
                                value={selectedId}
                                onChange={selectChild}
                                options={children.map((item) => ({ value: item.id, label: item.name }))}
                            />
                        )}
                        {children.length === 1 && (
                            <h2 className="text-lg font-semibold">{children[0].name}</h2>
                        )}

                        {!child && !error && loadedFor !== learnerId && <PageLoading />}
                        {child && (
                            <div key={child.id} className="space-y-8">
                                <ParentKidModeCard learnerId={child.id} learnerName={child.name} />
                                <DailyHomeworkCard learnerId={child.id} />
                                {child.latestPaper ? (
                                    <HomeSection title={copy.latestPaper}>
                                        <Link
                                            href={withChildParam(`/parent/papers/${child.latestPaper.id}`, child.id)}
                                            className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/50"
                                        >
                                            <div className="min-w-0">
                                                <div className="truncate font-semibold">{child.latestPaper.title || t.parentPapers.untitled}</div>
                                                <p className="mt-1 text-sm text-muted-foreground">
                                                    {t.parentPapers.pageCount.replace("{count}", String(child.latestPaper.pageCount))}
                                                </p>
                                            </div>
                                            <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${parentPaperStatusClass(child.latestPaper.status)}`}>
                                                {parentPaperStatusLabel(t.parentPapers, child.latestPaper.status)}
                                            </span>
                                        </Link>
                                    </HomeSection>
                                ) : (
                                    <HomeSection title={copy.latestPaper}>
                                        <p className="text-sm text-muted-foreground">{copy.latestPaperEmpty}</p>
                                    </HomeSection>
                                )}
                                <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
                                    <HomeSection title={copy.weakPoints}>
                                        <WeakPointList items={child.weakPoints} empty={copy.noWeakPoints} />
                                    </HomeSection>
                                    <HomeSection title={copy.mastery}>
                                        <MasteryList items={child.mastery} empty={copy.noMastery} />
                                    </HomeSection>
                                </div>
                                <HomeSection title={copy.practiceTrend}>
                                    <PracticeTrendChart days={child.practiceTrend} empty={copy.noTrend} />
                                    {child.practiceSummary.attempted > 0 && (
                                        <p className="text-xs text-muted-foreground">
                                            {copy.attempted.replace("{count}", String(child.practiceSummary.attempted))}
                                            {" · "}
                                            {copy.correctRate.replace("{rate}", `${Math.round((child.practiceSummary.correct / child.practiceSummary.attempted) * 100)}%`)}
                                        </p>
                                    )}
                                </HomeSection>
                                <HomeSection title={copy.todayTasks}>
                                    <TodayStepList steps={child.today} empty={copy.noToday} studentKey={child.id} />
                                </HomeSection>
                            </div>
                        )}

                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            {followUps.map((link) => {
                                const Icon = link.icon;
                                return (
                                    <Link
                                        key={link.href}
                                        href={link.href}
                                        className="rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/50"
                                    >
                                        <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
                                        <div className="mt-3 text-sm font-semibold">{link.title}</div>
                                        <p className="mt-1 text-sm text-muted-foreground">{link.desc}</p>
                                    </Link>
                                );
                            })}
                        </div>
                    </>
                )}
            </div>
        </PageContainer>
    );
}

export default function ParentHomePage() {
    return (
        <Suspense fallback={<PageLoading />}>
            <ParentHome />
        </Suspense>
    );
}
