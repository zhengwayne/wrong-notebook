"use client";

import * as React from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { frontendLogger } from "@/lib/frontend-logger";
import { cn } from "@/lib/utils";

export interface ErrorBoundaryProps {
    children: React.ReactNode;
    /** 自定义异常标题 */
    fallbackTitle?: string;
    /** 自定义异常描述 */
    fallbackDescription?: string;
    /** 点击重置后触发的额外清理回调 */
    onReset?: () => void;
    className?: string;
}

interface ErrorBoundaryInternalProps extends ErrorBoundaryProps {
    defaultTitle: string;
    defaultDescription: string;
    reloadLabel: string;
}

interface ErrorBoundaryState {
    hasError: boolean;
}

class ErrorBoundaryCore extends React.Component<ErrorBoundaryInternalProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryInternalProps) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError(): ErrorBoundaryState {
        return { hasError: true };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        // 仅向安全日志记录详细诊断信息，不向终端用户暴露原始堆栈
        frontendLogger.error("[ErrorBoundary]", "Caught rendering error", {
            message: error.message,
            componentStack: info.componentStack,
        });
    }

    private handleReset = () => {
        this.setState({ hasError: false });
        this.props.onReset?.();
    };

    render() {
        if (!this.state.hasError) {
            return this.props.children;
        }

        const {
            fallbackTitle,
            fallbackDescription,
            defaultTitle,
            defaultDescription,
            reloadLabel,
            className,
        } = this.props;

        return (
            <div
                role="alert"
                className={cn(
                    "surface-paper mx-auto my-8 flex max-w-lg flex-col items-center justify-center rounded-2xl border border-warning/35 bg-card px-6 py-12 text-center",
                    className
                )}
            >
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-warning/15 text-warning">
                    <AlertTriangle className="h-7 w-7" aria-hidden="true" />
                </div>
                <h2 className="text-base font-semibold text-foreground">
                    {fallbackTitle || defaultTitle}
                </h2>
                <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
                    {fallbackDescription || defaultDescription}
                </p>
                <div className="mt-5">
                    <Button type="button" variant="outline" onClick={this.handleReset}>
                        <RotateCcw className="h-4 w-4" aria-hidden="true" />
                        {reloadLabel}
                    </Button>
                </div>
            </div>
        );
    }
}

/** 组件级渲染异常隔离边界，防止局部脏数据导致整页白屏 */
export function ErrorBoundary(props: ErrorBoundaryProps) {
    const { t } = useLanguage();
    return (
        <ErrorBoundaryCore
            {...props}
            defaultTitle={t.common.errorBoundaryTitle}
            defaultDescription={t.common.errorBoundaryDesc}
            reloadLabel={t.common.reloadView}
        />
    );
}

