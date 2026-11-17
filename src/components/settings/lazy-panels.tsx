"use client";

import dynamic from "next/dynamic";
import { BarChart3, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";

export const LazyAccountSettings = dynamic(() => import("@/components/settings/account-settings").then((m) => m.AccountSettings), { ssr: false });
export const LazyAiProviderSettings = dynamic(() => import("@/components/settings/ai-provider-settings").then((m) => m.AiProviderSettings), { ssr: false });
export const LazyTtsSettings = dynamic(() => import("@/components/settings/tts-settings").then((m) => m.TtsSettings), { ssr: false });
export const LazyPromptSettings = dynamic(() => import("@/components/settings/prompt-settings").then((m) => m.PromptSettings), { ssr: false });
export const LazyDebugLogSettings = dynamic(() => import("@/components/settings/debug-log-settings").then((m) => m.DebugLogSettings), { ssr: false });
export const LazyUserManagement = dynamic(() => import("@/components/admin/user-management").then((m) => m.UserManagement), { ssr: false });
export const LazyDataBackupSettings = dynamic(() => import("@/components/settings/data-backup-settings").then((m) => m.DataBackupSettings), { ssr: false });
export const LazyDangerZoneSettings = dynamic(() => import("@/components/settings/danger-zone-settings").then((m) => m.DangerZoneSettings), { ssr: false });
export const LazyDeleteAccountSettings = dynamic(() => import("@/components/settings/delete-account-settings").then((m) => m.DeleteAccountSettings), { ssr: false });
export const LazyAboutSettings = dynamic(() => import("@/components/settings/about-settings").then((m) => m.AboutSettings), { ssr: false });

/** 设置页危险区域标签面板：集中展示备份、清空/重置与账户注销 */
export function DangerSettingsTabContent({ isAdmin }: { isAdmin: boolean }) {
    return (
        <div className="space-y-3">
            <LazyDataBackupSettings isAdmin={isAdmin} />
            <LazyDangerZoneSettings isAdmin={isAdmin} />
            <LazyDeleteAccountSettings />
        </div>
    );
}

/** 设置页管理员标签面板：仅在管理员点开对应标签后加载 */
export function AdminSettingsTabContent({
    onNavigate,
}: {
    onNavigate: (href: string) => void;
}) {
    const { t } = useLanguage();
    return (
        <>
            <Button variant="outline" className="w-full justify-start gap-2" onClick={() => onNavigate("/admin")}>
                <BarChart3 className="h-4 w-4" />
                {t.admin?.dashboard?.title || "Admin Dashboard"}
            </Button>
            <Button variant="outline" className="w-full justify-start gap-2" onClick={() => onNavigate("/setup")}>
                <Wand2 className="h-4 w-4" />
                {t.setup.rerun}
            </Button>
            <LazyDebugLogSettings />
            <div className="border-t pt-4">
                <LazyUserManagement />
            </div>
        </>
    );
}
