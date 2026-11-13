"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { dismissToast, subscribeFeedback } from "@/lib/feedback";
import type { ConfirmRequest, ToastItem, ToastType } from "@/lib/feedback";
import { cn } from "@/lib/utils";

const TOAST_STYLE: Record<ToastType, { icon: typeof Info; className: string; borderClass: string }> = {
    success: { icon: CheckCircle2, className: "text-success", borderClass: "border-success/30" },
    error: { icon: XCircle, className: "text-destructive", borderClass: "border-destructive/35" },
    warning: { icon: AlertTriangle, className: "text-warning", borderClass: "border-warning/40" },
    info: { icon: Info, className: "text-primary", borderClass: "border-primary/25" },
};

/** 渲染全局轻提示与确认框，挂载在根布局中，区分紧急错误与普通提示的屏幕阅读器播报等级 */
export function FeedbackHost() {
    const { t } = useLanguage();
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    useEffect(() => subscribeFeedback((state) => {
        setToasts(state.toasts);
        setConfirm(state.confirm);
    }), []);

    return (
        <>
            <div
                aria-label="Notifications"
                className="pointer-events-none fixed inset-x-0 top-3 z-[100] flex flex-col items-center gap-2 px-4 print:hidden"
            >
                {toasts.map((item) => {
                    const { icon: Icon, className, borderClass } = TOAST_STYLE[item.type];
                    const isUrgent = item.type === "error" || item.type === "warning";
                    return (
                        <div
                            key={item.id}
                            role={isUrgent ? "alert" : "status"}
                            aria-live={isUrgent ? "assertive" : "polite"}
                            className={cn(
                                "surface-paper pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border bg-card/95 px-4 py-3 text-sm backdrop-blur animate-in fade-in slide-in-from-top-2 duration-200",
                                borderClass
                            )}
                        >
                            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", className)} aria-hidden="true" />
                            <p className="min-w-0 flex-1 whitespace-pre-line break-words leading-relaxed">
                                {item.message}
                            </p>
                            <button
                                type="button"
                                className="-mr-1 -mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={() => dismissToast(item.id)}
                                aria-label={t.common.close}
                            >
                                <X className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                        </div>
                    );
                })}
            </div>

            <Dialog open={!!confirm} onOpenChange={(open) => { if (!open) confirm?.resolve(false); }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            {confirm?.destructive && (
                                <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
                            )}
                            {confirm?.title || t.common.confirmTitle}
                        </DialogTitle>
                        <DialogDescription className="whitespace-pre-line pt-1 text-left leading-relaxed">
                            {confirm?.message}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2">
                        <Button variant="outline" onClick={() => confirm?.resolve(false)}>
                            {confirm?.cancelText || t.common.cancel}
                        </Button>
                        <Button
                            variant={confirm?.destructive ? "destructive" : "default"}
                            onClick={() => confirm?.resolve(true)}
                            autoFocus
                        >
                            {confirm?.confirmText || t.common.confirm}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
