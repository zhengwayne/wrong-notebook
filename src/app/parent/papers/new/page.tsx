"use client";

import { ParentPaperEditor } from "@/components/parent/parent-paper-editor";
import { EmptyState } from "@/components/ui/empty-state";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { useLanguage } from "@/contexts/LanguageContext";
import { useCurrentChild } from "@/lib/use-current-child";
import { usePageTitle } from "@/lib/page-title";
import { Users } from "lucide-react";

export default function NewParentPaperPage() {
    const { t } = useLanguage();
    const copy = t.parentPapers;
    const { learnerId, childName, hrefWithChild } = useCurrentChild();
    usePageTitle(t.pageTitle.parentPaperNew);

    return (
        <PageContainer>
            <div className="mx-auto max-w-3xl space-y-6 py-6">
                <PageHeader
                    title={copy.newTitle}
                    description={learnerId ? (childName ? copy.forChild.replace("{name}", childName) : copy.newDesc) : copy.noChildHint}
                    backHref={hrefWithChild(learnerId ? "/parent/papers" : "/parent")}
                />
                {learnerId ? (
                    <ParentPaperEditor learnerId={learnerId} childName={childName} />
                ) : (
                    <EmptyState icon={Users} title={copy.noChild} description={copy.noChildHint} />
                )}
            </div>
        </PageContainer>
    );
}
