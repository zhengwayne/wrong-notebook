import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractJsonObject } from '@/lib/ai/schema';
import { checkAnswers, verifyComputable } from '@/lib/variant/verify';
import type { ComputableSpec } from '@/lib/variant/schemas';

interface GoldenDataset {
    answerEquivalenceCases: Array<{
        id: string;
        expected: string;
        actual: string;
        expectedStatus: 'passed' | 'failed' | 'unknown';
    }>;
    computableCases: Array<{
        id: string;
        spec: ComputableSpec;
        answerText: string;
        expectedPassed: boolean;
        expectedComputable?: boolean;
    }>;
    latexJsonCases: Array<{
        id: string;
        raw: string;
        expectedSubstring?: string;
        targetField?: string;
        mustContainQ?: string[];
        mustEqualA?: string;
    }>;
}

const datasetPath = resolve(process.cwd(), 'eval/datasets/verify/golden-cases.json');
const dataset = JSON.parse(readFileSync(datasetPath, 'utf-8')) as GoldenDataset;

describe('OPT-19 离线 verify 黄金用例集', () => {
    it('至少包含 35 条确定性黄金用例', () => {
        const total =
            dataset.answerEquivalenceCases.length
            + dataset.computableCases.length
            + dataset.latexJsonCases.length;
        expect(total).toBeGreaterThanOrEqual(35);
    });

    it.each(dataset.answerEquivalenceCases)('答案结构判等 [$id]', ({ expected, actual, expectedStatus }) => {
        const result = checkAnswers(expected, actual);
        expect(result.status).toBe(expectedStatus);
    });

    it.each(dataset.computableCases)('数学验算 [$id]', ({ spec, answerText, expectedPassed, expectedComputable }) => {
        const result = verifyComputable(spec, answerText);
        expect(result.passed).toBe(expectedPassed);
        if (expectedComputable !== undefined) {
            expect(result.computable).toBe(expectedComputable);
        }
    });

    it.each(dataset.latexJsonCases)('LaTeX JSON 修复 [$id]', ({ raw, expectedSubstring, targetField, mustContainQ, mustEqualA }) => {
        const parsed = extractJsonObject(raw) as Record<string, string>;
        if (expectedSubstring && targetField) {
            expect(parsed[targetField]).toContain(expectedSubstring);
        }
        if (mustContainQ && mustEqualA !== undefined) {
            for (const frag of mustContainQ) {
                expect(parsed.q).toContain(frag);
            }
            expect(parsed.a).toBe(mustEqualA);
        }
    });
});
