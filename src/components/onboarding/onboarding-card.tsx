"use client";

import Link from "next/link";
import { ArrowRight, Check, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "@/lib/feedback";
import { fillCopy, onboardingStepHref, setOnboardingVisibility, useOnboarding } from "@/lib/onboarding-client";
import type { Persona } from "@/lib/personas";
import { cn } from "@/lib/utils";
import { personaCopy } from "./copy";
import { stepIcon } from "./step-icons";

/**
 * 首页的分步引导卡：步骤按真实数据打勾，当前一步高亮并给出按钮；全部完成后变成“已经上手了”，3 天后自动收起。
 */
export function OnboardingCard({ persona, className }: { persona: Persona; className?: string }) {
    const { t } = useLanguage();
    const { status } = useOnboarding(persona);
    if (!status || !status.visible) return null;
    const c = personaCopy(t, persona);
    const o = t.onboarding;
    const percent = Math.round((status.doneCount / Math.max(1, status.total)) * 100);

    const dismiss = async () => {
        try {
            await setOnboardingVisibility(persona, "dismiss");
            toast.info(o.dismissed);
        } catch (error) {
            toast.error(error);
        }
    };

    return (
        <section
            aria-labelledby={`onboarding-${persona}-title`}
            data-testid={`onboarding-card-${persona}`}
            className={cn("rounded-2xl border border-border bg-card p-5 shadow-2xs", className)}
        >
            <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-primary">
                    {status.completed ? <Check className="h-5 w-5" aria-hidden="true" /> : <ListChecks className="h-5 w-5" aria-hidden="true" />}
                </div>
                <div className="min-w-0 flex-1">
                    <h2 id={`onboarding-${persona}-title`} className="text-base font-semibold">
                        {status.completed ? o.doneTitle : c.title}
                    </h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">{status.completed ? o.doneHint : o.progressHint}</p>
                </div>
                <span className="shrink-0 pt-1 text-xs tabular-nums text-muted-foreground" aria-label={`${status.doneCount}/${status.total}`}>
                    {status.doneCount}/{status.total}
                </span>
                <button type="button" onClick={dismiss} className="shrink-0 pt-1 text-xs font-medium text-primary hover:underline">
                    {o.collapse}
                </button>
            </div>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={status.total} aria-valuenow={status.doneCount}>
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${percent}%` }} />
            </div>
            <ol className="mt-2 divide-y divide-border/70">
                {status.steps.map((step, index) => {
                    const sc = c.steps[step.key];
                    const current = status.current === step.key;
                    const Icon = stepIcon(persona, step.key);
                    const note = step.done ? fillCopy(sc.doneNote, step.meta ?? {}) : "";
                    return (
                        <li key={step.key} data-step={step.key} data-done={step.done ? "1" : "0"} className="flex items-center gap-3 py-3">
                            <span
                                className={cn(
                                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                                    step.done && "bg-primary text-primary-foreground",
                                    !step.done && current && "border-2 border-primary bg-accent text-primary",
                                    !step.done && !current && "bg-muted text-muted-foreground",
                                )}
                                aria-hidden="true"
                            >
                                {step.done ? <Check className="h-4 w-4" /> : index + 1}
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className={cn("text-sm", current ? "font-semibold text-foreground" : step.done ? "text-muted-foreground" : "text-foreground/80")}>
                                    {fillCopy(o.stepLabel, { n: index + 1 })} · {sc.title}
                                    {step.done && <span className="sr-only">（{o.done}）</span>}
                                </div>
                                <p className="mt-0.5 truncate text-xs text-muted-foreground">{step.done && note ? note : sc.desc}</p>
                            </div>
                            {current && (
                                <Button asChild size="sm" className="shrink-0">
                                    <Link href={onboardingStepHref(status, step.key)}>
                                        <Icon className="h-4 w-4" aria-hidden="true" />{sc.action}
                                    </Link>
                                </Button>
                            )}
                        </li>
                    );
                })}
            </ol>
            {status.completed && (
                <div className="mt-1 flex items-center gap-3 rounded-xl bg-accent/60 px-3 py-3">
                    <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold">{c.finish.title}</div>
                        <p className="mt-0.5 text-xs text-muted-foreground">{c.finish.desc}</p>
                    </div>
                    <Button asChild size="sm" variant="outline" className="shrink-0">
                        <Link href={onboardingStepHref(status, "finish")}>{c.finish.action}<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
                    </Button>
                </div>
            )}
        </section>
    );
}
