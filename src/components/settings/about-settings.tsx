"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, ShieldAlert } from "lucide-react";
import { AndroidAppSetting } from "@/components/settings/android-app-setting";
import { DataFlowDisclosure } from "@/components/settings/data-flow-disclosure";
import { useLanguage } from "@/contexts/LanguageContext";
import type { DataFlowSummary, SecurityPosture } from "@/types/api";

interface AboutSettingsProps {
    isAdmin?: boolean;
    securityPosture?: SecurityPosture;
    dataFlow?: DataFlowSummary;
}

/** 关于：版本号、安卓 App、AI 数据流向告知、管理员安全态势提醒与版权信息 */
export function AboutSettings({ isAdmin = false, securityPosture, dataFlow }: AboutSettingsProps) {
    const { t } = useLanguage();
    const [version, setVersion] = useState("");

    useEffect(() => {
        fetch("/api/version")
            .then((res) => res.json())
            .then((data) => setVersion(data.version))
            .catch(() => {});
    }, []);

    const postureCopy = t.settings?.about?.securityPosture;
    const postureChecks = isAdmin && securityPosture
        ? [
            {
                key: "secret",
                warn: securityPosture.defaultNextAuthSecret,
                label: securityPosture.defaultNextAuthSecret
                    ? (postureCopy?.defaultSecretWarn || "NEXTAUTH_SECRET uses default or weak value; set a random secret >= 32 chars in production.")
                    : (postureCopy?.secretOk || "NEXTAUTH_SECRET is configured."),
            },
            {
                key: "https",
                warn: !securityPosture.httpsConfigured,
                label: securityPosture.httpsConfigured
                    ? (postureCopy?.httpsOk || "HTTPS or HTTPS NEXTAUTH_URL is configured.")
                    : (postureCopy?.httpsWarn || "HTTPS is not detected; enable TLS or a reverse proxy with HTTPS before public access."),
            },
            {
                key: "proxy",
                warn: securityPosture.trustProxyMode === "unset",
                label: securityPosture.trustProxyMode === "unset"
                    ? (postureCopy?.proxyUnset || "TRUST_PROXY is unset (proxy IP headers are ignored by default; set to true or cloudflare if behind a reverse proxy).")
                    : `${postureCopy?.proxyModeLabel || "TRUST_PROXY"}: ${securityPosture.trustProxyMode}${securityPosture.trustProxyMode === "true" ? ` (hops=${securityPosture.trustedProxyHops})` : ""}`,
            },
            {
                key: "registration",
                warn: securityPosture.registrationOpen,
                label: securityPosture.registrationOpen
                    ? (postureCopy?.registrationOpen || "Public user registration is enabled.")
                    : (postureCopy?.registrationClosed || "Public user registration is closed."),
            },
            {
                key: "openclaw",
                warn: securityPosture.openclawAuthMode === "apikey" && !securityPosture.openclawKeyConfigured,
                label: securityPosture.openclawAuthMode === "apikey" && !securityPosture.openclawKeyConfigured
                    ? (postureCopy?.openclawKeyMissing || "OPENCLAW_AUTH_MODE=apikey without OPENCLAW_INTEGRATION_API_KEY; batch upload is blocked.")
                    : `${postureCopy?.openclawModeLabel || "Openclaw auth"}: ${securityPosture.openclawAuthMode}`,
            },
        ]
        : [];

    return (
        <div className="flex flex-col items-center justify-center space-y-6 py-8 text-center bg-muted/30 rounded-lg border">
            <div className="space-y-2">
                <h3 className="text-2xl font-bold">{t.app?.title || "XueJi"}</h3>
                <p className="text-muted-foreground">
                    {t.settings?.about?.desc || "AI-powered learning assistant"}
                </p>
            </div>

            <div className="flex items-center space-x-2 text-sm text-muted-foreground border px-4 py-2 rounded-full bg-background">
                <Info className="h-4 w-4" />
                <span>{t.settings?.about?.version || "Version"}: v{version || "unknown"}</span>
            </div>

            <AndroidAppSetting />

            <DataFlowDisclosure dataFlow={dataFlow} />

            {postureChecks.length > 0 && (
                <div className="w-full max-w-xl mx-auto px-4 text-left">
                    <div className="rounded-lg border bg-background p-4 space-y-2">
                        <div className="flex items-center gap-2 text-sm font-medium">
                            <ShieldAlert className="h-4 w-4 text-amber-500 shrink-0" />
                            <span>{postureCopy?.title || "Admin Security Posture"}</span>
                        </div>
                        <ul className="space-y-1.5 text-xs text-muted-foreground">
                            {postureChecks.map((item) => (
                                <li key={item.key} className="flex items-start gap-2">
                                    {item.warn ? (
                                        <AlertTriangle className="h-3.5 w-3.5 text-amber-500 mt-0.5 shrink-0" />
                                    ) : (
                                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 mt-0.5 shrink-0" />
                                    )}
                                    <span>{item.label}</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            )}

            <p className="text-xs text-muted-foreground mt-4">
                {t.settings?.about?.copyright || "© 2026 zhengwayne/wrong-notebook (based on wttwins & margrop) · MIT License"}
            </p>
        </div>
    );
}
