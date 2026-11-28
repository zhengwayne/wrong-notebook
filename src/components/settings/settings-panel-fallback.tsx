"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** 设置弹窗标签面板的稳定骨架：避免懒加载或资料请求期间对话框整体高度坍缩闪烁 */
export function SettingsPanelFallback({ className }: { className?: string }) {
    return (
        <div
            data-testid="settings-panel-fallback"
            role="status"
            aria-live="polite"
            className={cn("space-y-4 py-2 min-h-[calc(85vh-12rem)]", className)}
        >
            <Skeleton className="h-4 w-1/3" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
            </div>
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-10 w-full" />
        </div>
    );
}
