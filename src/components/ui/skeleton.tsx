import * as React from "react";
import { cn } from "@/lib/utils";

export interface SkeletonProps extends React.ComponentProps<"div"> {
    /** 是否启用脉冲动画，默认开启（受全局 prefers-reduced-motion 控制） */
    animated?: boolean;
}

/** 基础骨架屏占位条 */
export function Skeleton({ className, animated = true, ...props }: SkeletonProps) {
    return (
        <div
            data-slot="skeleton"
            aria-hidden="true"
            className={cn(
                "rounded-md bg-muted/85",
                animated && "animate-pulse",
                className
            )}
            {...props}
        />
    );
}

export interface CardSkeletonGridProps {
    /** 占位卡片数量，默认 6 */
    count?: number;
    /** 桌面端最大列数，默认 3 */
    columns?: 1 | 2 | 3;
    /** 屏幕阅读器播报的加载提示文案 */
    label?: string;
    className?: string;
}

const COLUMN_CLASSES: Record<1 | 2 | 3, string> = {
    1: "grid-cols-1",
    2: "grid-cols-1 sm:grid-cols-2",
    3: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3",
};

/** 模拟真实卡片结构的响应式骨架网格，具备无障碍状态播报 */
export function CardSkeletonGrid({
    count = 6,
    columns = 3,
    label = "Loading...",
    className,
}: CardSkeletonGridProps) {
    return (
        <div
            role="status"
            aria-live="polite"
            aria-busy="true"
            className={cn("grid gap-4", COLUMN_CLASSES[columns], className)}
        >
            <span className="sr-only">{label}</span>
            {Array.from({ length: count }, (_, idx) => (
                <div
                    key={idx}
                    aria-hidden="true"
                    className="surface-paper flex flex-col justify-between gap-4 rounded-2xl border bg-card p-5"
                >
                    <div className="flex items-center justify-between gap-3">
                        <Skeleton className="h-5 w-20 rounded-full" />
                        <Skeleton className="h-4 w-16" />
                    </div>
                    <div className="space-y-2.5">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-5/6" />
                        <Skeleton className="h-4 w-2/3" />
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                        <Skeleton className="h-5 w-14 rounded-md" />
                        <Skeleton className="h-5 w-18 rounded-md" />
                        <Skeleton className="h-5 w-12 rounded-md" />
                    </div>
                </div>
            ))}
        </div>
    );
}

