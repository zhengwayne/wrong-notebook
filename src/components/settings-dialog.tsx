"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { AlertTriangle, Bot, Info, Languages, Loader2, MessageSquareText, Settings, Shield, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GeneralSettings } from "@/components/settings/general-settings";
import {
    AdminSettingsTabContent,
    LazyAboutSettings,
    LazyAccountSettings,
    LazyAiProviderSettings,
    LazyDangerZoneSettings,
    LazyDataBackupSettings,
    LazyPromptSettings,
    LazyTtsSettings,
} from "@/components/settings/lazy-panels";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTimeZone } from "@/contexts/TimeZoneContext";
import { UserProfileProvider } from "@/contexts/UserProfileContext";
import { apiClient } from "@/lib/api-client";
import { validateAiConfig } from "@/lib/ai-config-validation";
import { DEFAULT_TIME_ZONE } from "@/lib/date-time";
import { toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import { OPEN_SETTINGS_EVENT, requestOpenSettings } from "@/lib/settings-events";
import type { AppConfig } from "@/types/api";

export { OPEN_SETTINGS_EVENT, requestOpenSettings };

function SettingsTab({ value, icon, label }: { value: string; icon: ReactNode; label: string }) {
    return (
        <TabsTrigger value={value} aria-label={label} className="px-2 sm:px-3">
            {icon}
            <span className="hidden sm:inline">{label}</span>
        </TabsTrigger>
    );
}

export function SettingsDialog({ defaultOpen = false }: { defaultOpen?: boolean }) {
    const { setTimeZone } = useTimeZone();
    const { data: session } = useSession();
    const isAdmin = session?.user?.role === "admin";
    const { t } = useLanguage();
    const router = useRouter();
    const [open, setOpen] = useState(defaultOpen);
    const [activeTab, setActiveTab] = useState("general");
    const dialogContentRef = useRef<HTMLDivElement>(null);
    const [saving, setSaving] = useState(false);
    const [loading, setLoading] = useState(false);
    const [config, setConfig] = useState<AppConfig>({ aiProvider: "minimax" });

    const fetchSettings = useCallback(async () => {
        setLoading(true);
        try {
            setConfig(await apiClient.get<AppConfig>("/api/settings"));
        } catch (error) {
            frontendLogger.error("[SettingsDialog]", "Failed to fetch settings", { error });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (open) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- 数据请求：弹窗开启时加载配置并更新加载状态
            fetchSettings();
        }
    }, [open, fetchSettings]);

    useEffect(() => {
        const onOpen = () => setOpen(true);
        window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
        return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
    }, []);

    const handleSaveSettings = async () => {
        const validationError = validateAiConfig(config, t);
        if (validationError) {
            toast.error(validationError);
            return;
        }

        setSaving(true);
        try {
            const updated = await apiClient.post<AppConfig>("/api/settings", config);
            setConfig(updated);
            setTimeZone(updated.timeZone || DEFAULT_TIME_ZONE);
            toast.success(t.settings?.messages?.saved || "Settings saved");
            dialogContentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
        } catch (error) {
            frontendLogger.error("[SettingsDialog]", "Failed to save settings", { error });
            toast.error(t.settings?.messages?.saveFailed || "Failed to save");
        } finally {
            setSaving(false);
        }
    };

    const saveButton = (label: string) => (
        <Button onClick={handleSaveSettings} disabled={saving} className="w-full">
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {label}
        </Button>
    );

    return (
        <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setActiveTab("general"); }}>
            <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full" title={t.settings?.title || "Settings"} aria-label={t.settings?.title || "Settings"}>
                    <Settings className="h-5 w-5" />
                </Button>
            </DialogTrigger>
            <DialogContent ref={dialogContentRef} className="w-[calc(100vw-2rem)] sm:max-w-[900px] max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{t.settings?.title || "Settings"}</DialogTitle>
                    <DialogDescription>{t.settings?.desc || "Manage your preferences and data."}</DialogDescription>
                </DialogHeader>

                <UserProfileProvider enabled={open}>
                    <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                        <TabsList className={`grid w-full grid-cols-4 ${isAdmin ? "sm:grid-cols-7" : "sm:grid-cols-4"} gap-1 h-auto`}>
                            <SettingsTab value="general" icon={<Languages className="h-4 w-4 sm:mr-2" />} label={t.settings?.tabs?.general || "General"} />
                            <SettingsTab value="account" icon={<User className="h-4 w-4 sm:mr-2" />} label={t.settings?.tabs?.account || "Account"} />
                            {isAdmin && (
                                <>
                                    <SettingsTab value="ai" icon={<Bot className="h-4 w-4 sm:mr-2" />} label={t.settings?.tabs?.ai || "AI Provider"} />
                                    <SettingsTab value="prompts" icon={<MessageSquareText className="h-4 w-4 sm:mr-2" />} label={t.settings?.tabs?.prompts || "Prompts"} />
                                    <SettingsTab value="admin" icon={<Shield className="h-4 w-4 sm:mr-2" />} label={t.settings?.tabs?.admin || "User Management"} />
                                </>
                            )}
                            <SettingsTab value="danger" icon={<AlertTriangle className="h-4 w-4 sm:mr-2" />} label={t.settings?.tabs?.danger || "Danger"} />
                            <SettingsTab value="about" icon={<Info className="h-4 w-4 sm:mr-2" />} label={t.settings?.tabs?.about || "About"} />
                        </TabsList>

                        <TabsContent value="general" className="space-y-4 py-4">
                            {activeTab === "general" && (
                                <>
                                    <GeneralSettings config={config} setConfig={setConfig} isAdmin={isAdmin} disabled={loading || saving} />
                                    {isAdmin && saveButton(t.settings?.save || "Save Settings")}
                                </>
                            )}
                        </TabsContent>

                        <TabsContent value="account" className="space-y-4 py-4">
                            {activeTab === "account" && <LazyAccountSettings />}
                        </TabsContent>

                        <TabsContent value="ai" className="space-y-4 py-4">
                            {activeTab === "ai" && (
                                <>
                                    <LazyAiProviderSettings config={config} setConfig={setConfig} loading={loading} saving={saving} onSave={handleSaveSettings} />
                                    {!loading && <LazyTtsSettings config={config} setConfig={setConfig} saving={saving} onSave={handleSaveSettings} />}
                                </>
                            )}
                        </TabsContent>

                        <TabsContent value="prompts" className="space-y-4 py-4">
                            {activeTab === "prompts" && (
                                <>
                                    <LazyPromptSettings config={config} onUpdate={(type, value) => setConfig(prev => ({ ...prev, prompts: { ...prev.prompts, [type]: value } }))} />
                                    {saveButton(t.settings?.prompts?.save || "Save Prompt Settings")}
                                </>
                            )}
                        </TabsContent>

                        {isAdmin && (
                            <TabsContent value="admin" className="space-y-4 py-4">
                                {activeTab === "admin" && (
                                    <AdminSettingsTabContent onNavigate={(href) => { setOpen(false); router.push(href); }} />
                                )}
                            </TabsContent>
                        )}

                        <TabsContent value="danger" className="space-y-4 py-4">
                            {activeTab === "danger" && (
                                <div className="space-y-3">
                                    <LazyDataBackupSettings isAdmin={isAdmin} />
                                    <LazyDangerZoneSettings isAdmin={isAdmin} />
                                </div>
                            )}
                        </TabsContent>

                        <TabsContent value="about" className="space-y-4 py-4">
                            {activeTab === "about" && <LazyAboutSettings isAdmin={isAdmin} securityPosture={isAdmin ? config.securityPosture : undefined} />}
                        </TabsContent>
                    </Tabs>
                </UserProfileProvider>
            </DialogContent>
        </Dialog>
    );
}
