"use client";

import { Check, GraduationCap, User, Users } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { PERSONAS, type Persona } from "@/lib/personas";
import { cn } from "@/lib/utils";

const ICONS = {
    teacher: GraduationCap,
    parent: Users,
    self: User,
} as const;

/** 切换多选身份：已选则去掉，未选则加入，允许同时保留多个。 */
export function togglePersona(current: Persona[], persona: Persona): Persona[] {
    return current.includes(persona)
        ? current.filter((item) => item !== persona)
        : [...current, persona];
}

export function PersonaPicker({
    value,
    onChange,
    disabled = false,
}: {
    value: Persona[];
    onChange: (next: Persona[]) => void;
    disabled?: boolean;
}) {
    const { t } = useLanguage();
    const labels = t.persona;

    const toggle = (persona: Persona) => {
        if (disabled) return;
        onChange(togglePersona(value, persona));
    };

    return (
        <div className="grid gap-3" role="group" aria-label={labels.title}>
            <p className="text-xs text-muted-foreground">{labels.multiSelectHint}</p>
            {PERSONAS.map((persona) => {
                const checked = value.includes(persona);
                const Icon = ICONS[persona];
                const item = labels.items[persona];
                const titleId = `persona-${persona}-title`;
                return (
                    <button
                        key={persona}
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        aria-labelledby={titleId}
                        disabled={disabled}
                        data-persona={persona}
                        onClick={() => toggle(persona)}
                        className={cn(
                            "flex w-full items-start gap-3 rounded-2xl border bg-card p-4 text-left transition-colors",
                            checked ? "border-primary bg-accent/60" : "border-border hover:border-primary/40",
                            disabled && "cursor-not-allowed opacity-70"
                        )}
                    >
                        <span
                            aria-hidden="true"
                            data-checkbox="true"
                            data-state={checked ? "checked" : "unchecked"}
                            className={cn(
                                "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px] border-2",
                                checked
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-primary bg-background"
                            )}
                        >
                            {checked ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : null}
                        </span>
                        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                                <span id={titleId} className="block text-sm font-semibold text-foreground">
                                    {item.title}
                                </span>
                                {checked && (
                                    <span className="rounded-md bg-primary px-1.5 py-0.5 text-[11px] font-medium text-primary-foreground">
                                        {labels.selected}
                                    </span>
                                )}
                            </span>
                            <span className="mt-1 block text-sm text-muted-foreground">{item.desc}</span>
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
