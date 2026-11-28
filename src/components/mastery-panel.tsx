"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Sparkles } from "lucide-react";
import { PracticeRecordList } from "@/components/error-detail/practice-record-list";
export { RESULT_BADGE_CLASS } from "@/components/error-detail/practice-record-list";
import { PracticeRecordForm } from "@/components/practice-record-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { confirmDialog, toast } from "@/lib/feedback";
import { isMastered, type MasteryStatus } from "@/lib/mastery-status";
import type { PracticeHistoryResponse } from "@/types/api";

interface MasteryPanelProps {
    errorItemId: string;
    /** 复习状态加载或被评估更新后回调，用于同步页面上的状态标签 */
    onMasteryStatusChange?: (status: MasteryStatus) => void;
    /** 只读模式（如儿童专注锁）：隐藏 AI 重评、手动添加记录与删除记录入口 */
    readOnly?: boolean;
}

const POLL_INTERVAL_MS = 4000;
const MAX_POLLS = 20;

export function MasteryPanel({ errorItemId, onMasteryStatusChange, readOnly = false }: MasteryPanelProps) {
    const { t } = useLanguage();
    const [data, setData] = useState<PracticeHistoryResponse | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [polls, setPolls] = useState(0);
    const [adding, setAdding] = useState(false);
    const [evaluatingAi, setEvaluatingAi] = useState(false);

    const load = useCallback(() => {
        apiClient.get<PracticeHistoryResponse>(`/api/error-items/${errorItemId}/practice-records`)
            .then((result) => {
                setData(result);
                onMasteryStatusChange?.(result.masteryStatus);
            })
            // 记录加载失败不影响详情页其他内容
            .catch(() => undefined);
    }, [errorItemId, onMasteryStatusChange]);

    useEffect(load, [load]);

    const reload = () => {
        setPolls(0);
        load();
    };

    const deleteRecord = async (recordId: string) => {
        if (!(await confirmDialog(t.mastery.deleteRecordConfirm, { destructive: true }))) return;
        try {
            await apiClient.delete(`/api/practice/record/${recordId}`);
            reload();
        } catch {
            toast.error(t.mastery.deleteRecordFailed);
        }
    };

    const handleAiEvaluate = async () => {
        setEvaluatingAi(true);
        try {
            await apiClient.post(`/api/error-items/${errorItemId}/mastery`, {});
            reload();
        } catch {
            toast.error(t.mastery.aiEvaluateFailed);
        } finally {
            setEvaluatingAi(false);
        }
    };

    const latest = data?.records[0];
    const isPending = !!latest && (!data?.masteryEvaluatedAt || new Date(latest.createdAt) > new Date(data.masteryEvaluatedAt));

    // 有新记录等待规则评估落库时轮询
    useEffect(() => {
        if (!isPending || polls >= MAX_POLLS) return;
        const timer = setTimeout(() => {
            setPolls((count) => count + 1);
            load();
        }, POLL_INTERVAL_MS);
        return () => clearTimeout(timer);
    }, [isPending, polls, load]);

    if (!data) return null;

    const probability = data.masteryProbability;
    const percent = probability === null ? null : Math.round(probability * 100);
    const barColor = percent === null ? "" : isMastered(probability, data.masteryThreshold) ? "bg-green-500" : percent >= 30 ? "bg-amber-500" : "bg-red-500";

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Sparkles className="h-4 w-4 text-primary" />
                        {t.mastery.probability}
                    </CardTitle>
                    {!readOnly && data.records.length > 0 && (
                        <Button variant="outline" size="sm" onClick={handleAiEvaluate} disabled={evaluatingAi}>
                            {evaluatingAi ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
                            {evaluatingAi ? t.mastery.evaluatingWithAi : t.mastery.evaluateWithAi}
                        </Button>
                    )}
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                {percent === null ? (
                    <p className="text-sm text-muted-foreground">{isPending ? t.mastery.pending : t.mastery.notEvaluated}</p>
                ) : (
                    <div className="space-y-2">
                        <div className="flex items-baseline justify-between gap-2">
                            <span className="text-3xl font-bold">{percent}%</span>
                            <span className="flex items-center gap-2 text-xs text-muted-foreground">
                                {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                                <Badge variant="outline">{data.masterySource === "ai" ? t.mastery.aiEvaluated : t.mastery.estimated}</Badge>
                            </span>
                        </div>
                        <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                            <div className={`h-full ${barColor} transition-all`} style={{ width: `${percent}%` }} />
                        </div>
                        {data.masteryReason && <p className="text-sm text-muted-foreground">{data.masteryReason}</p>}
                        <p className="text-xs text-muted-foreground">{t.mastery.thresholdHint.replace("{threshold}", String(data.masteryThreshold))}</p>
                    </div>
                )}

                <div className="space-y-2 border-t pt-4">
                    <div className="flex items-center justify-between gap-2">
                        <h4 className="text-sm font-semibold">{t.mastery.history}</h4>
                        {!readOnly && !adding && (
                            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                                <Plus className="mr-1 h-4 w-4" />
                                {t.mastery.addRecord}
                            </Button>
                        )}
                    </div>
                    {!readOnly && adding && (
                        <PracticeRecordForm
                            errorItemId={errorItemId}
                            onCancel={() => setAdding(false)}
                            onSaved={() => {
                                setAdding(false);
                                reload();
                            }}
                        />
                    )}
                    <PracticeRecordList
                        records={data.records}
                        expanded={expanded}
                        onToggleExpand={setExpanded}
                        onDelete={readOnly ? undefined : deleteRecord}
                    />
                </div>
            </CardContent>
        </Card>
    );
}
