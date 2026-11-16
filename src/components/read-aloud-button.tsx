"use client";

import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { Loader2, Square, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { speakText, stopSpeaking } from "@/lib/speak-text";
import { cn } from "@/lib/utils";

interface ReadAloudButtonProps {
    text?: string | null;
    className?: string;
    /** 更紧凑的样式，用于复习卡片等窄位 */
    compact?: boolean;
}

/**
 * 朗读一段题干或解析：优先 Edge / 云端语音，失败时回退到浏览器语音。
 */
export function ReadAloudButton({ text, className, compact = false }: ReadAloudButtonProps) {
    const { t } = useLanguage();
    const [speaking, setSpeaking] = useState(false);
    const [loading, setLoading] = useState(false);

    useEffect(() => () => { stopSpeaking(); }, []);

    if (!text?.trim()) return null;

    const label = speaking ? (t.common.stopReading || "Stop") : (t.common.readAloud || "Read aloud");

    const toggle = async (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        if (speaking || loading) {
            stopSpeaking();
            setSpeaking(false);
            setLoading(false);
            return;
        }
        setLoading(true);
        try {
            const handle = await speakText(text);
            setSpeaking(true);
            void handle.done.finally(() => {
                setSpeaking(false);
                setLoading(false);
            });
        } catch {
            setSpeaking(false);
        } finally {
            setLoading(false);
        }
    };

    return (
        <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(event) => void toggle(event)}
            aria-pressed={speaking}
            aria-label={label}
            className={cn("relative z-10 shrink-0", className)}
        >
            {loading && !speaking ? (
                <Loader2 className="h-4 w-4 animate-spin" />
            ) : speaking ? (
                <Square className="h-4 w-4" />
            ) : (
                <Volume2 className="h-4 w-4" />
            )}
            {!compact && <span className="ml-1">{label}</span>}
        </Button>
    );
}
