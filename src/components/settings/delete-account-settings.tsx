"use client";

import { useState } from "react";
import { Loader2, UserX } from "lucide-react";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient, ApiError } from "@/lib/api-client";
import { toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";

/** 账户自助彻底注销组件：引导先备份数据，输入当前密码验证后清除账户与全部个人学习数据 */
export function DeleteAccountSettings() {
    const { t } = useLanguage();
    const copy = t.settings?.deleteAccount;
    const [expanded, setExpanded] = useState(false);
    const [password, setPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const handleDelete = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!password.trim()) {
            toast.error(copy?.passwordRequired || "Please enter your current password");
            return;
        }

        setSubmitting(true);
        try {
            await apiClient.delete("/api/user", { body: JSON.stringify({ password }) });
            toast.success(copy?.success || "Account and personal data deleted");
            await signOut({ callbackUrl: "/login" });
        } catch (error) {
            frontendLogger.error("[DeleteAccountSettings]", "Failed to delete account", { error });
            if (error instanceof ApiError) {
                if (error.message === "INCORRECT_PASSWORD") {
                    toast.error(copy?.wrongPassword || "Incorrect password");
                    return;
                }
                if (error.message.includes("last active admin") || error.message.includes("super admin")) {
                    toast.error(copy?.protectedAdmin || "Default or last active admin cannot be deleted");
                    return;
                }
            }
            toast.error(copy?.failed || "Failed to delete account");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="p-4 border rounded-lg border-red-600/50 bg-red-100/40 dark:bg-red-950/30 space-y-3">
            <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold flex items-center gap-2 text-red-900 dark:text-red-200">
                    <UserX className="h-4 w-4 shrink-0" />
                    {copy?.title || "Delete Account Permanently"}
                </span>
                {!expanded && (
                    <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => setExpanded(true)}
                    >
                        {copy?.openButton || "Delete Account"}
                    </Button>
                )}
            </div>
            <p className="text-xs text-red-800 dark:text-red-300 leading-relaxed">
                {copy?.desc || "Export your backup above before deleting. Permanently deletes your account, notebooks, questions, practice records, learners, exam/grading papers and private speech caches."}
            </p>
            {expanded && (
                <form onSubmit={handleDelete} className="space-y-3 pt-2 border-t border-red-300/60 dark:border-red-900/60">
                    <div className="space-y-1.5">
                        <Label htmlFor="delete-account-password" className="text-xs text-red-900 dark:text-red-200">
                            {copy?.passwordLabel || "Confirm with current password"}
                        </Label>
                        <Input
                            id="delete-account-password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={copy?.passwordPlaceholder || "Enter your current password"}
                            autoComplete="current-password"
                            disabled={submitting}
                        />
                    </div>
                    <div className="flex items-center justify-end gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={submitting}
                            onClick={() => {
                                setExpanded(false);
                                setPassword("");
                            }}
                        >
                            {copy?.cancelButton || "Cancel"}
                        </Button>
                        <Button
                            type="submit"
                            variant="destructive"
                            size="sm"
                            disabled={submitting || !password.trim()}
                        >
                            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                            {copy?.confirmButton || "Confirm Permanent Deletion"}
                        </Button>
                    </div>
                </form>
            )}
        </div>
    );
}
