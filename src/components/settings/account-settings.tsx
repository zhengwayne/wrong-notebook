"use client";

import { useCallback, useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { AccountPersonaSection } from "@/components/settings/account-persona-section";
import { SettingsPanelFallback } from "@/components/settings/settings-panel-fallback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLanguage } from "@/contexts/LanguageContext";
import { useOptionalUserProfile } from "@/contexts/UserProfileContext";
import { apiClient } from "@/lib/api-client";
import { getApiErrorMessage, getErrorMessage } from "@/lib/error-message";
import { toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import type { UpdateUserProfileRequest, UserProfile } from "@/types/api";

interface ProfileFormState {
    name: string;
    email: string;
    educationStage: string;
    enrollmentYear: string | number;
    password: string;
}

const EMPTY_PROFILE: ProfileFormState = { name: "", email: "", educationStage: "", enrollmentYear: "", password: "" };

/** 账户设置：姓名、邮箱、学段、入学年份和修改密码（优先复用设置弹窗共享用户资料） */
export function AccountSettings() {
    const { t } = useLanguage();
    const shared = useOptionalUserProfile();
    const [standaloneProfile, setStandaloneProfile] = useState<ProfileFormState>(EMPTY_PROFILE);
    const [draft, setDraft] = useState<Partial<ProfileFormState>>({});
    const [confirmPassword, setConfirmPassword] = useState("");
    const [standaloneLoading, setStandaloneLoading] = useState(!shared);
    const [saving, setSaving] = useState(false);

    const fetchProfile = useCallback(async () => {
        try {
            const data = await apiClient.get<UserProfile>("/api/user");
            setStandaloneProfile({
                name: data.name || "",
                email: data.email || "",
                educationStage: data.educationStage || "",
                enrollmentYear: data.enrollmentYear || "",
                password: "",
            });
        } catch (error) {
            frontendLogger.error("[AccountSettings]", "Failed to fetch profile", { error });
        } finally {
            setStandaloneLoading(false);
        }
    }, []);

    useEffect(() => {
        if (shared) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 数据请求：无共享上下文时独立读取个人资料
        fetchProfile();
    }, [shared, fetchProfile]);

    const baseProfile: ProfileFormState = shared
        ? (shared.profile ? {
            name: shared.profile.name || "",
            email: shared.profile.email || "",
            educationStage: shared.profile.educationStage || "",
            enrollmentYear: shared.profile.enrollmentYear || "",
            password: "",
        } : EMPTY_PROFILE)
        : standaloneProfile;
    const profile: ProfileFormState = { ...baseProfile, ...draft };
    const loading = shared ? shared.loading : standaloneLoading;

    const updateField = (patch: Partial<ProfileFormState>) => {
        if (shared) {
            setDraft((prev) => ({ ...prev, ...patch }));
        } else {
            setStandaloneProfile((prev) => ({ ...prev, ...patch }));
        }
    };

    const handleSave = async () => {
        if (profile.password && profile.password !== confirmPassword) {
            toast.error(t.settings?.messages?.passwordMismatch || "Passwords do not match");
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
                payload.enrollmentYear = parseInt(profile.enrollmentYear.toString(), 10);
            }
            if (profile.password) {
                payload.password = profile.password;
            }

            let updated: UserProfile;
            if (shared) {
                updated = await shared.patchProfile(payload);
                setDraft({});
            } else {
                updated = await apiClient.patch<UserProfile>("/api/user", payload);
                setStandaloneProfile((prev) => ({ ...prev, password: "" }));
            }

            // 改密递增 authVersion 后重签当前会话，避免重载被拦截到登录页
            if (payload.password) {
                const nextEmail = updated?.email || payload.email;
                if (nextEmail) {
                    const res = await signIn("credentials", { email: nextEmail, password: payload.password, redirect: false });
                    if (res?.error) {
                        throw new Error(res.error);
                    }
                }
            }

            toast.success(t.settings?.messages?.profileUpdated || "Profile updated");
            setConfirmPassword("");
            window.location.reload();
        } catch (error) {
            frontendLogger.error("[AccountSettings]", "Failed to update profile", { error: getApiErrorMessage(error) ?? getErrorMessage(error) });
            toast.error(getApiErrorMessage(error) || (t.settings?.messages?.updateFailed || "Update failed"));
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return <SettingsPanelFallback />;
    }

    return (
        <>
            <div className="space-y-4 border rounded-lg p-4 bg-muted/30">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label>{t.auth?.name || "Name"}</Label>
                        <Input value={profile.name || ""} onChange={(e) => updateField({ name: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                        <Label>{t.auth?.email || "Email"}</Label>
                        <Input value={profile.email || ""} onChange={(e) => updateField({ email: e.target.value })} type="email" />
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label>{t.auth?.educationStage || "Education Stage"}</Label>
                        <Select value={profile.educationStage || ""} onValueChange={(val) => updateField({ educationStage: val })}>
                            <SelectTrigger>
                                <SelectValue placeholder={t.auth?.selectStage || "Select Stage"} />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="primary">{t.auth?.primary || "Primary School"}</SelectItem>
                                <SelectItem value="junior_high">{t.auth?.juniorHigh || "Junior High"}</SelectItem>
                                <SelectItem value="senior_high">{t.auth?.seniorHigh || "Senior High"}</SelectItem>
                                <SelectItem value="university">{t.auth?.university || "University"}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-2">
                        <Label>{t.auth?.enrollmentYear || "Enrollment Year"}</Label>
                        <Input type="number" value={profile.enrollmentYear || ""} onChange={(e) => updateField({ enrollmentYear: e.target.value })} placeholder="YYYY" />
                    </div>
                </div>

                <div className="space-y-3 pt-2 border-t">
                    <div className="space-y-2">
                        <Label>{t.settings?.account?.changePassword || "Change Password (Leave empty to keep)"}</Label>
                        <PasswordInput value={profile.password} onChange={(e) => updateField({ password: e.target.value })} placeholder="******" minLength={6} />
                    </div>
                    {profile.password && (
                        <div className="space-y-2">
                            <Label>{t.auth?.confirmPassword || "Confirm Password"}</Label>
                            <PasswordInput value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="******" minLength={6} />
                        </div>
                    )}
                </div>

                <Button onClick={handleSave} disabled={saving} className="w-full">
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t.settings?.account?.update || "Update Profile"}
                </Button>
            </div>
            <AccountPersonaSection />
        </>
    );
}
