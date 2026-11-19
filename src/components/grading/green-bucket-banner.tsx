"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { toast } from "@/lib/feedback";
import type { GradingSubmissionBrief } from "@/types/grading";

export interface GreenBucketBannerProps {
    taskId: string;
    submissions: GradingSubmissionBrief[];
    onConfirmed: () => void;
}

/**
 * 置信度红绿灯分流横幅：将全卷高把握客观题且学号准确匹配的绿灯答卷一键全班确认归档，省去逐份点开的重复劳动。
 */
export function GreenBucketBanner({ taskId, submissions, onConfirmed }: GreenBucketBannerProps) {
    const { t } = useLanguage();
    const [submitting, setSubmitting] = useState(false);

    const graded = submissions.filter((s) => s.status === "graded");
    const greenPapers = graded.filter((s) => s.reviewBucket === "green" && Boolean(s.studentId));
    const yellowCount = graded.length - greenPapers.length;

    if (greenPapers.length === 0) return null;

    const qg = t.grading.quickGrading;

    const handleConfirmAllGreen = async () => {
        setSubmitting(true);
        try {
            const res = await apiClient.post<{ confirmedCount: number; importedCount: number }>(
                `/api/grading/tasks/${taskId}/confirm-batch`,
                {},
            );
            toast.success(
                qg.greenBatchDone
                    .replace("{confirmed}", String(res.confirmedCount))
                    .replace("{imported}", String(res.importedCount)),
            );
            onConfirmed();
        } catch (error) {
            toast.error(error);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="flex flex-col justify-between gap-3 rounded-2xl border border-emerald-500/40 bg-emerald-500/5 p-3.5 sm:flex-row sm:items-center">
            <div className="flex items-start gap-2.5 text-sm">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <div>
                    <div className="font-medium text-foreground">
                        {qg.greenBannerTitle
                            .replace("{green}", String(greenPapers.length))
                            .replace("{yellow}", String(yellowCount))}
                    </div>
                </div>
            </div>
            <Button
                type="button"
                size="sm"
                disabled={submitting}
                onClick={handleConfirmAllGreen}
                className="shrink-0"
            >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {qg.greenBatchBtn.replace("{count}", String(greenPapers.length))}
            </Button>
        </div>
    );
}
