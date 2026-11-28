"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useLanguage } from "@/contexts/LanguageContext";
import { useOptionalUserProfile } from "@/contexts/UserProfileContext";
import { apiClient } from "@/lib/api-client";
import { frontendLogger } from "@/lib/frontend-logger";
import type { UserProfile } from "@/types/api";

type BooleanPreference = "confirmBeforeImport" | "enableGeogebra" | "enableSvgAnimation" | "variantPipelineEnabled";

interface UserPreferenceSwitchProps {
    field: BooleanPreference;
    label: string;
    description: string;
}

/** 用户偏好开关，优先复用设置弹窗共享用户资料上下文，切换后立即保存到 /api/user */
export function UserPreferenceSwitch({ field, label, description }: UserPreferenceSwitchProps) {
    const { t } = useLanguage();
    const shared = useOptionalUserProfile();
    const [standaloneChecked, setStandaloneChecked] = useState(false);
    const [standaloneLoaded, setStandaloneLoaded] = useState(false);
    const [optimisticValue, setOptimisticValue] = useState<boolean | null>(null);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const id = `preference-${field}`;

    useEffect(() => {
        if (shared) return;
        apiClient.get<UserProfile>("/api/user")
            .then((user) => setStandaloneChecked(!!user[field]))
            .catch(() => undefined)
            .finally(() => setStandaloneLoaded(true));
    }, [field, shared]);

    const checked = optimisticValue ?? (shared ? !!shared.profile?.[field] : standaloneChecked);
    const loaded = shared ? (!shared.loading && shared.profile !== null) : standaloneLoaded;

    const handleChange = async (value: boolean) => {
        setOptimisticValue(value);
        if (!shared) setStandaloneChecked(value);
        setSaving(true);
        try {
            const updated = shared
                ? await shared.patchProfile({ [field]: value })
                : await apiClient.patch<UserProfile>("/api/user", { [field]: value });
            if (!shared && typeof updated?.[field] === "boolean") {
                setStandaloneChecked(updated[field]);
            }
            setMessage(t.importFlow.preferenceSaved);
        } catch (error) {
            if (!shared) setStandaloneChecked(!value);
            setMessage(t.importFlow.preferenceSaveFailed);
            frontendLogger.error('[Settings]', 'Failed to save user preference', {
                field,
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            setOptimisticValue(null);
            setSaving(false);
        }
    };

    return (
        <div className="space-y-2 pt-4 border-t">
            <div className="flex items-center justify-between gap-4">
                <Label htmlFor={id}>{label}</Label>
                <Switch id={id} checked={checked} onCheckedChange={handleChange} disabled={!loaded || saving} />
            </div>
            <p className="text-xs text-muted-foreground">{description}</p>
            {message && <p className="text-xs text-muted-foreground">{message}</p>}
        </div>
    );
}
