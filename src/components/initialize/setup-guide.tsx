"use client";

import { KeyRound } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

/** 尚未创建管理员时的说明：到哪里找一次性初始化链接 */
export function SetupGuide() {
    const { t } = useLanguage();
    const texts = t.auth.setupGuide;

    return (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
            <p className="flex items-center gap-2 font-medium">
                <KeyRound className="h-4 w-4 shrink-0" />
                {texts.title}
            </p>
            <p>{texts.intro}</p>
            <ul className="list-disc space-y-1 pl-5">
                <li>{texts.desktop}</li>
                <li>{texts.docker}</li>
                <li>{texts.npm}</li>
                <li>{texts.tokenFile}</li>
            </ul>
        </div>
    );
}
