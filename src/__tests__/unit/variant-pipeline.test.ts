import { describe, expect, it, vi } from 'vitest';
import { runVariantPipeline, type VariantAi } from '@/lib/variant/pipeline';

function ai(overrides: Partial<VariantAi> = {}): VariantAi {
    return {
        plan: vi.fn(async () => ({ data: { analysis: '围绕解方程出变式', variants: [
            { vary: '更换系数', skill: '解一元一次方程', knowledgePoints: ['方程'], difficulty: 'medium' },
        ] } })),
        generate: vi.fn(async () => ({ data: {
            questionText: '解方程 3x-1=8', answerText: '3', analysis: '移项得 3x=9，x=3',
            knowledgePoints: ['方程'], computable: { type: 'equation', expression: '3*x-1=8', expected: '3' },
        } })),
        resolve: vi.fn(async () => ({ data: { answer: '3' }, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } })),
        checkDifficulty: vi.fn(async () => ({ data: { difficulty: 'medium', reason: '一步移项', consistent: true } })),
        ...overrides,
    };
}

describe('runVariantPipeline', () => {
    it('验算与重解都通过时标记为已验证，并脱敏原题', async () => {
        const result = await runVariantPipeline({
            originalQuestion: '姓名：李四 学号：08\n解方程 2x+1=7',
            knowledgePoints: ['方程'],
            errorType: '计算',
            targetDifficulty: 'medium',
            language: 'zh',
        }, ai());
        expect(result.strippedIdentity).toBe(true);
        expect(result.deidentifiedQuestion).not.toContain('李四');
        expect(result.items).toHaveLength(1);
        expect(result.items[0].status).toBe('verified');
        expect(result.items[0].verification?.passed).toBe(true);
        expect(result.items[0].resolveAgreed).toBe(true);
        expect(result.usage.totalTokens).toBeGreaterThan(0);
    });

    it('验算不一致时进入待审核，绝不自动通过', async () => {
        const result = await runVariantPipeline({
            originalQuestion: '计算 1+1',
            knowledgePoints: ['有理数'],
            targetDifficulty: 'easy',
            language: 'zh',
        }, ai({
            generate: vi.fn(async () => ({ data: {
                questionText: '计算 2+3', answerText: '10', analysis: '错的',
                knowledgePoints: ['有理数'], computable: { type: 'expression', expression: '2+3', expected: '10' },
            } })),
        }));
        expect(result.items[0].status).toBe('pending_review');
        expect(result.items[0].verification?.passed).toBe(false);
    });

    it('无法验算的题目进入待审核', async () => {
        const result = await runVariantPipeline({
            originalQuestion: '简述光合作用',
            knowledgePoints: ['生物'],
            targetDifficulty: 'medium',
            language: 'zh',
        }, ai({
            generate: vi.fn(async () => ({ data: {
                questionText: '请简述光合作用的意义', answerText: '把光能转化为化学能', analysis: '略',
                knowledgePoints: ['生物'],
            } })),
            resolve: vi.fn(async () => ({ data: { answer: '把光能转化为化学能' } })),
        }));
        expect(result.items[0].status).toBe('pending_review');
        expect(result.items[0].verification?.computable).toBe(false);
    });

    it('与原题过近时重生成，仍过近则拒绝', async () => {
        const generate = vi.fn(async () => ({ data: {
            questionText: '解方程 2x+1=7', answerText: '3', analysis: '移项',
            knowledgePoints: ['方程'], computable: { type: 'equation', expression: '2*x+1=7', expected: '3' },
        } }));
        const result = await runVariantPipeline({
            originalQuestion: '解方程 2x+1=7',
            knowledgePoints: ['方程'],
            targetDifficulty: 'medium',
            language: 'zh',
        }, ai({ generate }), { maxRetries: 1 });
        expect(generate).toHaveBeenCalledTimes(2);
        expect(result.items[0].status).toBe('rejected');
        expect(result.items[0].similarTo).toContain('original');
    });

    it('用尽调用预算后不再请求 AI，并把题目交给审核', async () => {
        const impl = ai();
        const result = await runVariantPipeline({
            originalQuestion: '解方程 x=1',
            knowledgePoints: ['方程'],
            targetDifficulty: 'easy',
            language: 'zh',
            count: 2,
        }, impl, { maxCalls: 1, maxRetries: 0 });
        expect(result.budgetExhausted).toBe(true);
        expect(impl.plan).toHaveBeenCalledTimes(1);
        expect(impl.generate).not.toHaveBeenCalled();
        expect(result.items.every((item) => item.status === 'pending_review')).toBe(true);
    });
});
