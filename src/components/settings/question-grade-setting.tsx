"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { GradeSemesterSelect } from '@/components/grade-semester-select';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import { useOptionalUserProfile } from '@/contexts/UserProfileContext';
import { apiClient } from '@/lib/api-client';
import { getErrorMessage } from '@/lib/error-message';
import { frontendLogger } from '@/lib/frontend-logger';
import type { GradeRecognitionMode } from '@/lib/question-grade';
import type { UserProfile } from '@/types/api';

interface GradePreference {
    gradeRecognitionMode: GradeRecognitionMode;
    fixedGradeSemester: string | null;
}

/** 每个账户独立保存，固定年级与识别模式一起提交。 */
export function QuestionGradeSetting() {
    const { t } = useLanguage();
    const shared = useOptionalUserProfile();
    const [draft, setDraft] = useState<GradePreference | null>(null);
    const [standaloneSaved, setStandaloneSaved] = useState<GradePreference | null>(null);
    const [standaloneLoading, setStandaloneLoading] = useState(!shared);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const loadVersion = useRef(0);

    const loadStandalone = useCallback(async () => {
        const version = ++loadVersion.current;
        setStandaloneLoading(true);
        setMessage(null);
        try {
            const user = await apiClient.get<UserProfile>('/api/user');
            if (version !== loadVersion.current) return;
            const preference: GradePreference = {
                gradeRecognitionMode: user.gradeRecognitionMode ?? 'fixed',
                fixedGradeSemester: user.fixedGradeSemester ?? null,
            };
            setDraft(null);
            setStandaloneSaved(preference);
        } catch (error) {
            if (version !== loadVersion.current) return;
            setMessage(t.questionGrade.loadFailed);
            frontendLogger.error('[QuestionGradeSetting]', '加载录入年级规则失败', { error: getErrorMessage(error) });
        } finally {
            if (version === loadVersion.current) setStandaloneLoading(false);
        }
    }, [t.questionGrade.loadFailed]);

    // eslint-disable-next-line react-hooks/set-state-in-effect -- 数据请求：无共享上下文时加载账户的年级规则
    useEffect(() => { if (!shared) void loadStandalone(); }, [shared, loadStandalone]);

    const saved: GradePreference | null = shared
        ? (shared.profile ? {
            gradeRecognitionMode: shared.profile.gradeRecognitionMode ?? 'fixed',
            fixedGradeSemester: shared.profile.fixedGradeSemester ?? null,
        } : null)
        : standaloneSaved;
    const loading = shared ? shared.loading : standaloneLoading;
    const value: GradePreference = draft ?? saved ?? { gradeRecognitionMode: 'fixed', fixedGradeSemester: null };

    const load = () => {
        if (shared) {
            setMessage(null);
            void shared.refresh().then((res) => { if (!res) setMessage(t.questionGrade.loadFailed); });
            return;
        }
        void loadStandalone();
    };

    const save = async () => {
        setSaving(true);
        setMessage(null);
        try {
            const user = shared
                ? await shared.patchProfile(value)
                : await apiClient.patch<UserProfile>('/api/user', value);
            const preference: GradePreference = {
                gradeRecognitionMode: user.gradeRecognitionMode ?? value.gradeRecognitionMode,
                fixedGradeSemester: user.fixedGradeSemester ?? null,
            };
            if (!shared) setStandaloneSaved(preference);
            setDraft(null);
            setMessage(t.importFlow.preferenceSaved);
        } catch (error) {
            setMessage(t.importFlow.preferenceSaveFailed);
            frontendLogger.error('[QuestionGradeSetting]', '保存录入年级规则失败', { error: getErrorMessage(error) });
        } finally {
            setSaving(false);
        }
    };

    const disabled = loading || saving || saved === null;
    const unchanged = saved?.gradeRecognitionMode === value.gradeRecognitionMode && saved?.fixedGradeSemester === value.fixedGradeSemester;
    return (
        <div className="space-y-3 border-t pt-4">
            <div className="space-y-2">
                <Label htmlFor="question-grade-mode">{t.questionGrade.label}</Label>
                <select id="question-grade-mode" value={value.gradeRecognitionMode} disabled={disabled}
                    onChange={(event) => { setDraft({ ...value, gradeRecognitionMode: event.target.value as GradeRecognitionMode }); setMessage(null); }}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50">
                    <option value="fixed">{t.questionGrade.fixed}</option>
                    <option value="ai">{t.questionGrade.ai}</option>
                </select>
            </div>
            {value.gradeRecognitionMode === 'fixed' && (
                <div className="space-y-2">
                    <Label htmlFor="question-fixed-grade">{t.editor.gradeSemester}</Label>
                    <GradeSemesterSelect id="question-fixed-grade" value={value.fixedGradeSemester ?? ''} disabled={disabled}
                        onChange={(grade) => { setDraft({ ...value, fixedGradeSemester: grade || null }); setMessage(null); }} />
                </div>
            )}
            <p className="text-xs text-muted-foreground">{value.gradeRecognitionMode === 'fixed' ? t.questionGrade.fixedDescription : t.questionGrade.aiDescription}</p>
            <p className="text-xs text-muted-foreground">{t.questionGrade.description}</p>
            <Button type="button" variant="outline" size="sm" disabled={disabled || unchanged} onClick={save}>
                {(loading || saving) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t.questionGrade.save}
            </Button>
            {!loading && saved === null && <Button type="button" variant="outline" size="sm" onClick={load}>{t.importFlow.retryLoad}</Button>}
            {message && <p className="text-xs text-muted-foreground" role="status">{message}</p>}
        </div>
    );
}
