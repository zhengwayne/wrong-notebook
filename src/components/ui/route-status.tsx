"use client";

import { useEffect } from "react";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { frontendLogger } from "@/lib/frontend-logger";

/** 路由级切换轻量骨架屏 */
export function RouteLoadingSkeleton() {
    const { t } = useLanguage();
    return (
        <div className="mx-auto max-w-6xl space-y-4 px-4 py-8 md:px-8" role="status" aria-live="polite">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>{t.common.loading}</span>
            </div>
            <div className="space-y-3 rounded-2xl border bg-card p-6">
                <div className="h-6 w-1/3 animate-pulse rounded bg-muted" />
                <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
                <div className="h-32 w-full animate-pulse rounded-xl bg-muted/70" />
            </div>
        </div>
    );
}

/** 路由级错误恢复边界 */
export function RouteErrorFallback({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    const { t } = useLanguage();

    useEffect(() => {
        frontendLogger.error("[RouteError]", "Unhandled route segment error", {
            message: error.message,
            digest: error.digest,
        });
    }, [error]);

    return (
        <div
            role="alert"
            className="surface-paper mx-auto my-8 flex max-w-lg flex-col items-center justify-center rounded-2xl border border-warning/35 bg-card px-6 py-12 text-center"
        >
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-warning/15 text-warning">
                <AlertTriangle className="h-7 w-7" aria-hidden="true" />
            </div>
            <h2 className="text-base font-semibold text-foreground">{t.common.errorBoundaryTitle}</h2>
            <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
                {t.common.errorBoundaryDesc}
            </p>
            <div className="mt-5">
                <Button type="button" variant="outline" onClick={reset}>
                    <RotateCcw className="h-4 w-4" aria-hidden="true" />
                    {t.common.reloadView}
                </Button>
            </div>
        </div>
    );
}
