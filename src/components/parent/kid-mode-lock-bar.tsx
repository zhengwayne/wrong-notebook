"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Lock, ShieldCheck, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { getApiErrorMessage } from "@/lib/error-message";

export const KID_MODE_CHANGED_EVENT = "wn:kid-mode-changed";

export interface KidModeClientState {
    active: boolean;
    learnerId: string | null;
    learnerName: string | null;
    hasPin: boolean;
    lockedUntil: string | null;
}

export function notifyKidModeChanged() {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(KID_MODE_CHANGED_EVENT));
    }
}

export function useKidModeState(enabled: boolean): {
    state: KidModeClientState | null;
    reload: () => Promise<void>;
} {
    const [state, setState] = useState<KidModeClientState | null>(null);

    const reload = useCallback(async () => {
        if (!enabled) return;
        try {
            const res = await apiClient.get<KidModeClientState>("/api/parent/kid-mode");
            setState(res);
        } catch {
            // 未登录或临时网络异常时保持静默，不阻断主界面渲染
        }
    }, [enabled]);

    useEffect(() => {
        if (!enabled) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 初始化与事件订阅拉取专注锁状态
        void reload();
        const onChanged = () => { void reload(); };
        window.addEventListener(KID_MODE_CHANGED_EVENT, onChanged);
        return () => window.removeEventListener(KID_MODE_CHANGED_EVENT, onChanged);
    }, [enabled, reload]);

    return { state, reload };
}

export function ParentKidModeCard({ learnerId, learnerName }: { learnerId: string; learnerName: string }) {
    const { t } = useLanguage();
    const copy = t.kidMode;
    const router = useRouter();
    const { state, reload } = useKidModeState(true);
    const [editingPin, setEditingPin] = useState(false);
    const [currentPin, setCurrentPin] = useState("");
    const [newPin, setNewPin] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const hasPin = Boolean(state?.hasPin);

    const activateLock = async () => {
        setError(null);
        setSubmitting(true);
        try {
            await apiClient.post("/api/parent/kid-mode", { learnerId });
            notifyKidModeChanged();
            router.push(`/learn?studentKey=${encodeURIComponent(learnerId)}`);
        } catch (err) {
            setError(getApiErrorMessage(err));
        } finally {
            setSubmitting(false);
        }
    };

    const savePin = async (alsoEnable: boolean) => {
        if (!/^\d{4}$/.test(newPin)) {
            setError(copy.pinInvalid);
            return;
        }
        setError(null);
        setMessage(null);
        setSubmitting(true);
        try {
            await apiClient.post("/api/parent/pin", {
                pin: newPin,
                ...(hasPin ? { currentPin } : {}),
            });
            setCurrentPin("");
            setNewPin("");
            setEditingPin(false);
            await reload();
            if (alsoEnable) {
                await apiClient.post("/api/parent/kid-mode", { learnerId });
                notifyKidModeChanged();
                router.push(`/learn?studentKey=${encodeURIComponent(learnerId)}`);
                return;
            }
            setMessage(copy.pinSaved);
        } catch (err) {
            setError(getApiErrorMessage(err));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="rounded-2xl border border-primary/25 bg-primary/5 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
                        {copy.cardTitle}
                    </div>
                    <p className="text-xs text-muted-foreground">{copy.cardDesc}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {hasPin ? (
                        <>
                            <Button type="button" size="sm" disabled={submitting} onClick={() => void activateLock()}>
                                <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                                {copy.enableButton.replace("{name}", learnerName)}
                            </Button>
                            <Button type="button" size="sm" variant="outline" onClick={() => setEditingPin((v) => !v)}>
                                <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                                {editingPin ? copy.cancel : copy.changePin}
                            </Button>
                        </>
                    ) : (
                        <Button type="button" size="sm" onClick={() => setEditingPin(true)}>
                            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                            {copy.setupAndEnable}
                        </Button>
                    )}
                </div>
            </div>

            {editingPin && (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
                    {hasPin && (
                        <Input
                            type="password"
                            inputMode="numeric"
                            maxLength={4}
                            value={currentPin}
                            onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                            placeholder={copy.currentPinPlaceholder}
                            className="h-9 w-36 text-center tracking-widest"
                        />
                    )}
                    <Input
                        type="password"
                        inputMode="numeric"
                        maxLength={4}
                        value={newPin}
                        onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                        placeholder={copy.newPinPlaceholder}
                        className="h-9 w-40 text-center tracking-widest"
                    />
                    <Button type="button" size="sm" disabled={submitting} onClick={() => void savePin(!hasPin)}>
                        {hasPin ? copy.savePin : copy.setupAndEnable}
                    </Button>
                </div>
            )}
            {message && <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">{message}</p>}
            {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>
    );
}

export function GlobalKidModeBanner({ state }: { state: KidModeClientState }) {
    const { t } = useLanguage();
    const copy = t.kidMode;
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [pin, setPin] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleUnlock = async () => {
        if (!/^\d{4}$/.test(pin)) {
            setError(copy.pinInvalid);
            return;
        }
        setError(null);
        setBusy(true);
        try {
            await apiClient.post("/api/parent/kid-mode/unlock", { pin });
            setPin("");
            setOpen(false);
            notifyKidModeChanged();
            const target = state.learnerId ? `/parent?learnerId=${encodeURIComponent(state.learnerId)}` : "/parent";
            router.push(target);
        } catch (err) {
            setError(getApiErrorMessage(err) || copy.unlockFailed);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs print:hidden">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-medium text-foreground">
                    <Lock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                    <span>{copy.bannerTitle.replace("{name}", state.learnerName || "")}</span>
                    <span className="hidden text-muted-foreground sm:inline">· {copy.bannerHint}</span>
                </div>
                <div className="flex items-center gap-2">
                    {open ? (
                        <>
                            <Input
                                type="password"
                                inputMode="numeric"
                                maxLength={4}
                                value={pin}
                                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                                placeholder={copy.unlockPlaceholder}
                                className="h-7 w-28 bg-background text-center text-xs tracking-widest"
                            />
                            <Button type="button" size="sm" className="h-7 px-2.5 text-xs" disabled={busy} onClick={() => void handleUnlock()}>
                                <Unlock className="h-3 w-3" aria-hidden="true" />
                                {copy.confirmUnlock}
                            </Button>
                            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { setOpen(false); setError(null); }}>
                                {copy.cancel}
                            </Button>
                        </>
                    ) : (
                        <Button type="button" size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => setOpen(true)}>
                            <Unlock className="h-3 w-3" aria-hidden="true" />
                            {copy.unlockButton}
                        </Button>
                    )}
                </div>
            </div>
            {error && <p className="mx-auto mt-1 max-w-6xl text-xs text-destructive">{error}</p>}
        </div>
    );
}
