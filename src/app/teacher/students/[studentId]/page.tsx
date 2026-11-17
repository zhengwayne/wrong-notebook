"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { PageLoading } from "@/components/ui/page-loading";
import { CauseList, HomeSection, MasteryList, TodayStepList, WeakPointList } from "@/components/home/home-panels";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { getApiErrorMessage } from "@/lib/error-message";
import { frontendLogger } from "@/lib/frontend-logger";
import { usePageTitle } from "@/lib/page-title";

interface StudentProfile {
    studentId: string;
    name: string;
    studentNo?: string | null;
    classId: string;
    className: string;
    mastery: Array<{ knowledgePoint: string; score: number; evidenceCount: number; dueAt: string | null }>;
    weakPoints: Array<{ knowledgePoint: string; itemCount: number; unmasteredCount?: number; score?: number }>;
    frequentCauses: Array<{ cause: string; count: number }>;
    recentWrong: Array<{
        id: string;
        questionText: string | null;
        errorType: string | null;
        knowledgePoints: string[];
        createdAt: string;
    }>;
    today: Array<{ id?: string; title: string; reason?: string; type: string; status: string; knowledgePoints?: string[] }>;
    path: { steps: Array<{ id?: string; title: string; reason?: string; type: string; status: string; knowledgePoints?: string[] }> } | null;
}

export default function TeacherStudentProfilePage() {
    const { t, language } = useLanguage();
    const copy = t.persona.teacherHome;
    const params = useParams<{ studentId: string }>();
    const studentId = params.studentId;
    const [data, setData] = useState<StudentProfile | null>(null);
    const [error, setError] = useState<string | null>(null);

    usePageTitle(t.pageTitle.teacherStudent, data?.name);

    useEffect(() => {
        let cancelled = false;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 进入页面或切换学生时拉取档案
        setError(null);
        apiClient.get<StudentProfile>(`/api/teacher/students/${studentId}?language=${language === "en" ? "en" : "zh"}`)
            .then((result) => {
                if (!cancelled) setData(result);
            })
            .catch((err) => {
                frontendLogger.error("[TeacherStudent]", "Failed to load student profile", { error: err });
                if (!cancelled) setError(getApiErrorMessage(err) || t.learn.loadError);
            });
        return () => {
            cancelled = true;
        };
    }, [studentId, language, t.learn.loadError]);

    if (!data && !error) return <PageLoading />;

    return (
        <PageContainer>
            <div className="mx-auto max-w-5xl space-y-8 py-6">
                <PageHeader
                    title={data?.name || copy.studentProfile}
                    description={error || `${data?.className ?? ""} · ${copy.studentDesc}`}
                    backHref={data ? `/teacher?classId=${data.classId}` : "/teacher"}
                    actions={data ? (
                        <Button asChild variant="outline">
                            <Link href={`/learn?studentKey=${encodeURIComponent(data.studentId)}`}>{copy.openPath}</Link>
                        </Button>
                    ) : undefined}
                />
                {data && (
                    <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
                        <div className="space-y-8">
                            <HomeSection title={copy.weakPoints}>
                                <WeakPointList items={data.weakPoints} empty={copy.noWeakPoints} />
                                {data.frequentCauses.length > 0 && (
                                    <div className="pt-2">
                                        <CauseList items={data.frequentCauses} empty={copy.noWeakPoints} />
                                    </div>
                                )}
                            </HomeSection>
                            <HomeSection title={copy.recentWrong}>
                                {data.recentWrong.length === 0 ? (
                                    <p className="text-sm text-muted-foreground">{copy.noRecent}</p>
                                ) : (
                                    <ul className="space-y-2">
                                        {data.recentWrong.map((item) => (
                                            <li key={item.id} className="rounded-xl border border-border bg-card p-3">
                                                <p className="line-clamp-3 text-sm">{item.questionText || copy.openQuestion}</p>
                                                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                                    {item.errorType && <span>{item.errorType}</span>}
                                                    {item.knowledgePoints.map((point) => <span key={point}>{point}</span>)}
                                                </div>
                                                <Link href={`/error-items/${item.id}`} className="mt-2 inline-block text-xs font-medium text-primary hover:underline">
                                                    {copy.openQuestion}
                                                </Link>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </HomeSection>
                            <HomeSection title={copy.todaySteps}>
                                <TodayStepList steps={data.today} empty={copy.noToday} studentKey={data.studentId} />
                            </HomeSection>
                            <HomeSection title={copy.learningPath}>
                                {data.path && data.path.steps.length > 0 ? (
                                    <TodayStepList steps={data.path.steps} empty={copy.noPath} />
                                ) : (
                                    <p className="text-sm text-muted-foreground">{copy.noPath}</p>
                                )}
                            </HomeSection>
                        </div>
                        <HomeSection title={copy.mastery}>
                            <MasteryList items={data.mastery} empty={copy.noMastery} />
                        </HomeSection>
                    </div>
                )}
            </div>
        </PageContainer>
    );
}
