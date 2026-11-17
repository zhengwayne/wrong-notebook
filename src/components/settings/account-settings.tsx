"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { getApiErrorMessage, getErrorMessage } from "@/lib/error-message";
import { toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import type { UpdateUserProfileRequest, UserProfile } from "@/types/api";
import { ChildLearnersManager } from "@/components/child-learners-manager";
import { PersonaPicker } from "@/components/persona-picker";
import type { Persona } from "@/lib/personas";

interface ProfileFormState {
    name: string;
    email: string;
    educationStage: string;
    enrollmentYear: string | number;
    password: string;
}

const EMPTY_PROFILE: ProfileFormState = { name: "", email: "", educationStage: "", enrollmentYear: "", password: "" };

/** 账户设置：姓名、邮箱、学段、入学年份和修改密码 */
export function AccountSettings() {
    const { t } = useLanguage();
    const { update } = useSession();
    const [profile, setProfile] = useState<ProfileFormState>(EMPTY_PROFILE);
    const [personas, setPersonas] = useState<Persona[]>([]);
    const [savingPersonas, setSavingPersonas] = useState(false);
    const [personasLoaded, setPersonasLoaded] = useState(false);
    const [confirmPassword, setConfirmPassword] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const fetchProfile = useCallback(async () => {
        try {
            const data = await apiClient.get<UserProfile>("/api/user");
            setProfile({
                name: data.name || "",
                email: data.email || "",
                educationStage: data.educationStage || "",
                enrollmentYear: data.enrollmentYear || "",
                password: ""
            });
            try {
                const personaState = await apiClient.get<{ personas: Persona[]; confirmed: boolean }>("/api/persona");
                if (personaState.confirmed) setPersonas(personaState.personas);
                setPersonasLoaded(true);
            } catch (error) {
                frontendLogger.error('[AccountSettings]', 'Failed to fetch personas', { error });
            }
        } catch (error) {
            frontendLogger.error('[AccountSettings]', 'Failed to fetch profile', { error });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 数据请求：进入页面或条件变化时加载，请求前后更新加载状态和结果
        fetchProfile();
    }, [fetchProfile]);

    const handleSave = async () => {
        // 验证密码一致性（如果用户输入了密码）
        if (profile.password && profile.password !== confirmPassword) {
            toast.error(t.settings?.messages?.passwordMismatch || 'Passwords do not match');
            return;
        }

        setSaving(true);
        try {
            const payload: UpdateUserProfileRequest = {
                name: profile.name,
                email: profile.email,
                educationStage: profile.educationStage,
            };
            if (profile.enrollmentYear) {
                payload.enrollmentYear = parseInt(profile.enrollmentYear.toString());
            }
            if (profile.password) {
                payload.password = profile.password;
            }

            await apiClient.patch("/api/user", payload);

            toast.success(t.settings?.messages?.profileUpdated || "Profile updated");
            setProfile(prev => ({ ...prev, password: "" }));
            setConfirmPassword("");
            window.location.reload(); // Reload to update user name in UI
        } catch (error) {
            frontendLogger.error('[AccountSettings]', 'Failed to update profile', { error: getApiErrorMessage(error) ?? getErrorMessage(error) });
            toast.error(getApiErrorMessage(error) || (t.settings?.messages?.updateFailed || "Update failed"));
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    return (
        <>
        <div className="space-y-4 border rounded-lg p-4 bg-muted/30">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                    <Label>{t.auth?.name || "Name"}</Label>
                    <Input
                        value={profile.name || ""}
                        onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                    />
                </div>
                <div className="space-y-2">
                    <Label>{t.auth?.email || "Email"}</Label>
                    <Input
                        value={profile.email || ""}
                        onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                        type="email"
                    />
                </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                    <Label>{t.auth?.educationStage || "Education Stage"}</Label>
                    <Select
                        value={profile.educationStage || ""}
                        onValueChange={(val) => setProfile({ ...profile, educationStage: val })}
                    >
                        <SelectTrigger>
                            <SelectValue placeholder={t.auth?.selectStage || "Select Stage"} />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="primary">{t.auth?.primary || 'Primary School'}</SelectItem>
                            <SelectItem value="junior_high">{t.auth?.juniorHigh || 'Junior High'}</SelectItem>
                            <SelectItem value="senior_high">{t.auth?.seniorHigh || 'Senior High'}</SelectItem>
                            <SelectItem value="university">{t.auth?.university || 'University'}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div className="space-y-2">
                    <Label>{t.auth?.enrollmentYear || "Enrollment Year"}</Label>
                    <Input
                        type="number"
                        value={profile.enrollmentYear || ""}
                        onChange={(e) => setProfile({ ...profile, enrollmentYear: e.target.value })}
                        placeholder="YYYY"
                    />
                </div>
            </div>

            <div className="space-y-3 pt-2 border-t">
                <div className="space-y-2">
                    <Label>{t.settings?.account?.changePassword || "Change Password (Leave empty to keep)"}</Label>
                    <PasswordInput
                        value={profile.password}
                        onChange={(e) => setProfile({ ...profile, password: e.target.value })}
                        placeholder="******"
                        minLength={6}
                    />
                </div>
                {profile.password && (
                    <div className="space-y-2">
                        <Label>{t.auth?.confirmPassword || "Confirm Password"}</Label>
                        <PasswordInput
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            placeholder="******"
                            minLength={6}
                        />
                    </div>
                )}
            </div>

            <Button onClick={handleSave} disabled={saving} className="w-full">
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t.settings?.account?.update || "Update Profile"}
            </Button>
        </div>
        {personasLoaded && (
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
        )}
        </>
    );
}
