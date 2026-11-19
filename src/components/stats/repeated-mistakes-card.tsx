"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Repeat, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { withChildParam } from "@/lib/current-child";
import { frontendLogger } from "@/lib/frontend-logger";
import type { MasteryStatus } from "@/lib/mastery-status";
import { useCurrentChild } from "@/lib/use-current-child";
import { cn } from "@/lib/utils";

export interface RepeatedMistakesItem {
    id: string;
    subjectName: string | null;
    preview: string | null;
    wrongCount: number;
    lastWrongAt: string | null;
    masteryStatus: MasteryStatus;
}

export interface RepeatedMistakesData {
    items: RepeatedMistakesItem[];
}

const MASTERY_BADGE: Record<MasteryStatus, string> = {
    new: "bg-warning/15 text-warning",
    reviewing: "bg-primary/10 text-primary",
    mastered: "bg-success/15 text-success",
};

/**
 * 练习统计「反复错题榜」：当前学习者做错 2 次及以上的题目，提示重点复习。
 * Ported from margrop/wrong-notebook 07e4dca9 (MIT).
 */
export function RepeatedMistakesCard() {
    const { t } = useLanguage();
    const { learnerId } = useCurrentChild();
    const [data, setData] = useState<RepeatedMistakesData | null>(null);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
        let cancelled = false;
        apiClient.get<RepeatedMistakesData>(withChildParam("/api/stats/repeated-mistakes", learnerId))
            .then((result) => {
                if (cancelled) return;
                setData(result);
                setFailed(false);
            })
            .catch((error) => {
                if (cancelled) return;
                frontendLogger.error("[RepeatedMistakes]", "Failed to load repeated mistakes", { error });
                setFailed(true);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, [learnerId, reloadKey]);

    const reload = useCallback(() => {
        setLoading(true);
        setReloadKey((key) => key + 1);
    }, []);

    const copy = t.repeatedMistakes;
    const masteryLabel = (status: MasteryStatus) =>
        status === "mastered" ? t.notebook.mastered : status === "reviewing" ? t.notebook.reviewing : t.notebook.review;

    return (
        <Card data-testid="repeated-mistakes-card">
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                    <Repeat className="h-4 w-4 text-primary" />
                    {copy.title}
                </CardTitle>
                <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
            </CardHeader>
            <CardContent>
                {loading ? (
                    <div className="flex justify-center py-8">
                        <Loader2 className="h-6 w-6 animate-spin text-primary" />
                    </div>
                ) : failed ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <span>{copy.loadFailed}</span>
                        <Button variant="ghost" size="sm" onClick={reload}>
                            <RotateCcw className="mr-1 h-3.5 w-3.5" />
                            {copy.retry}
                        </Button>
                    </div>
                ) : !data || data.items.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{copy.empty}</p>
                ) : (
                    <ol className="divide-y">
                        {data.items.map((item, index) => (
                            <li key={item.id}>
                                <Link href={`/error-items/${item.id}`} className="block rounded-md transition-colors hover:bg-accent/50">
                                    <div className="flex items-center gap-3 py-2.5">
                                        <span className="w-6 shrink-0 text-center text-sm font-medium text-muted-foreground">{index + 1}</span>
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm font-medium">{item.preview || copy.noPreview}</p>
                                            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                                {item.subjectName && <span>{item.subjectName}</span>}
                                                {item.lastWrongAt && <span>{copy.lastWrong.replace("{date}", item.lastWrongAt)}</span>}
                                            </div>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-2">
                                            <Badge variant="secondary" className="bg-destructive/10 text-destructive">
                                                {copy.wrongTimes.replace("{count}", String(item.wrongCount))}
                                            </Badge>
                                            <Badge variant="secondary" className={cn(MASTERY_BADGE[item.masteryStatus])}>
                                                {masteryLabel(item.masteryStatus)}
                                            </Badge>
                                        </div>
                                    </div>
                                </Link>
                            </li>
                        ))}
                    </ol>
                )}
            </CardContent>
        </Card>
    );
}
