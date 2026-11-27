"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, CircleCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { fillCopy, ONBOARDING_NEXT_EVENT, onboardingStepHref, type OnboardingNextDetail } from "@/lib/onboarding-client";
import { personaCopy } from "./copy";

const AUTO_CLOSE_MS = 12000;

/** 完成一步后右下角的“下一步”提示，跨页面保留（挂在全局外壳里） */
export function NextStepHost() {
    const { t } = useLanguage();
    const [detail, setDetail] = useState<OnboardingNextDetail | null>(null);

    useEffect(() => {
        const onNext = (event: Event) => setDetail((event as CustomEvent<OnboardingNextDetail>).detail);
        window.addEventListener(ONBOARDING_NEXT_EVENT, onNext);
        return () => window.removeEventListener(ONBOARDING_NEXT_EVENT, onNext);
    }, []);

    useEffect(() => {
        if (!detail) return;
        const timer = window.setTimeout(() => setDetail(null), AUTO_CLOSE_MS);
        return () => window.clearTimeout(timer);
    }, [detail]);

    if (!detail) return null;
    const c = personaCopy(t, detail.persona);
    const toastCopy = c.toast[detail.step];
    if (!toastCopy) return null;
    const { status } = detail;
    const target = status.current ?? "finish";
    const vars = { ...(status.steps.find((s) => s.key === detail.step)?.meta ?? {}), ...detail.vars };

    return (
        <div
            role="status"
            data-testid="onboarding-next-step"
            className="fixed inset-x-3 bottom-[calc(5.5rem+env(safe-area-inset-bottom,0px))] z-50 mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-border bg-card p-3 shadow-lg md:inset-x-auto md:bottom-6 md:right-6"
        >
            <CircleCheck className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{fillCopy(toastCopy.title, vars)}</div>
                <p className="truncate text-xs text-muted-foreground">{fillCopy(t.onboarding.next, { step: toastCopy.next })}</p>
            </div>
            <Button asChild size="sm" className="shrink-0" onClick={() => setDetail(null)}>
                <Link href={onboardingStepHref(status, target)}>{toastCopy.action}<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
            </Button>
            <button type="button" onClick={() => setDetail(null)} className="shrink-0 rounded-full p-1 text-muted-foreground hover:text-foreground" aria-label={t.common?.close || "Close"}>
                <X className="h-4 w-4" aria-hidden="true" />
            </button>
        </div>
    );
}
