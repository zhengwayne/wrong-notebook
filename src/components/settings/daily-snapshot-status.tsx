"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Camera, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTimeZone } from "@/contexts/TimeZoneContext";
import { apiClient } from "@/lib/api-client";
import { formatDateTime } from "@/lib/date-time";
import { toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";

export interface SnapshotStatusResponse {
    enabled: boolean;
    retentionCount: number;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastDateKey: string | null;
    lastSnapshotName: string | null;
    snapshotCount: number;
    lastError: string | null;
}

interface DailySnapshotStatusProps {
    isAdmin: boolean;
}

/** 展示数据库每日自动快照状态，管理员可手动触发一次快照 */
export function DailySnapshotStatus({ isAdmin }: DailySnapshotStatusProps) {
    const { t } = useLanguage();
    const { timeZone } = useTimeZone();
    const [status, setStatus] = useState<SnapshotStatusResponse | null>(null);
    const [running, setRunning] = useState(false);

    useEffect(() => {
        let cancelled = false;
        Promise.resolve(apiClient.get<SnapshotStatusResponse>("/api/system/snapshot-status"))
            .then((data) => {
                if (!cancelled && data) setStatus(data);
            })
            .catch((error) => {
                frontendLogger.warn("[DailySnapshotStatus]", "Failed to fetch snapshot status", { error });
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const handleRunNow = async () => {
        setRunning(true);
        try {
            const next = await apiClient.post<SnapshotStatusResponse>("/api/system/snapshot-status", {});
            setStatus(next);
            toast.success(t.settings.dailySnapshotSuccessToast);
        } catch (error) {
            frontendLogger.error("[DailySnapshotStatus]", "Manual snapshot failed", { error });
            toast.error(t.settings.dailySnapshotFailedToast);
        } finally {
            setRunning(false);
        }
    };

    if (!status) {
        return null;
    }

    return (
        <div className="mt-4 pt-4 border-t border-blue-200 dark:border-blue-900 space-y-2">
            <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-blue-800 dark:text-blue-200">
                    {t.settings.dailySnapshotTitle}
                </span>
                {isAdmin && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={handleRunNow}
                        disabled={running}
                        className="bg-blue-100 dark:bg-blue-900/40 hover:bg-blue-200 dark:hover:bg-blue-900/60 text-blue-900 dark:text-blue-200 border-blue-300 dark:border-blue-800"
                    >
                        {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Camera className="mr-2 h-4 w-4" />}
                        {t.settings.dailySnapshotRunNow}
                    </Button>
                )}
            </div>
            <p className="text-xs text-blue-700 dark:text-blue-300">
                {t.settings.dailySnapshotDesc.replace("{count}", String(status.retentionCount))}
            </p>
            <p className="text-xs text-blue-800 dark:text-blue-200">
                {!status.enabled
                    ? t.settings.dailySnapshotDisabled
                    : status.lastSuccessAt
                        ? `${t.settings.dailySnapshotLastSuccess}: ${formatDateTime(status.lastSuccessAt, "yyyy-MM-dd HH:mm", timeZone)} (${status.snapshotCount}/${status.retentionCount})`
                        : t.settings.dailySnapshotPending}
            </p>
            {status.lastError && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{status.lastError}</span>
                </div>
            )}
        </div>
    );
}
