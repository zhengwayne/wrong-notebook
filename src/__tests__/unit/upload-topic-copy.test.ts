import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_FILE_BYTES } from '@/components/upload-zone';
import { en } from '@/lib/translations/en';
import { zh } from '@/lib/translations/zh';
import { withTopicLabel } from '@/lib/variant/topic-label';

describe('上传区文案与实际限制一致', () => {
    const maxMb = String(Math.round(MAX_IMAGE_FILE_BYTES / (1024 * 1024)));

    it.each([['zh', zh], ['en', en]] as const)('%s：大小上限用 {max} 占位并列出全部可上传格式', (_lang, dict) => {
        expect(maxMb).toBe('20');
        expect(dict.upload.support).toContain('{max}');
        expect(dict.upload.support.replace('{max}', maxMb)).toContain('20MB');
        expect(dict.upload.support).not.toContain('5MB');
        for (const format of ['JPG', 'PNG', 'WebP', 'GIF', 'HEIC']) {
            expect(dict.upload.support).toContain(format);
            expect(dict.upload.invalidFileType).toContain(format);
        }
    });
});

describe('变式专题按钮的括号随语言切换', () => {
    it('中文用全角括号，英文用半角括号', () => {
        expect(withTopicLabel(zh.variants.withTopic, zh.variants.generateTopic, '一元一次方程'))
            .toBe(`${zh.variants.generateTopic}（一元一次方程）`);
        expect(withTopicLabel(en.variants.withTopic, en.variants.generateTopic, 'Linear equations'))
            .toBe(`${en.variants.generateTopic} (Linear equations)`);
        expect(en.variants.withTopic).not.toMatch(/[（）]/);
    });
});
