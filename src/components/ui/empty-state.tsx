import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
    icon: LucideIcon;
    title: React.ReactNode;
    description?: React.ReactNode;
    action?: React.ReactNode;
    className?: string;
}

/** 列表为空时的占位：纸感虚线容器 + 图标 + 说明 + 引导操作 */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
    return (
        <div
            className={cn(
                "flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/65 px-6 py-14 text-center",
                className
            )}
        >
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground shadow-2xs">
                <Icon className="h-7 w-7" aria-hidden="true" />
            </div>
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            {description && (
                <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
            )}
            {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>}
        </div>
    );
}
