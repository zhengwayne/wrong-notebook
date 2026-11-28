"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ClipboardCheck, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { PageLoading } from "@/components/ui/page-loading";
import { CauseList, ErrorRateList, HomeSection, scoreLabel } from "@/components/home/home-panels";
import { ClassMasteryHeatmap } from "@/components/teacher/class-mastery-heatmap";
import { OnboardingCard } from "@/components/onboarding/onboarding-card";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import type { ClassMasteryMatrix } from "@/lib/class-mastery-matrix";
import { getApiErrorMessage } from "@/lib/error-message";
import { frontendLogger } from "@/lib/frontend-logger";
import { useOnboarding } from "@/lib/onboarding-client";
import { usePageTitle } from "@/lib/page-title";
import { cn } from "@/lib/utils";
import type { ClassCollectionStatus, ErrorCauseCount, KnowledgeErrorRate } from "@/lib/home-aggregates";

interface TeacherHomeData {
    classes: ClassCollectionStatus[];
    selectedClassId: string | null;
    stats: {
        classId: string;
        className: string;
        errorRates: KnowledgeErrorRate[];
        frequentCauses: ErrorCauseCount[];
        classWeaknesses: Array<{ knowledgePoint: string; studentCount: number; averageScore: number; totalItems: number }>;
        students: Array<{
            studentId: string;
            name: string;
            studentNo?: string | null;
            weakCount: number;
            averageMastery: number;
            nextStep: { title: string } | null;
        }>;
        matrix?: ClassMasteryMatrix;
    } | null;
}

function TeacherHome() {
    const { t } = useLanguage();
    const copy = t.persona.teacherHome;
    const router = useRouter();
    const params = useSearchParams();
    usePageTitle(t.pageTitle.teacherHome);
    const classId = params.get("classId") || "";
    const [data, setData] = useState<TeacherHomeData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const { status: onboarding } = useOnboarding("teacher");

    const load = useCallback(async (id?: string) => {
        setError(null);
        try {
            const query = id ? `?classId=${encodeURIComponent(id)}` : "";
            const result = await apiClient.get<TeacherHomeData>(`/api/teacher/home${query}`);
            setData(result);
        } catch (err) {
            frontendLogger.error("[TeacherHome]", "Failed to load teacher home", { error: err });
            setError(getApiErrorMessage(err) || t.learn.loadError);
        }
    }, [t.learn.loadError]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 进入页面或切换班级时拉取首页数据
        void load(classId || undefined);
    }, [classId, load]);

    const selectClass = (id: string) => {
        const query = new URLSearchParams(params.toString());
        query.set("classId", id);
        router.replace(`/teacher?${query.toString()}`, { scroll: false });
    };

    if (!data && !error) return <PageLoading />;

    const selectedId = data?.selectedClassId || classId;
    const stats = data?.stats;

    return (
        <PageContainer>
            <div className="mx-auto max-w-5xl space-y-8 py-6">
                <PageHeader
                    title={copy.title}
                    description={error || copy.desc}
                    actions={(
                        <Button asChild variant="outline">
                            <Link href="/grading"><ClipboardCheck className="h-4 w-4" />{copy.gradingCta}</Link>
                        </Button>
                    )}
                />

                <OnboardingCard persona="teacher" />

                {!data || data.classes.length === 0 ? (
                    onboarding?.visible ? null : (
                        <EmptyState
                            icon={Users}
                            title={copy.emptyClasses}
                            className="py-12"
                            action={<Button asChild><Link href="/grading#roster"><Users className="h-4 w-4" aria-hidden="true" />{t.onboarding.teacher.emptyHome}</Link></Button>}
                        />
                    )
                ) : (
                    <>
                        <section className="grid gap-3 md:grid-cols-2">
                            {data.classes.map((cls) => {
                                const selected = cls.id === selectedId;
                                return (
                                    <button
                                        key={cls.id}
                                        type="button"
                                        onClick={() => selectClass(cls.id)}
                                        className="text-left"
                                        aria-pressed={selected}
                                    >
                                        <Card className={cn(
                                            "h-full rounded-2xl transition-colors",
                                            selected ? "border-primary bg-accent/60" : "hover:border-primary/40",
                                        )}>
                                            <CardContent className="space-y-2 pt-4">
                                                <div className="flex items-center gap-2 font-medium">
                                                    <Users className="h-4 w-4 shrink-0 text-primary" />
                                                    {cls.name}
                                                </div>
                                                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                                    <span>{copy.rosterSize.replace("{count}", String(cls.studentCount))}</span>
                                                    {cls.latestTask ? (
                                                        <>
                                                            <span>{copy.latestTask.replace("{title}", cls.latestTask.title)}</span>
                                                            <span>{copy.submitted.replace("{count}", `${cls.latestTask.submissionCount}/${cls.latestTask.studentCount}`)}</span>
                                                            <span>{copy.confirmed.replace("{count}", String(cls.latestTask.confirmedCount))}</span>
                                                        </>
                                                    ) : (
                                                        <span>{copy.noTask}</span>
                                                    )}
                                                </div>
                                                {cls.latestTask && (
                                                    <Link
                                                        href={`/grading/${cls.latestTask.id}`}
                                                        className="inline-block text-xs font-medium text-primary hover:underline"
                                                        onClick={(event) => event.stopPropagation()}
                                                    >
                                                        {copy.openTask}
                                                    </Link>
                                                )}
                                            </CardContent>
                                        </Card>
                                    </button>
                                );
                            })}
                        </section>

                        {stats && (
                            <div className="space-y-8">
                                <HomeSection title={copy.classStats}>
                                    {stats.errorRates.length === 0 && stats.frequentCauses.length === 0 && stats.classWeaknesses.length === 0 ? (
                                        <p className="text-sm text-muted-foreground">{copy.noStats}</p>
                                    ) : (
                                        <div className="grid gap-6 lg:grid-cols-2">
                                            <div className="space-y-2">
                                                <h3 className="text-xs font-medium text-muted-foreground">{copy.errorRateByPoint}</h3>
                                                <ErrorRateList items={stats.errorRates} empty={copy.noStats} />
                                            </div>
                                            <div className="space-y-4">
                                                <div className="space-y-2">
                                                    <h3 className="text-xs font-medium text-muted-foreground">{copy.frequentCauses}</h3>
                                                    <CauseList items={stats.frequentCauses} empty={copy.noStats} />
                                                </div>
                                                <div className="space-y-2">
                                                    <h3 className="text-xs font-medium text-muted-foreground">{copy.commonMistakes}</h3>
                                                    {stats.classWeaknesses.length === 0 ? (
                                                        <p className="text-sm text-muted-foreground">{copy.noStats}</p>
                                                    ) : (
                                                        <div className="flex flex-wrap gap-2">
                                                            {stats.classWeaknesses.map((item) => (
                                                                <Badge key={item.knowledgePoint} variant="secondary">
                                                                    {item.knowledgePoint} · {copy.studentCount.replace("{count}", String(item.studentCount))}
                                                                </Badge>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </HomeSection>

                                {stats.matrix && (
                                    <HomeSection title={t.classHeatmap.title}>
                                        <ClassMasteryHeatmap classId={stats.classId} matrix={stats.matrix} />
                                    </HomeSection>
                                )}

                                <HomeSection title={copy.students}>
                                    <ul className="divide-y rounded-2xl border border-border bg-card">
                                        {stats.students.map((student) => (
                                            <li key={student.studentId}>
                                                <Link
                                                    href={`/teacher/students/${student.studentId}`}
                                                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-accent/50"
                                                >
                                                    <span>
                                                        <span className="font-medium">{student.name}</span>
                                                        {student.studentNo && (
                                                            <span className="ml-2 text-xs text-muted-foreground">{student.studentNo}</span>
                                                        )}
                                                    </span>
                                                    <span className="text-right text-xs text-muted-foreground">
                                                        {t.learn.weakCount.replace("{count}", String(student.weakCount))}
                                                        <br />
                                                        {t.learn.avgMastery.replace("{score}", scoreLabel(student.averageMastery))}
                                                        {student.nextStep && (
                                                            <>
                                                                <br />
                                                                {t.learn.nextStep}：{student.nextStep.title}
                                                            </>
                                                        )}
                                                    </span>
                                                </Link>
                                            </li>
                                        ))}
                                    </ul>
                                </HomeSection>
                            </div>
                        )}
                    </>
                )}
            </div>
        </PageContainer>
    );
}

export default function TeacherHomePage() {
    return (
        <Suspense fallback={<PageLoading />}>
            <TeacherHome />
        </Suspense>
    );
}
