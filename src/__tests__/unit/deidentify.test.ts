import { describe, expect, it } from 'vitest';
import { deidentifyQuestionText } from '@/lib/variant/deidentify';

describe('deidentifyQuestionText', () => {
    it('去掉带标签的姓名和学号，保留题干', () => {
        const result = deidentifyQuestionText('姓名：张三 学号：01\n已知 2x+1=7，求 x。');
        expect(result.stripped).toBe(true);
        expect(result.text).toContain('求 x');
        expect(result.text).not.toContain('张三');
        expect(result.text).not.toContain('01');
        expect(result.text).toContain('[姓名]');
        expect(result.text).toContain('[学号]');
    });

    it('不去掉应用题中的角色名', () => {
        const result = deidentifyQuestionText('小明有 12 个苹果，吃了 5 个，还剩多少个？');
        expect(result.stripped).toBe(false);
        expect(result.text).toContain('小明');
    });
});
