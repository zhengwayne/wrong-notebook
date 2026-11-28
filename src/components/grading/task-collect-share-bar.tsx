"use client";

import { useState } from "react";
import { Copy, Link2, Link2Off, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { toast } from "@/lib/feedback";
import { studentLabel } from "@/lib/grading-labels";
import { buildMissingReminderCopy } from "@/lib/grading-reminder-copy";
import type { GradingStudentInfo, GradingSubmissionBrief } from "@/types/grading";

/** 剪贴板写入（兼容局域网 HTTP 环境降级 execCommand），返回是否复制成功 */
async function copyTextWithFallback(text: string): Promise<boolean> {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // 降级到 execCommand
        }
    }
    if (typeof document === "undefined") return false;
    try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        textarea.style.top = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        document.body.removeChild(textarea);
        return copied;
    } catch {
        return false;
    }
}

export function TaskCollectShareBar({
    taskId,
    taskTitle,
    subjectName,
    taskMode,
    allowSelfSubmit,
    students,
    submissions,
    multiClass,
    onChanged,
}: {
    taskId: string;
    taskTitle: string;
    subjectName: string;
    taskMode?: string;
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
    const [manualCopyText, setManualCopyText] = useState<string | null>(null);

    const isQuickMode = taskMode === "quick";
    const taken = new Set(
        submissions.map((s) => s.studentId).filter((id): id is string => Boolean(id)),
    );
    const missingNames = students
        .filter((s) => !taken.has(s.id))
        .map((s) => studentLabel(s, multiClass));

    const generateAndCopyLink = async () => {
        setBusy(true);
        setManualCopyText(null);
        try {
            const res = await apiClient.post<{ submitPath: string }>(`/api/grading/tasks/${taskId}/submit-link`, {});
            const fullUrl = `${window.location.origin}${res.submitPath}`;
            setLatestSubmitUrl(fullUrl);
            onChanged();
            const ok = await copyTextWithFallback(fullUrl);
            if (ok) {
                toast.success(copy.submitLinkCopied);
            } else {
                setManualCopyText(fullUrl);
                toast.warning(copy.copyFallbackHint);
            }
        } catch (err) {
            toast.error(err);
        } finally {
            setBusy(false);
        }
    };

    const closeLink = async () => {
        setBusy(true);
        setManualCopyText(null);
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
        setManualCopyText(null);
        try {
            const text = buildMissingReminderCopy({
                taskTitle,
                subjectName,
                missingNames,
                submitUrl: isQuickMode ? null : latestSubmitUrl,
                language: language === "en" ? "en" : "zh",
            });
            const ok = await copyTextWithFallback(text);
            if (ok) {
                toast.success(copy.reminderCopied);
            } else {
                setManualCopyText(text);
                toast.warning(copy.copyFallbackHint);
            }
        } catch (err) {
            toast.error(err);
        }
    };

    return (
        <div className="space-y-2 print:hidden">
            <div className="flex flex-wrap items-center gap-2">
                {!isQuickMode && (
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void generateAndCopyLink()}>
                        <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                        {allowSelfSubmit ? copy.refreshSubmitLink : copy.enableSubmitLink}
                    </Button>
                )}
                {!isQuickMode && allowSelfSubmit && (
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
            {manualCopyText && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                    <p className="mb-1 text-amber-800 dark:text-amber-300">{copy.copyFallbackHint}</p>
                    <input
                        type="text"
                        readOnly
                        value={manualCopyText}
                        onFocus={(e) => e.currentTarget.select()}
                        className="w-full rounded border bg-background px-2 py-1 font-mono text-xs"
                    />
                </div>
            )}
        </div>
    );
}

export function SubmissionShareButton({ submissionId }: { submissionId: string }) {
    const { t } = useLanguage();
    const copy = t.publicBridge;
    const [busy, setBusy] = useState(false);
    const [manualUrl, setManualUrl] = useState<string | null>(null);

    const handleShare = async () => {
        setBusy(true);
        setManualUrl(null);
        try {
            const res = await apiClient.post<{ sharePath: string }>(`/api/grading/submissions/${submissionId}/share`, {});
            const fullUrl = `${window.location.origin}${res.sharePath}`;
            const ok = await copyTextWithFallback(fullUrl);
            if (ok) {
                toast.success(copy.feedbackLinkCopied);
            } else {
                setManualUrl(fullUrl);
                toast.warning(copy.copyFallbackHint);
            }
        } catch (err) {
            toast.error(err);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex flex-col items-end gap-1">
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void handleShare()}>
                <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
                {copy.shareFeedbackCard}
            </Button>
            {manualUrl && (
                <input
                    type="text"
                    readOnly
                    value={manualUrl}
                    aria-label={copy.copyFallbackHint}
                    onFocus={(e) => e.currentTarget.select()}
                    className="w-56 rounded border bg-background px-2 py-0.5 font-mono text-[11px]"
                />
            )}
        </div>
    );
}
