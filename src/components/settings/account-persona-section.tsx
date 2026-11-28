"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { ChildLearnersManager } from "@/components/child-learners-manager";
import { PersonaPicker } from "@/components/persona-picker";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { getApiErrorMessage } from "@/lib/error-message";
import { toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import type { Persona } from "@/lib/personas";

/** 账户身份配置与家长孩子档案入口，独立于个人资料表单以控制组件体积 */
export function AccountPersonaSection() {
    const { t } = useLanguage();
    const { update } = useSession();
    const [personas, setPersonas] = useState<Persona[]>([]);
    const [savingPersonas, setSavingPersonas] = useState(false);
    const [personasLoaded, setPersonasLoaded] = useState(false);
    const [loadError, setLoadError] = useState(false);

    const fetchPersonas = () => {
        setLoadError(false);
        setPersonasLoaded(false);
        apiClient.get<{ personas: Persona[]; confirmed: boolean }>("/api/persona")
            .then((personaState) => {
                if (personaState.confirmed) setPersonas(personaState.personas);
                setPersonasLoaded(true);
            })
            .catch((error) => {
                frontendLogger.error("[AccountSettings]", "Failed to fetch personas", { error });
                setLoadError(true);
                setPersonasLoaded(true);
            });
    };

    useEffect(() => {
        let cancelled = false;
        apiClient.get<{ personas: Persona[]; confirmed: boolean }>("/api/persona")
            .then((personaState) => {
                if (cancelled) return;
                if (personaState.confirmed) setPersonas(personaState.personas);
                setPersonasLoaded(true);
            })
            .catch((error) => {
                if (cancelled) return;
                frontendLogger.error("[AccountSettings]", "Failed to fetch personas", { error });
                setLoadError(true);
                setPersonasLoaded(true);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    if (!personasLoaded) {
        return (
            <div data-testid="account-persona-fallback" className="space-y-3 border rounded-lg p-4 bg-muted/30 min-h-[10rem]" role="status" aria-live="polite">
                <Skeleton className="h-4 w-1/4" />
                <Skeleton className="h-4 w-2/3" />
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <Skeleton className="h-16 w-full rounded-lg" />
                    <Skeleton className="h-16 w-full rounded-lg" />
                    <Skeleton className="h-16 w-full rounded-lg" />
                </div>
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="space-y-3 border rounded-lg p-4 bg-muted/30 text-sm">
                <p className="text-destructive">{t.common.messages?.loadFailed || "加载失败"}</p>
                <Button type="button" size="sm" variant="outline" onClick={fetchPersonas}>
                    {t.common.retry}
                </Button>
            </div>
        );
    }

    return (
        <div className="space-y-4 border rounded-lg p-4 bg-muted/30">
            <div>
                <h3 className="text-sm font-semibold">{t.persona.settingsTitle}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t.persona.settingsDesc}</p>
            </div>
            <PersonaPicker value={personas} onChange={setPersonas} />
            <Button
                type="button"
                onClick={async () => {
                    if (personas.length === 0) {
                        toast.error(t.persona.required);
                        return;
                    }
                    setSavingPersonas(true);
                    try {
                        await apiClient.post("/api/persona", { personas, confirm: true });
                        await update();
                        toast.success(t.persona.saved);
                    } catch (error) {
                        toast.error(getApiErrorMessage(error) || t.persona.saveFailed);
                    } finally {
                        setSavingPersonas(false);
                    }
                }}
                disabled={savingPersonas || personas.length === 0}
                className="w-full"
            >
                {savingPersonas && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t.persona.save}
            </Button>
            {personas.includes("parent") && <ChildLearnersManager className="pt-2 border-t" />}
        </div>
    );
}
