"use client";

import { GraduationCap, User, Users } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useLanguage } from "@/contexts/LanguageContext";
import { PERSONAS, type Persona } from "@/lib/personas";
import { cn } from "@/lib/utils";

const ICONS = {
    teacher: GraduationCap,
    parent: Users,
    self: User,
} as const;

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
        if (value.includes(persona)) onChange(value.filter((item) => item !== persona));
        else onChange([...value, persona]);
    };

    return (
        <div className="grid gap-3" role="group" aria-label={labels.title}>
            {PERSONAS.map((persona) => {
                const checked = value.includes(persona);
                const Icon = ICONS[persona];
                const item = labels.items[persona];
                return (
                    <label
                        key={persona}
                        className={cn(
                            "flex cursor-pointer items-start gap-3 rounded-2xl border bg-card p-4 transition-colors",
                            checked ? "border-primary bg-accent/60" : "border-border hover:border-primary/40",
                            disabled && "cursor-not-allowed opacity-70"
                        )}
                    >
                        <Checkbox
                            checked={checked}
                            disabled={disabled}
                            onCheckedChange={() => toggle(persona)}
                            className="mt-0.5"
                            aria-labelledby={`persona-${persona}-title`}
                        />
                        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                        <span className="min-w-0">
                            <span id={`persona-${persona}-title`} className="block text-sm font-semibold text-foreground">
                                {item.title}
                            </span>
                            <span className="mt-1 block text-sm text-muted-foreground">{item.desc}</span>
                        </span>
                    </label>
                );
            })}
        </div>
    );
}
