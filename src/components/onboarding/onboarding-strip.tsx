"use client";

import Link from "next/link";
import { Check } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "@/lib/feedback";
import { onboardingStepHref, setOnboardingVisibility, useOnboarding } from "@/lib/onboarding-client";
import type { Persona } from "@/lib/personas";
import { cn } from "@/lib/utils";
import { personaCopy } from "./copy";

/** 工作页面顶部的细步骤条：只在引导开着且未全部完成时出现 */
export function OnboardingStrip({ persona, className }: { persona: Persona; className?: string }) {
    const { t } = useLanguage();
    const { status } = useOnboarding(persona);
    if (!status || !status.visible || status.completed) return null;
    const c = personaCopy(t, persona);

    const dismiss = async () => {
        try {
            await setOnboardingVisibility(persona, "dismiss");
            toast.info(t.onboarding.dismissed);
        } catch (error) {
            toast.error(error);
        }
    };

    return (
        <nav
            aria-label={c.title}
            data-testid={`onboarding-strip-${persona}`}
            className={cn("flex items-center gap-2 overflow-x-auto rounded-2xl border border-border bg-card px-3 py-2 print:hidden", className)}
        >
            <ol className="flex min-w-0 flex-1 items-center gap-2">
                {status.steps.map((step, index) => {
                    const current = status.current === step.key;
                    const label = c.steps[step.key].title;
                    const body = (
                        <>
                            <span
                                className={cn(
                                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                                    step.done && "bg-primary text-primary-foreground",
                                    !step.done && current && "border-2 border-primary text-primary",
                                    !step.done && !current && "bg-muted text-muted-foreground",
                                )}
                                aria-hidden="true"
                            >
                                {step.done ? <Check className="h-3.5 w-3.5" /> : index + 1}
                            </span>
                            <span className={cn("whitespace-nowrap text-sm", current ? "font-semibold text-primary" : step.done ? "text-foreground/80" : "text-muted-foreground")}>{label}</span>
                        </>
                    );
                    return (
                        <li key={step.key} className="flex min-w-0 flex-1 items-center gap-2 last:flex-none" aria-current={current ? "step" : undefined}>
                            {current ? (
                                <Link href={onboardingStepHref(status, step.key)} className="flex items-center gap-2 rounded-full hover:underline">{body}</Link>
                            ) : (
                                <span className="flex items-center gap-2">{body}</span>
                            )}
                            {index < status.steps.length - 1 && <span className="hidden h-px min-w-4 flex-1 bg-border sm:block" aria-hidden="true" />}
                        </li>
                    );
                })}
            </ol>
            <button type="button" onClick={dismiss} className="shrink-0 text-xs font-medium text-primary hover:underline">{t.onboarding.collapse}</button>
        </nav>
    );
}
