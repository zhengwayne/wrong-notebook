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
import { DEFAULT_QUESTION_DUPLICATE_THRESHOLD } from '@/lib/question-similarity';
import type { UserProfile } from '@/types/api';

interface DuplicateThresholdSettingProps {
    onSaved?: (threshold: number) => void;
}

/** 个人判重阈值独立保存，优先复用设置弹窗共享用户资料。 */
export function DuplicateThresholdSetting({ onSaved }: DuplicateThresholdSettingProps) {
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
            const threshold = user.questionDuplicateThreshold ?? DEFAULT_QUESTION_DUPLICATE_THRESHOLD;
            setDraft(null);
            setStandaloneSaved(threshold);
        } catch (error) {
            setMessage(t.importFlow.thresholdLoadFailed);
            frontendLogger.error('[Settings]', '加载判重阈值失败', { error: error instanceof Error ? error.message : String(error) });
        } finally {
            setStandaloneLoading(false);
        }
    }, [t.importFlow.thresholdLoadFailed]);

    // eslint-disable-next-line react-hooks/set-state-in-effect -- 数据请求：无共享上下文时进入设置后独立读取判重阈值
    useEffect(() => { if (!shared) void loadStandalone(); }, [shared, loadStandalone]);

    const saved = shared
        ? (shared.profile ? (shared.profile.questionDuplicateThreshold ?? DEFAULT_QUESTION_DUPLICATE_THRESHOLD) : null)
        : standaloneSaved;
    const loading = shared ? shared.loading : standaloneLoading;
    const value = draft ?? String(saved ?? DEFAULT_QUESTION_DUPLICATE_THRESHOLD);
    const number = Number(value);
    const valid = value.trim() !== '' && Number.isFinite(number) && number >= 1 && number <= 100
        && Math.abs(number * 100 - Math.round(number * 100)) < 0.000001;

    const load = () => {
        if (shared) {
            setMessage(null);
            void shared.refresh().then((res) => { if (!res) setMessage(t.importFlow.thresholdLoadFailed); });
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
                ? await shared.patchProfile({ questionDuplicateThreshold: number })
                : await apiClient.patch<UserProfile>('/api/user', { questionDuplicateThreshold: number });
            const threshold = user.questionDuplicateThreshold ?? number;
            if (!shared) setStandaloneSaved(threshold);
            setDraft(null);
            setMessage(t.importFlow.preferenceSaved);
            onSaved?.(threshold);
        } catch (error) {
            setMessage(t.importFlow.preferenceSaveFailed);
            frontendLogger.error('[Settings]', '保存判重阈值失败', { error: error instanceof Error ? error.message : String(error) });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-2 border-t pt-4">
            <Label htmlFor="question-duplicate-threshold">{t.importFlow.thresholdLabel}</Label>
            <div className="flex flex-wrap items-center gap-2">
                <Input id="question-duplicate-threshold" type="number" min={1} max={100} step={0.01}
                    value={value} onChange={(event) => { setDraft(event.target.value); setMessage(null); }}
                    disabled={loading || saving || saved === null} className="w-28" aria-describedby="question-duplicate-threshold-hint" />
                <span aria-hidden="true">%</span>
                <Button type="button" size="sm" variant="outline" onClick={save} disabled={loading || saving || saved === null || !valid || number === saved}>
                    {(loading || saving) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t.importFlow.saveThreshold}
                </Button>
                {!loading && saved === null && <Button type="button" size="sm" variant="outline" onClick={load}>{t.importFlow.retryLoad}</Button>}
            </div>
            <p id="question-duplicate-threshold-hint" className="text-xs text-muted-foreground">{t.importFlow.thresholdDescription}</p>
            {saved !== null && !valid && <p className="text-xs text-destructive" role="alert">{t.importFlow.thresholdInvalid}</p>}
            {message && <p className="text-xs text-muted-foreground" role="status">{message}</p>}
        </div>
    );
}
