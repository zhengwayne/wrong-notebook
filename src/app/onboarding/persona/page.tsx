"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { PersonaPicker } from "@/components/persona-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { getApiErrorMessage } from "@/lib/error-message";
import { frontendLogger } from "@/lib/frontend-logger";
import { MAX_CHILD_LEARNERS } from "@/lib/learners";
import { usePageTitle } from "@/lib/page-title";
import { landingPath, type Persona } from "@/lib/personas";

interface PersonaState {
    personas: Persona[];
    activePersona: Persona | null;
    confirmed: boolean;
    suggestedPreselect: Persona;
}

export default function PersonaOnboardingPage() {
    const { t } = useLanguage();
    const router = useRouter();
    const { update } = useSession();
    usePageTitle(t.pageTitle.personaOnboarding);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [selected, setSelected] = useState<Persona[]>(["self"]);
    const [childNames, setChildNames] = useState<string[]>([""]);

    const load = useCallback(async () => {
        try {
            const data = await apiClient.get<PersonaState>("/api/persona");
            if (data.confirmed) {
                router.replace(landingPath(data.activePersona));
                return;
            }
            setSelected([data.suggestedPreselect]);
        } catch (err) {
            frontendLogger.error("[PersonaOnboarding]", "Failed to load persona state", { error: err });
        } finally {
            setLoading(false);
        }
    }, [router]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 进入确认页时加载预选项
        void load();
    }, [load]);

    const submit = async () => {
        if (selected.length === 0) {
            setError(t.persona.required);
            return;
        }
        setSaving(true);
        setError("");
        try {
            const children = selected.includes("parent")
                ? childNames.map((name) => ({ name: name.trim() })).filter((child) => child.name)
                : [];
            const result = await apiClient.post<{ activePersona: Persona }>("/api/persona", {
                personas: selected,
                confirm: true,
                children,
            });
            await update();
            router.replace(landingPath(result.activePersona));
        } catch (err) {
            setError(getApiErrorMessage(err) || t.persona.saveFailed);
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <AuthShell wide>
                <div className="flex justify-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>
            </AuthShell>
        );
    }

    return (
        <AuthShell wide>
            <Card className="w-full rounded-2xl border-0 shadow-xl shadow-primary/10 ring-1 ring-border">
                <CardHeader>
                    <CardTitle className="text-2xl text-center">{t.persona.onboardingTitle}</CardTitle>
                    <p className="text-center text-sm text-muted-foreground">{t.persona.onboardingDesc}</p>
                </CardHeader>
                <CardContent className="space-y-5">
                    <PersonaPicker value={selected} onChange={setSelected} />
                    {selected.includes("parent") && (
                        <div className="space-y-2">
                            <p className="text-sm font-medium">{t.persona.children.onboardingTitle}</p>
                            <p className="text-sm text-muted-foreground">{t.persona.children.onboardingDesc}</p>
                            {childNames.map((name, index) => (
                                <Input
                                    key={index}
                                    value={name}
                                    maxLength={40}
                                    placeholder={t.persona.children.namePlaceholder}
                                    onChange={(event) => {
                                        const next = [...childNames];
                                        next[index] = event.target.value;
                                        setChildNames(next);
                                    }}
                                />
                            ))}
                            {childNames.length < MAX_CHILD_LEARNERS && (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setChildNames((current) => [...current, ""])}
                                >
                                    {t.persona.children.add}
                                </Button>
                            )}
                        </div>
                    )}
                    {error && <div className="rounded-lg bg-destructive/10 px-3 py-2 text-center text-sm text-destructive">{error}</div>}
                    <Button type="button" size="lg" className="w-full" disabled={saving || selected.length === 0} onClick={() => void submit()}>
                        {saving ? t.common.pleaseWait : t.persona.confirm}
                    </Button>
                </CardContent>
            </Card>
        </AuthShell>
    );
}
