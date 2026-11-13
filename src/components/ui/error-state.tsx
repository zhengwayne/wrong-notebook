"use client";

import * as React from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";

export interface ErrorStateProps {
    /** 错误主标题，默认读取多语言「加载失败」 */
    title?: React.ReactNode;
    /** 错误补充说明 */
    description?: React.ReactNode;
    /** 点击重试回调；传入时显示重试按钮 */
    onRetry?: () => void;
    /** 自定义重试按钮文案 */
    retryLabel?: string;
    /** 是否正在重试中 */
    retrying?: boolean;
    /** 紧凑横幅模式，适用于已有旧数据时在列表上方提示刷新失败 */
    compact?: boolean;
    className?: string;
}

/** 统一的接口异常与网络错误恢复组件 */
export function ErrorState({
    title,
    description,
    onRetry,
    retryLabel,
    retrying = false,
    compact = false,
    className,
}: ErrorStateProps) {
    const { t } = useLanguage();
    const resolvedTitle = title ?? t.common.messages.loadFailed;
    const resolvedDesc = description ?? t.common.loadErrorDesc;
    const resolvedRetry = retryLabel ?? t.common.retry;

    if (compact) {
        return (
            <div
                role="alert"
                className={cn(
                    "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm",
                    className
                )}
            >
                <div className="flex min-w-0 items-center gap-2.5 text-destructive">
                    <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="font-medium">{resolvedTitle}</span>
                    {description && (
                        <span className="truncate text-muted-foreground">{description}</span>
                    )}
                </div>
                {onRetry && (
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        loading={retrying}
                        onClick={onRetry}
                        className="shrink-0"
                    >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        {resolvedRetry}
                    </Button>
                )}
            </div>
        );
    }

    return (
        <div
            role="alert"
            className={cn(
                "surface-paper flex flex-col items-center justify-center rounded-2xl border border-destructive/25 bg-card px-6 py-12 text-center",
                className
            )}
        >
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                <AlertCircle className="h-7 w-7" aria-hidden="true" />
            </div>
            <h2 className="text-base font-semibold text-foreground">{resolvedTitle}</h2>
            {resolvedDesc && (
                <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
                    {resolvedDesc}
                </p>
            )}
            {onRetry && (
                <div className="mt-5">
                    <Button type="button" variant="outline" loading={retrying} onClick={onRetry}>
                        <RefreshCw className="h-4 w-4" aria-hidden="true" />
                        {resolvedRetry}
                    </Button>
                </div>
            )}
        </div>
    );
}

