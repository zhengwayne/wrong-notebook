"use client";

import * as React from "react";
import { ErrorState } from "@/components/ui/error-state";
import { CardSkeletonGrid } from "@/components/ui/skeleton";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";

export interface AsyncBoundaryProps {
    /** 是否处于异步请求中 */
    loading: boolean;
    /** 错误消息（非空时展示错误恢复视图或紧凑横幅） */
    error?: string | null;
    /** 数据是否为空 */
    empty?: boolean;
    /** 是否已持有旧数据；为 true 时再次加载将保持列表可见并半透明过渡，避免布局抖动 */
    hasData?: boolean;
    /** 点击重试回调 */
    onRetry?: () => void;
    /** 自定义首屏骨架屏节点，默认使用 CardSkeletonGrid */
    loadingFallback?: React.ReactNode;
    /** 数据为空时的占位节点 */
    emptyFallback?: React.ReactNode;
    /** 无障碍加载播报文案 */
    loadingLabel?: string;
    /** 错误主标题 */
    errorTitle?: React.ReactNode;
    className?: string;
    children: React.ReactNode;
}

/**
 * 声明式异步状态容器：统一编排首屏骨架屏、接口错误恢复、空数据占位与局部刷新过渡，
 * 消除「请求异常卡死在骨架屏」或「请求失败误判为空状态」问题。
 */
export function AsyncBoundary({
    loading,
    error,
    empty = false,
    hasData = false,
    onRetry,
    loadingFallback,
    emptyFallback = null,
    loadingLabel,
    errorTitle,
    className,
    children,
}: AsyncBoundaryProps) {
    const { t } = useLanguage();
    const resolvedLoadingLabel = loadingLabel ?? t.common.loading;

    // 1. 首屏加载且尚无缓存数据
    if (loading && !hasData) {
        return (
            <div className={className}>
                {loadingFallback ?? <CardSkeletonGrid label={resolvedLoadingLabel} />}
            </div>
        );
    }

    // 2. 首屏加载失败且无旧数据可兜底
    if (error && !hasData) {
        return (
            <div className={className}>
                <ErrorState
                    title={errorTitle}
                    description={error}
                    onRetry={onRetry}
                    retrying={loading}
                />
            </div>
        );
    }

    // 3. 请求成功但结果为空
    if (!loading && !error && empty) {
        return <div className={className}>{emptyFallback}</div>;
    }

    // 4. 正常渲染或带旧数据的局部刷新/刷新失败态
    return (
        <div
            aria-busy={loading || undefined}
            className={cn("space-y-4", className)}
        >
            {error && hasData && (
                <ErrorState
                    compact
                    title={errorTitle}
                    description={error}
                    onRetry={onRetry}
                    retrying={loading}
                />
            )}
            <div className={cn("transition-opacity duration-200", loading && "pointer-events-none opacity-60")}>
                {children}
            </div>
        </div>
    );
}

