"use client";

import Image from "next/image";
import { useLanguage } from "@/contexts/LanguageContext";

interface AuthShellProps {
    children: React.ReactNode;
    /** 内容较多的页面（如安装向导）用更宽的版心 */
    wide?: boolean;
}

/** 登录、注册、安装向导页的外层：品牌标识 + 纯色背景 */
export function AuthShell({ children, wide = false }: AuthShellProps) {
    const { t } = useLanguage();

    return (
        <div className="flex min-h-screen items-center justify-center bg-background p-4">
            <div className={`w-full space-y-6 py-8 ${wide ? "max-w-xl" : "max-w-md"}`}>
                <div className="flex flex-col items-center gap-3 text-center">
                    <Image src="/icons/icon.png" alt="" width={64} height={64} className="rounded-2xl shadow-lg shadow-primary/30" priority unoptimized />
                    <div className="space-y-1">
                        <p className="text-xl font-bold tracking-tight">{t.pageTitle.base}</p>
                        <p className="text-sm text-muted-foreground">{t.app.subtitle}</p>
                    </div>
                </div>
                {children}
            </div>
        </div>
    );
}
