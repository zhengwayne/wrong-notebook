"use client";

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import { useOptionalUserProfile } from '@/contexts/UserProfileContext';
import { apiClient } from '@/lib/api-client';
import { frontendLogger } from '@/lib/frontend-logger';
import { DEFAULT_MASTERY_THRESHOLD, MAX_MASTERY_THRESHOLD, MIN_MASTERY_THRESHOLD } from '@/lib/mastery-status';
import type { UserProfile } from '@/types/api';

/** 个人已掌握阈值独立保存，复习状态筛选、统计和组卷直接读取持久化值。 */
export function MasteryThresholdSetting() {
    const { t } = useLanguage();
    const shared = useOptionalUserProfile();
    const [draft, setDraft] = useState<string | null>(null);
    const [standaloneSaved, setStandaloneSaved] = useState<number | null>(null);
    const [standaloneLoading, setStandaloneLoading] = useState(!shared);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    const loadStandalone = useCallback(async () => {
        setStandaloneLoading(true);
        setMessage(null);
        try {
            const user = await apiClient.get<UserProfile>('/api/user');
            const threshold = user.masteryThreshold ?? DEFAULT_MASTERY_THRESHOLD;
            setDraft(null);
            setStandaloneSaved(threshold);
        } catch (error) {
            setMessage(t.mastery.thresholdLoadFailed);
            frontendLogger.error('[Settings]', '加载已掌握阈值失败', { error: error instanceof Error ? error.message : String(error) });
        } finally {
            setStandaloneLoading(false);
        }
    }, [t.mastery.thresholdLoadFailed]);

    // eslint-disable-next-line react-hooks/set-state-in-effect -- 数据请求：无共享上下文时进入页面独立读取已掌握阈值
    useEffect(() => { if (!shared) void loadStandalone(); }, [shared, loadStandalone]);

    const saved = shared
        ? (shared.profile ? (shared.profile.masteryThreshold ?? DEFAULT_MASTERY_THRESHOLD) : null)
        : standaloneSaved;
    const loading = shared ? shared.loading : standaloneLoading;
    const value = draft ?? String(saved ?? DEFAULT_MASTERY_THRESHOLD);
    const number = Number(value);
    const valid = value.trim() !== '' && Number.isInteger(number) && number >= MIN_MASTERY_THRESHOLD && number <= MAX_MASTERY_THRESHOLD;

    const load = () => {
        if (shared) {
            setMessage(null);
            void shared.refresh().then((res) => { if (!res) setMessage(t.mastery.thresholdLoadFailed); });
            return;
        }
        void loadStandalone();
    };

    const save = async () => {
        if (!valid || saved === null) return;
        setSaving(true);
        setMessage(null);
        try {
            const user = shared
                ? await shared.patchProfile({ masteryThreshold: number })
                : await apiClient.patch<UserProfile>('/api/user', { masteryThreshold: number });
            const threshold = user.masteryThreshold ?? number;
            if (!shared) setStandaloneSaved(threshold);
            setDraft(null);
            setMessage(t.importFlow.preferenceSaved);
        } catch (error) {
            setMessage(t.importFlow.preferenceSaveFailed);
            frontendLogger.error('[Settings]', '保存已掌握阈值失败', { error: error instanceof Error ? error.message : String(error) });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-2 border-t pt-4">
            <Label htmlFor="mastery-threshold">{t.mastery.thresholdLabel}</Label>
            <div className="flex flex-wrap items-center gap-2">
                <Input id="mastery-threshold" type="number" min={MIN_MASTERY_THRESHOLD} max={MAX_MASTERY_THRESHOLD} step={1}
                    value={value} onChange={(event) => { setDraft(event.target.value); setMessage(null); }}
                    disabled={loading || saving || saved === null} className="w-28" aria-describedby="mastery-threshold-hint" />
                <span aria-hidden="true">%</span>
                <Button type="button" size="sm" variant="outline" onClick={save} disabled={loading || saving || saved === null || !valid || number === saved}>
                    {(loading || saving) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t.importFlow.saveThreshold}
                </Button>
                {!loading && saved === null && <Button type="button" size="sm" variant="outline" onClick={load}>{t.importFlow.retryLoad}</Button>}
            </div>
            <p id="mastery-threshold-hint" className="text-xs text-muted-foreground">{t.mastery.thresholdDescription}</p>
            {saved !== null && !valid && <p className="text-xs text-destructive" role="alert">{t.mastery.thresholdInvalid}</p>}
            {message && <p className="text-xs text-muted-foreground" role="status">{message}</p>}
        </div>
    );
}
