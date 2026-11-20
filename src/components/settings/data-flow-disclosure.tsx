"use client";

import { Eye, MessageSquare, ShieldCheck, Volume2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import type { DataFlowSummary } from "@/types/api";

interface DataFlowDisclosureProps {
    dataFlow?: DataFlowSummary;
}

/** 面向所有用户的 AI 与语音数据流向告知卡片 */
export function DataFlowDisclosure({ dataFlow }: DataFlowDisclosureProps) {
    const { t } = useLanguage();
    const copy = t.settings?.about?.dataFlow;
    if (!dataFlow) return null;

    const localityLabel = (type: DataFlowSummary["vision"]["endpointType"] | "browser") => {
        if (type === "local") return copy?.localityLocal || "Local model endpoint (stays on your host/LAN)";
        if (type === "custom_remote") return copy?.localityCustomRemote || "Custom remote API endpoint";
        if (type === "browser") return copy?.localityBrowser || "Browser local speech (never leaves device)";
        return copy?.localityOfficial || "Official cloud API endpoint";
    };

    return (
        <div className="w-full max-w-xl mx-auto px-4 text-left">
            <div className="rounded-lg border bg-background p-4 space-y-2.5">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <ShieldCheck className="h-4 w-4 text-primary shrink-0" />
                    <span>{copy?.title || "AI & Voice Data Flow Disclosure"}</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                    {copy?.desc || "Uploaded question images (EXIF stripped on server) and question text are sent to the configured provider below. Configure a local Ollama or vLLM endpoint to keep inference within your local host/LAN."}
                </p>
                <ul className="space-y-1.5 text-xs text-muted-foreground pt-1">
                    <li className="flex items-center gap-2">
                        <Eye className="h-3.5 w-3.5 shrink-0 text-foreground/70" />
                        <span>
                            <strong>{copy?.visionLabel || "Vision"}:</strong> {dataFlow.vision.provider} · {localityLabel(dataFlow.vision.endpointType)}
                        </span>
                    </li>
                    <li className="flex items-center gap-2">
                        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-foreground/70" />
                        <span>
                            <strong>{copy?.textLabel || "Text"}:</strong> {dataFlow.text.provider} · {localityLabel(dataFlow.text.endpointType)}
                        </span>
                    </li>
                    <li className="flex items-center gap-2">
                        <Volume2 className="h-3.5 w-3.5 shrink-0 text-foreground/70" />
                        <span>
                            <strong>{copy?.ttsLabel || "Voice narration"}:</strong> {dataFlow.tts.mode} · {localityLabel(dataFlow.tts.endpointType)}
                        </span>
                    </li>
                </ul>
            </div>
        </div>
    );
}
