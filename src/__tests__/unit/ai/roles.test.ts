import { describe, expect, it } from 'vitest';
import { applyTextRoleConfig, getConfigForRole, isTextSameAsVision, snapshotVisionAsTextAi } from '@/lib/ai/roles';
import type { AppConfig } from '@/types/api';

const vision: AppConfig = {
    aiProvider: 'gemini',
    gemini: { apiKey: 'vision-key', model: 'gemini-flash' },
    minimax: { apiKey: 'mm-key', model: 'MiniMax-M3.1-Flash' },
};

describe('AI 模型角色配置', () => {
    it('缺省或显式 true 时文本角色复用多模态配置', () => {
        expect(isTextSameAsVision(vision)).toBe(true);
        expect(isTextSameAsVision({ ...vision, textSameAsVision: true })).toBe(true);
        expect(getConfigForRole(vision, 'text').gemini?.apiKey).toBe('vision-key');
        expect(getConfigForRole(vision, 'vision').aiProvider).toBe('gemini');
    });

    it('关闭共用后文本与多模态互不影响', () => {
        const config: AppConfig = {
            ...vision,
            textSameAsVision: false,
            aiTextProvider: 'minimax',
            textAi: { minimax: { apiKey: 'text-key', model: 'text-model' } },
        };
        expect(isTextSameAsVision(config)).toBe(false);
        expect(getConfigForRole(config, 'vision').gemini?.model).toBe('gemini-flash');
        const text = getConfigForRole(config, 'text');
        expect(text.aiProvider).toBe('minimax');
        expect(text.minimax?.model).toBe('text-model');
        expect(text.gemini?.apiKey).toBeUndefined();
    });

    it('snapshot 与 apply 可把当前多模态配置写成文本角色初始值', () => {
        const snap = snapshotVisionAsTextAi(vision);
        expect(snap.gemini?.apiKey).toBe('vision-key');
        const next = applyTextRoleConfig(vision, { ...vision, aiProvider: 'minimax', minimax: { apiKey: 'new', model: 'm' } });
        expect(next.textSameAsVision).toBe(false);
        expect(next.aiTextProvider).toBe('minimax');
        expect(next.textAi?.minimax).toEqual({ apiKey: 'new', model: 'm' });
        expect(next.aiProvider).toBe('gemini');
    });
});
