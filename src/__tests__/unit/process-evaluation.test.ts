import { describe, expect, it } from 'vitest';
import {
    PROCESS_CAPSULE_KEYS,
    synthesizeTeacherComment,
    visualAlertDefaultCapsules,
} from '@/lib/process-evaluation';

describe('Batch 3: 写字/整洁度/学习态度三维评价与 1 秒评语胶囊合成器', () => {
    it('内置 8 枚高频评价胶囊并可将 AI 宏观涂改留白预警映射为推荐胶囊', () => {
        expect(PROCESS_CAPSULE_KEYS).toHaveLength(8);
        expect(visualAlertDefaultCapsules(['heavy_erasure', 'large_blank'])).toEqual([
            'too_many_erasures',
            'avoid_blank',
        ]);
    });

    it('synthesizeTeacherComment 支持中英文双语，将三维等级与选中胶囊即时拼装为自然评语', () => {
        const zhText = synthesizeTeacherComment(
            {
                handwritingLevel: 'good',
                neatnessLevel: 'fair',
                attitudeLevel: 'excellent',
                capsuleKeys: ['serious_attitude', 'too_many_erasures'],
            },
            'zh',
        );
        expect(zhText).toContain('书写：良');
        expect(zhText).toContain('整洁：合格');
        expect(zhText).toContain('态度：优');
        expect(zhText).toContain('涂改');

        const enText = synthesizeTeacherComment(
            {
                handwritingLevel: 'excellent',
                neatnessLevel: 'excellent',
                attitudeLevel: 'excellent',
                capsuleKeys: ['neat_writing'],
            },
            'en',
        );
        expect(enText).toContain('Handwriting: Excellent');
        expect(enText).toContain('neat');
    });
});
