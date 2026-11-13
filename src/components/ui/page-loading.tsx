import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PageLoadingProps {
    label?: string;
    className?: string;
}

/** 整页加载占位，具备无障碍状态播报 */
export function PageLoading({ label = "Loading...", className }: PageLoadingProps) {
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
            <p className="text-sm font-medium">{label}</p>
        </div>
    );
}
