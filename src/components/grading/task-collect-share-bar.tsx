"use client";

import { useState } from "react";
import { Copy, Link2, Link2Off, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { toast } from "@/lib/feedback";
import { studentLabel } from "@/lib/grading-labels";
import { buildMissingReminderCopy } from "@/lib/grading-share-tokens";
import type { GradingStudentInfo, GradingSubmissionBrief } from "@/types/grading";

export function TaskCollectShareBar({
    taskId,
    taskTitle,
    subjectName,
    allowSelfSubmit,
    students,
    submissions,
    multiClass,
    onChanged,
}: {
    taskId: string;
    taskTitle: string;
    subjectName: string;
    allowSelfSubmit?: boolean;
    students: GradingStudentInfo[];
    submissions: GradingSubmissionBrief[];
    multiClass: boolean;
    onChanged: () => void;
}) {
    const { t, language } = useLanguage();
    const copy = t.publicBridge;
    const [busy, setBusy] = useState(false);
    const [latestSubmitUrl, setLatestSubmitUrl] = useState<string | null>(null);

    const taken = new Set(
        submissions.map((s) => s.studentId).filter((id): id is string => Boolean(id)),
    );
    const missingNames = students
        .filter((s) => !taken.has(s.id))
        .map((s) => studentLabel(s, multiClass));

    const generateAndCopyLink = async () => {
        setBusy(true);
        try {
            const res = await apiClient.post<{ submitPath: string }>(`/api/grading/tasks/${taskId}/submit-link`, {});
            const fullUrl = `${window.location.origin}${res.submitPath}`;
            setLatestSubmitUrl(fullUrl);
            await navigator.clipboard?.writeText(fullUrl);
            toast.success(copy.submitLinkCopied);
            onChanged();
        } catch (err) {
            toast.error(err);
        } finally {
            setBusy(false);
        }
    };

    const closeLink = async () => {
        setBusy(true);
        try {
            await apiClient.delete(`/api/grading/tasks/${taskId}/submit-link`);
            setLatestSubmitUrl(null);
            toast.success(copy.submitLinkClosed);
            onChanged();
        } catch (err) {
            toast.error(err);
        } finally {
            setBusy(false);
        }
    };

    const copyMissingReminder = async () => {
        const text = buildMissingReminderCopy({
            taskTitle,
            subjectName,
            missingNames,
            submitUrl: latestSubmitUrl,
            language: language === "en" ? "en" : "zh",
        });
        await navigator.clipboard?.writeText(text);
        toast.success(copy.reminderCopied);
    };

    return (
        <div className="flex flex-wrap items-center gap-2 print:hidden">
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void generateAndCopyLink()}>
                <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                {allowSelfSubmit ? copy.refreshSubmitLink : copy.enableSubmitLink}
            </Button>
            {allowSelfSubmit && (
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void closeLink()}>
                    <Link2Off className="h-3.5 w-3.5" aria-hidden="true" />
                    {copy.disableSubmitLink}
                </Button>
            )}
            {missingNames.length > 0 && (
                <Button type="button" size="sm" variant="outline" onClick={() => void copyMissingReminder()}>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    {copy.copyReminder.replace("{count}", String(missingNames.length))}
                </Button>
            )}
        </div>
    );
}

export function SubmissionShareButton({ submissionId }: { submissionId: string }) {
    const { t } = useLanguage();
    const copy = t.publicBridge;
    const [busy, setBusy] = useState(false);

    const handleShare = async () => {
        setBusy(true);
        try {
            const res = await apiClient.post<{ sharePath: string }>(`/api/grading/submissions/${submissionId}/share`, {});
            const fullUrl = `${window.location.origin}${res.sharePath}`;
            await navigator.clipboard?.writeText(fullUrl);
            toast.success(copy.feedbackLinkCopied);
        } catch (err) {
            toast.error(err);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void handleShare()}>
            <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
            {copy.shareFeedbackCard}
        </Button>
    );
}
