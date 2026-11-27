"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpen, CircleHelp, ListChecks, Smartphone, Table2, ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "@/lib/feedback";
import { setOnboardingVisibility } from "@/lib/onboarding-client";
import { landingPath, type Persona } from "@/lib/personas";

/** 顶栏「帮助」：重新打开新手引导 + 使用说明 */
export function HelpMenu({ persona }: { persona: Persona | null }) {
    const { t } = useLanguage();
    const router = useRouter();
    const h = t.onboarding.help;
    const target: Persona = persona ?? "self";

    const reopen = async () => {
        try {
            await setOnboardingVisibility(target, "reopen");
            router.push(landingPath(target));
        } catch {
            toast.error(t.onboarding.reopenFailed);
        }
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="rounded-full" title={h.title} aria-label={h.title} data-testid="help-menu-trigger">
                    <CircleHelp className="h-5 w-5" aria-hidden="true" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={() => void reopen()}>
                    <ListChecks className="h-4 w-4" aria-hidden="true" />{h.guide}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {target === "teacher" ? (
                    <>
                        <DropdownMenuItem asChild><Link href="/help#grading"><ClipboardCheck className="h-4 w-4" aria-hidden="true" />{h.grading}</Link></DropdownMenuItem>
                        <DropdownMenuItem asChild><Link href="/help#roster"><Table2 className="h-4 w-4" aria-hidden="true" />{h.roster}</Link></DropdownMenuItem>
                        <DropdownMenuItem asChild><Link href="/help#mobile"><Smartphone className="h-4 w-4" aria-hidden="true" />{h.mobile}</Link></DropdownMenuItem>
                    </>
                ) : (
                    <DropdownMenuItem asChild><Link href={`/help#${target}`}><BookOpen className="h-4 w-4" aria-hidden="true" />{h.page}</Link></DropdownMenuItem>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
