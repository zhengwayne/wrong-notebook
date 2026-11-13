import * as React from "react";
import { cn } from "@/lib/utils";

export interface PageContainerProps extends React.ComponentProps<"main"> {
    /** 页面最大宽度预设，默认 6xl */
    maxWidth?: "4xl" | "5xl" | "6xl";
}

const WIDTH_CLASSES: Record<"4xl" | "5xl" | "6xl", string> = {
    "4xl": "max-w-4xl",
    "5xl": "max-w-5xl",
    "6xl": "max-w-6xl",
};

/**
 * 统一主内容地标容器：提供响应式边距、最大宽度约束，并默认绑定 #main-content 供 SkipLink 直达聚焦
 */
export function PageContainer({
    maxWidth = "6xl",
    id = "main-content",
    className,
    children,
    ...props
}: PageContainerProps) {
    return (
        <main
            id={id}
            tabIndex={-1}
            className={cn(
                "mx-auto min-h-[calc(100vh-4rem)] w-full px-4 py-6 outline-none md:px-8 md:py-8",
                WIDTH_CLASSES[maxWidth],
                className
            )}
            {...props}
        >
            {children}
        </main>
    );
}

