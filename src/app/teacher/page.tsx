"use client";

import Link from "next/link";
import { BarChart3, ClipboardCheck, Users } from "lucide-react";
import { PageContainer } from "@/components/ui/page-container";
import { useLanguage } from "@/contexts/LanguageContext";
import { usePageTitle } from "@/lib/page-title";

export default function TeacherHomePage() {
    const { t } = useLanguage();
    usePageTitle(t.pageTitle.teacherHome);
    const cards = [
        { href: "/grading", icon: ClipboardCheck, title: t.nav.gradingCollect, desc: t.persona.teacherHome.gradingDesc },
        { href: "/teacher", icon: Users, title: t.nav.classes, desc: t.persona.teacherHome.classesDesc },
        { href: "/stats", icon: BarChart3, title: t.nav.stats, desc: t.persona.teacherHome.statsDesc },
    ];

    return (
        <PageContainer>
            <div className="mx-auto max-w-3xl space-y-6 py-6">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight">{t.persona.teacherHome.title}</h1>
                    <p className="mt-2 text-sm text-muted-foreground">{t.persona.teacherHome.desc}</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                    {cards.map((card) => {
                        const Icon = card.icon;
                        return (
                            <Link
                                key={card.title}
                                href={card.href}
                                className="rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/50"
                            >
                                <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
                                <div className="mt-3 text-sm font-semibold">{card.title}</div>
                                <p className="mt-1 text-sm text-muted-foreground">{card.desc}</p>
                            </Link>
                        );
                    })}
                </div>
            </div>
        </PageContainer>
    );
}
