"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { frontendLogger } from "@/lib/frontend-logger";
import { toast } from "@/lib/feedback";
import { landingPath, type Persona } from "@/lib/personas";
import { cn } from "@/lib/utils";

export function PersonaSwitcher() {
    const { t } = useLanguage();
    const router = useRouter();
    const { data: session, update } = useSession();
    const [pending, setPending] = useState(false);
    const personas = session?.user?.personas ?? [];
    const active = session?.user?.activePersona ?? null;
    if (personas.length === 0 || !active) return null;

    const labelOf = (persona: Persona) => t.persona.items[persona].title;
    const currentLabel = labelOf(active);

    const switchTo = async (persona: Persona) => {
        if (persona === active || pending) return;
        setPending(true);
        try {
            await apiClient.patch("/api/persona", { activePersona: persona });
            await update();
            router.push(landingPath(persona));
            router.refresh();
        } catch (error) {
            frontendLogger.error("[PersonaSwitcher]", "Failed to switch persona", { error });
            toast.error(t.persona.switchFailed);
        } finally {
            setPending(false);
        }
    };

    if (personas.length === 1) {
        return (
            <span className="hidden items-center rounded-full border border-border/70 bg-muted/50 px-3 py-1 text-xs font-medium text-foreground/85 sm:inline-flex">
                {currentLabel}
            </span>
        );
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    className="h-8 gap-1 rounded-full border border-border/70 bg-muted/50 px-3 text-xs font-medium"
                    aria-label={t.nav.switchPersona}
                    title={t.nav.switchPersona}
                >
                    {currentLabel}
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
                {personas.map((persona) => (
                    <DropdownMenuItem
                        key={persona}
                        onSelect={() => { void switchTo(persona); }}
                        className={cn("flex items-center gap-2", persona === active && "font-medium")}
                    >
                        <Check className={cn("h-4 w-4", persona === active ? "opacity-100" : "opacity-0")} aria-hidden="true" />
                        {labelOf(persona)}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
