"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requestOpenSettings } from "@/components/settings-dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";

interface SnapshotWarningState {
    enabled: boolean;
    lastError: string | null;
}

/** 自动快照最近一次执行失败时在首页顶部显示醒目警告提示，正常状态不占高度 */
export function SnapshotWarningBanner() {
    const { t } = useLanguage();
    const [warning, setWarning] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        Promise.resolve(apiClient.get<SnapshotWarningState>("/api/system/snapshot-status"))
            .then((data) => {
                if (!cancelled && data?.enabled && data.lastError) {
                    setWarning(data.lastError);
                }
            })
            .catch(() => {
                // 静默忽略未登录或网络波动，避免首页出现误报横幅
            });
        return () => {
            cancelled = true;
        };
    }, []);

    if (!warning) {
        return null;
    }

    return (
        <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
            <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <div>
                    <p className="font-medium">{t.settings.dailySnapshotFailedBanner}</p>
                    <p className="text-xs opacity-90">{warning}</p>
                </div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => requestOpenSettings()}>
                {t.settings.dailySnapshotOpenSettings}
            </Button>
        </div>
    );
}
