"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { ChildLearnersManager } from "@/components/child-learners-manager";
import { PersonaPicker } from "@/components/persona-picker";
import { Button } from "@/components/ui/button";
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

    useEffect(() => {
        apiClient.get<{ personas: Persona[]; confirmed: boolean }>("/api/persona")
            .then((personaState) => {
                if (personaState.confirmed) setPersonas(personaState.personas);
                setPersonasLoaded(true);
            })
            .catch((error) => {
                frontendLogger.error("[AccountSettings]", "Failed to fetch personas", { error });
            });
    }, []);

    if (!personasLoaded) return null;

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
