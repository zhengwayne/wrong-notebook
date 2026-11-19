import { describe, expect, it } from 'vitest';
import { answersEquivalent, checkAnswers, parseAnswer, verifyComputable } from '@/lib/variant/verify';

describe('parseAnswer 与 checkAnswers 结构化比对（OPT-09 / D4）', () => {
    it('解析标量、元组、集合与多小问结构', () => {
        expect(parseAnswer('50%').kind).toBe('scalar');
        expect(parseAnswer('12 cm')).toEqual({ kind: 'scalar', value: '12', unit: 'cm' });
        expect(parseAnswer('(1, 2)')).toMatchObject({ kind: 'tuple' });
        expect(parseAnswer('2 或 3')).toMatchObject({ kind: 'set' });
        expect(parseAnswer('(1) 3 (2) 5')).toMatchObject({ kind: 'parts' });
    });

    it('比较数值、分数、百分数和集合双向完整匹配', () => {
        expect(answersEquivalent('1/2', '0.5')).toBe(true);
        expect(answersEquivalent('50%', '1/2')).toBe(true);
        expect(answersEquivalent('3 或 -3', '-3 或 3')).toBe(true);
        expect(answersEquivalent('{2, 3}', 'x1=3, x2=2')).toBe(true);
        expect(answersEquivalent('A', 'a')).toBe(true);
        expect(answersEquivalent('2', '3')).toBe(false);
    });

    it('拦截 D4 反例：缺失根、额外根、不同坐标与逗号列表', () => {
        // 缺失一个根
        expect(answersEquivalent('3 或 -3', '-3')).toBe(false);
        expect(checkAnswers('x=2 或 x=3', 'x=2').status).toBe('failed');
        // 额外一个根
        expect(checkAnswers('2 或 3', '2 或 3 或 4').status).toBe('failed');
        // 坐标顺序不同
        expect(checkAnswers('(1, 2)', '(2, 1)').status).toBe('failed');
        expect(checkAnswers('(1, 2)', '(1.0, 4/2)').status).toBe('passed');
        // 逗号不再一律当「或」
        expect(checkAnswers('1, 2', '1').status).toBe('failed');
        expect(checkAnswers('1, 2', '2, 1').status).toBe('failed');
    });

    it('校验单位不一致与多小问漏答', () => {
        expect(checkAnswers('5 cm', '5 m').status).toBe('failed');
        expect(checkAnswers('5 cm', '5').status).toBe('failed');
        expect(checkAnswers('5 cm', '5厘米').status).toBe('passed');

        expect(checkAnswers('(1) 3 (2) 5', '(1) 3 (2) 5').status).toBe('passed');
        expect(checkAnswers('(1) 3 (2) 5', '(1) 3').status).toBe('failed');
        expect(checkAnswers('(1) 3 (2) 5', '(1) 3 (2) 6').status).toBe('failed');
    });

    it('不可可靠解析的表达式给出 unknown 且不会放行', () => {
        const res = checkAnswers('\\vec{a} + \\vec{b}', 'a + b');
        expect(res.status).toBe('unknown');
        expect(answersEquivalent('\\vec{a} + \\vec{b}', 'a + b')).toBe(false);
    });
});

describe('verifyComputable 与方程验算（OPT-09 + E7）', () => {
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

    it('expected 与 answerText 冲突时必须失败（R04）', () => {
        const result = verifyComputable({ type: 'expression', expression: '2+2', expected: '4' }, '5');
        expect(result.passed).toBe(false);
    });

    it('方程支持隐式乘法、多根与多字母变量', () => {
        expect(verifyComputable({ type: 'equation', expression: '2x=6', expected: '3' }, 'x=3').passed).toBe(true);
        expect(verifyComputable({ type: 'equation', expression: 'x^2-5x+6=0', expected: '2 或 3' }, 'x=2 或 x=3').passed).toBe(true);
        expect(verifyComputable({ type: 'equation', expression: 'x^2-5x+6=0', expected: '2 或 4' }, '2 或 4').passed).toBe(false);
        expect(verifyComputable({ type: 'equation', expression: '2*v0+1=11', expected: '5' }, 'v0=5').passed).toBe(true);
    });

    it('拒绝 1=1 等无自由变量的恒等式绕过', () => {
        const result = verifyComputable({ type: 'equation', expression: '1=1', expected: '1' }, '1');
        expect(result.computable).toBe(false);
        expect(result.passed).toBe(false);
        expect(result.detail).toContain('NO_FREE_VARIABLE');
    });

    it('保护自然常数 e 不被替换（E7）', () => {
        const ok = verifyComputable({ type: 'equation', expression: 'e*x=2*e', expected: '2' }, '2');
        expect(ok.computable).toBe(true);
        expect(ok.passed).toBe(true);

        const wrong = verifyComputable({ type: 'equation', expression: 'e*x=2*e', expected: '1' }, '1');
        expect(wrong.passed).toBe(false);

        const onlyConst = verifyComputable({ type: 'equation', expression: 'e=e', expected: '2' }, '2');
        expect(onlyConst.computable).toBe(false);
        expect(onlyConst.passed).toBe(false);
    });

    it('numeric 分支单独校验证明（E7）', () => {
        expect(verifyComputable({ type: 'numeric', expression: '2.5e2', expected: '250' }, '250').passed).toBe(true);
        expect(verifyComputable({ type: 'numeric', expression: 'sqrt(16)', expected: '4' }, '4 cm').passed).toBe(true);
        const withVar = verifyComputable({ type: 'numeric', expression: '2*x', expected: '4' }, '4');
        expect(withVar.computable).toBe(false);
        expect(withVar.passed).toBe(false);
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

    it('避免物理单位吞掉代数变量，并防止自由变量退化为单点采样', () => {
        expect(checkAnswers('2m', 'm + m').status).toBe('passed');
        expect(checkAnswers('2米', 'm + m').status).toBe('failed');
        expect(checkAnswers('2p', 'p + 1.87').status).toBe('failed');
    });
});
