"use client";

import { Loader2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";

export interface PageLoadingProps {
    label?: string;
    className?: string;
}

/** 整页加载占位，具备无障碍状态播报；未传入 label 时使用当前界面语言的「加载中」 */
export function PageLoading({ label, className }: PageLoadingProps) {
    const { t } = useLanguage();
    const resolved = label ?? t.common.loading;
    return (
        <div
            role="status"
            aria-live="polite"
            aria-busy="true"
            className={cn(
                "flex min-h-[50vh] flex-col items-center justify-center gap-3 text-muted-foreground",
                className
            )}
        >
            <Loader2 className="h-7 w-7 animate-spin text-primary" aria-hidden="true" />
            <p className="text-sm font-medium">{resolved}</p>
        </div>
    );
}
