"use client";

import { useEffect, useState } from "react";
import { Lightbulb } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useOnboarding } from "@/lib/onboarding-client";
import type { Persona } from "@/lib/personas";
import { cn } from "@/lib/utils";

const PREFIX = "xueji.hint.";

/**
 * 行内提示：引导开着时出现，点「知道了」后本机不再显示。引导被收起后也不显示。
 */
export function InlineHint({ id, persona, step, children, className }: {
    id: string;
    persona: Persona;
    /** 圆圈里的步骤号 */
    step?: number;
    children: React.ReactNode;
    className?: string;
}) {
    const { t } = useLanguage();
    const { status } = useOnboarding(persona);
    const [hidden, setHidden] = useState(true);

    useEffect(() => {
        try {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- 读取本机“知道了”状态
            setHidden(window.localStorage.getItem(PREFIX + id) === "1");
        } catch {
            setHidden(false);
        }
    }, [id]);

    if (hidden || !status || !status.visible) return null;

    const close = () => {
        setHidden(true);
        try { window.localStorage.setItem(PREFIX + id, "1"); } catch { /* ignore */ }
    };

    return (
        <div role="note" data-testid={`inline-hint-${id}`} className={cn("flex items-start gap-3 rounded-2xl border border-primary/20 bg-accent/60 px-4 py-3 text-sm print:hidden", className)}>
            {step ? (
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-primary text-[11px] font-semibold text-primary" aria-hidden="true">{step}</span>
            ) : (
                <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            )}
            <p className="min-w-0 flex-1 leading-relaxed text-foreground/90">{children}</p>
            <button type="button" onClick={close} className="shrink-0 text-xs font-medium text-primary hover:underline">{t.onboarding.gotIt}</button>
        </div>
    );
}
