"use client";

import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "@/lib/feedback";
import { setOnboardingVisibility } from "@/lib/onboarding-client";
import { usePageTitle } from "@/lib/page-title";
import { isPersona, landingPath, type Persona } from "@/lib/personas";

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
    return (
        <section id={id} className="scroll-mt-24 rounded-2xl border border-border bg-card p-5">
            <h2 className="text-base font-semibold">{title}</h2>
            <div className="mt-3 text-sm leading-relaxed text-foreground/90">{children}</div>
        </section>
    );
}

function Steps({ items }: { items: string[] }) {
    return (
        <ol className="space-y-2">
            {items.map((item, index) => (
                <li key={item} className="flex gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-primary" aria-hidden="true">{index + 1}</span>
                    <span>{item}</span>
                </li>
            ))}
        </ol>
    );
}

export default function HelpPage() {
    const { t } = useLanguage();
    const h = t.helpPage;
    usePageTitle(h.title);
    const router = useRouter();
    const { data: session } = useSession();
    const active = session?.user?.activePersona;
    const persona: Persona = isPersona(active) ? active : "self";

    const reopen = async () => {
        try {
            await setOnboardingVisibility(persona, "reopen");
            toast.success(h.reopened);
            router.push(landingPath(persona));
        } catch {
            toast.error(t.onboarding.reopenFailed);
        }
    };

    const order: Persona[] = persona === "teacher" ? ["teacher", "parent", "self"] : persona === "parent" ? ["parent", "teacher", "self"] : ["self", "parent", "teacher"];

    return (
        <PageContainer>
            <div className="mx-auto max-w-3xl space-y-5 py-6">
                <PageHeader
                    title={h.title}
                    description={h.desc}
                    actions={<Button type="button" onClick={() => void reopen()}><ListChecks className="h-4 w-4" aria-hidden="true" />{h.reopen}</Button>}
                />
                {order.map((p) => p === "teacher" ? (
                    <div key={p} className="space-y-5">
                        <Section id="grading" title={h.grading.title}><Steps items={h.grading.steps} /></Section>
                        <Section id="roster" title={h.roster.title}>
                            <p className="text-muted-foreground">{h.roster.desc}</p>
                            <pre className="mt-3 overflow-x-auto rounded-xl bg-muted px-4 py-3 font-mono text-xs leading-6">{h.roster.example}</pre>
                        </Section>
                        <Section id="mobile" title={h.mobile.title}>
                            <ul className="list-disc space-y-1.5 pl-5">{h.mobile.items.map((item) => <li key={item}>{item}</li>)}</ul>
                        </Section>
                    </div>
                ) : (
                    <Section key={p} id={p} title={h[p].title}><Steps items={h[p].steps} /></Section>
                ))}
            </div>
        </PageContainer>
    );
}
