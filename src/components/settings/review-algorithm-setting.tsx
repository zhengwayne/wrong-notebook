"use client";

import { useCallback, useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLanguage } from "@/contexts/LanguageContext";
import { useOptionalUserProfile } from "@/contexts/UserProfileContext";
import { apiClient } from "@/lib/api-client";
import { getErrorMessage } from "@/lib/error-message";
import { toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import {
    DEFAULT_REVIEW_ALGORITHM,
    isReviewAlgorithmVersion,
    type ReviewAlgorithmVersion,
} from "@/lib/memory-model";
import type { UserProfile } from "@/types/api";

/** 个人复习调度算法版本选择（classic Ebbinghaus / fsrs-v1 灰度） */
export function ReviewAlgorithmSetting() {
    const { t } = useLanguage();
    const shared = useOptionalUserProfile();
    const [standaloneValue, setStandaloneValue] = useState<ReviewAlgorithmVersion>(DEFAULT_REVIEW_ALGORITHM);
    const [standaloneLoading, setStandaloneLoading] = useState(!shared);
    const [optimistic, setOptimistic] = useState<ReviewAlgorithmVersion | null>(null);
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        setStandaloneLoading(true);
        try {
            const user = await apiClient.get<UserProfile>("/api/user");
            setStandaloneValue(isReviewAlgorithmVersion(user.reviewAlgorithmVersion) ? user.reviewAlgorithmVersion : DEFAULT_REVIEW_ALGORITHM);
        } catch (error) {
            frontendLogger.error("[ReviewAlgorithmSetting]", "Failed to load review algorithm", { error: getErrorMessage(error) });
        } finally {
            setStandaloneLoading(false);
        }
    }, []);

    // eslint-disable-next-line react-hooks/set-state-in-effect -- 数据请求：仅在无共享上下文时独立读取偏好
    useEffect(() => { if (!shared) void load(); }, [shared, load]);

    const baseValue = shared
        ? (isReviewAlgorithmVersion(shared.profile?.reviewAlgorithmVersion) ? shared.profile.reviewAlgorithmVersion : DEFAULT_REVIEW_ALGORITHM)
        : standaloneValue;
    const value = optimistic ?? baseValue;
    const loading = shared ? shared.loading : standaloneLoading;

    const handleChange = async (next: string) => {
        if (!isReviewAlgorithmVersion(next) || next === value) return;
        setOptimistic(next);
        setSaving(true);
        try {
            const updated = shared
                ? await shared.patchProfile({ reviewAlgorithmVersion: next })
                : await apiClient.patch<UserProfile>("/api/user", { reviewAlgorithmVersion: next });
            if (!shared) {
                setStandaloneValue(isReviewAlgorithmVersion(updated.reviewAlgorithmVersion) ? updated.reviewAlgorithmVersion : next);
            }
            toast.success(t.importFlow.preferenceSaved);
        } catch (error) {
            toast.error(t.importFlow.preferenceSaveFailed);
            frontendLogger.error("[ReviewAlgorithmSetting]", "Failed to update review algorithm", { error: getErrorMessage(error) });
        } finally {
            setOptimistic(null);
            setSaving(false);
        }
    };

    return (
        <div className="space-y-2 border-t pt-4">
            <Label htmlFor="review-algorithm-version">{t.settings.reviewAlgorithmLabel}</Label>
            <Select value={value} onValueChange={handleChange} disabled={loading || saving}>
                <SelectTrigger id="review-algorithm-version">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="ebbinghaus-v1">{t.settings.reviewAlgorithmEbbinghaus}</SelectItem>
                    <SelectItem value="fsrs-v1">{t.settings.reviewAlgorithmFsrs}</SelectItem>
                </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t.settings.reviewAlgorithmDesc}</p>
        </div>
    );
}
