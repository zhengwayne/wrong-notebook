import { describe, expect, it } from 'vitest';
import { answersEquivalent, verifyComputable } from '@/lib/variant/verify';

describe('answersEquivalent', () => {
    it('比较数值、分数和「或」连接的多种答案', () => {
        expect(answersEquivalent('1/2', '0.5')).toBe(true);
        expect(answersEquivalent('50%', '1/2')).toBe(true);
        expect(answersEquivalent('3 或 -3', '-3')).toBe(true);
        expect(answersEquivalent('A', 'a')).toBe(true);
        expect(answersEquivalent('2', '3')).toBe(false);
    });
});

describe('verifyComputable', () => {
    it('求值表达式并与答案比较', () => {
        const result = verifyComputable({ type: 'expression', expression: '1/2+1/4', expected: '0.75' }, '3/4');
        expect(result.computable).toBe(true);
        expect(result.passed).toBe(true);
    });

    it('答案与验算不一致时不通过', () => {
        const result = verifyComputable({ type: 'expression', expression: '2+3', expected: '10' }, '10');
        expect(result.computable).toBe(true);
        expect(result.passed).toBe(false);
    });

    it('把答案代入方程验算', () => {
        const result = verifyComputable({ type: 'equation', expression: '2*x+1=7', expected: '3' }, '3');
        expect(result.computable).toBe(true);
        expect(result.passed).toBe(true);
    });

    it('拒绝函数调用之外的不安全表达式，且不执行代码', () => {
        const result = verifyComputable({ type: 'expression', expression: 'eval(1+1)', expected: '2' }, '2');
        expect(result.computable).toBe(false);
        expect(result.passed).toBe(false);
    });

    it('没有可计算字段时不能自动通过', () => {
        const result = verifyComputable(null, '4');
        expect(result.computable).toBe(false);
        expect(result.passed).toBe(false);
    });
});
