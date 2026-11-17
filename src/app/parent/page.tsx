"use client";

import Link from "next/link";
import { BookOpen, CalendarCheck, Route } from "lucide-react";
import { ChildLearnersManager } from "@/components/child-learners-manager";
import { PageContainer } from "@/components/ui/page-container";
import { useLanguage } from "@/contexts/LanguageContext";
import { usePageTitle } from "@/lib/page-title";

export default function ParentHomePage() {
    const { t } = useLanguage();
    usePageTitle(t.pageTitle.parentHome);
    const links = [
        { href: "/review", icon: CalendarCheck, title: t.nav.todayTasks, desc: t.persona.parentHome.todayDesc },
        { href: "/notebooks", icon: BookOpen, title: t.nav.practice, desc: t.persona.parentHome.practiceDesc },
        { href: "/learn", icon: Route, title: t.nav.path, desc: t.persona.parentHome.pathDesc },
    ];

    return (
        <PageContainer>
            <div className="mx-auto max-w-3xl space-y-8 py-6">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight">{t.persona.parentHome.title}</h1>
                    <p className="mt-2 text-sm text-muted-foreground">{t.persona.parentHome.desc}</p>
                </div>
                <ChildLearnersManager />
                <div className="grid gap-3 sm:grid-cols-3">
                    {links.map((link) => {
                        const Icon = link.icon;
                        return (
                            <Link
                                key={link.href}
                                href={link.href}
                                className="rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/50"
                            >
                                <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
                                <div className="mt-3 text-sm font-semibold">{link.title}</div>
                                <p className="mt-1 text-sm text-muted-foreground">{link.desc}</p>
                            </Link>
                        );
                    })}
                </div>
            </div>
        </PageContainer>
    );
}
