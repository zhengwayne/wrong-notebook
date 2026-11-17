"use client";

import { useCallback, useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLanguage } from "@/contexts/LanguageContext";
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
    const [value, setValue] = useState<ReviewAlgorithmVersion>(DEFAULT_REVIEW_ALGORITHM);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const user = await apiClient.get<UserProfile>("/api/user");
            setValue(isReviewAlgorithmVersion(user.reviewAlgorithmVersion) ? user.reviewAlgorithmVersion : DEFAULT_REVIEW_ALGORITHM);
        } catch (error) {
            frontendLogger.error("[ReviewAlgorithmSetting]", "Failed to load review algorithm", { error: getErrorMessage(error) });
        } finally {
            setLoading(false);
        }
    }, []);

    // eslint-disable-next-line react-hooks/set-state-in-effect -- 数据请求：挂载时读取当前账号算法版本偏好
    useEffect(() => { void load(); }, [load]);

    const handleChange = async (next: string) => {
        if (!isReviewAlgorithmVersion(next) || next === value) return;
        const previous = value;
        setValue(next);
        setSaving(true);
        try {
            const updated = await apiClient.patch<UserProfile>("/api/user", { reviewAlgorithmVersion: next });
            setValue(isReviewAlgorithmVersion(updated.reviewAlgorithmVersion) ? updated.reviewAlgorithmVersion : next);
            toast.success(t.importFlow.preferenceSaved);
        } catch (error) {
            setValue(previous);
            toast.error(t.importFlow.preferenceSaveFailed);
            frontendLogger.error("[ReviewAlgorithmSetting]", "Failed to update review algorithm", { error: getErrorMessage(error) });
        } finally {
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
