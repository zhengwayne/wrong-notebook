import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    compareWithBaseline,
    computePercentile,
    computeTagMetrics,
    evaluateTaskOutcomes,
    formatEvalMarkdownReport,
    normalizedStemEditSimilarity,
} from '@/lib/ai/eval-metrics';
import { runEvaluation } from '../../../eval/run-eval';

describe('eval-metrics 与离线评测工具（OPT-19）', () => {
    it('指定的基线文件缺失时提示读取失败', async () => {
        await expect(runEvaluation({
            tasks: ['verify'],
            providers: [{ provider: 'local', model: 'verify' }],
            baselinePath: resolve('eval/baselines/missing.json'),
        })).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('评测集各任务均包含 30 条合成样本，analyze 覆盖全部 9 科', () => {
        const analyze = JSON.parse(readFileSync(resolve(process.cwd(), 'eval/datasets/analyze/cases.json'), 'utf-8')) as {
            cases: Array<{ subject: string }>;
        };
        const grading = JSON.parse(readFileSync(resolve(process.cwd(), 'eval/datasets/grading/cases.json'), 'utf-8')) as {
            cases: unknown[];
        };
        const examRead = JSON.parse(readFileSync(resolve(process.cwd(), 'eval/datasets/exam-read/cases.json'), 'utf-8')) as {
            cases: unknown[];
        };

        expect(analyze.cases).toHaveLength(30);
        expect(grading.cases).toHaveLength(30);
        expect(examRead.cases).toHaveLength(30);

        const subjects = new Set(analyze.cases.map((c) => c.subject));
        for (const s of ['数学', '物理', '化学', '生物', '英语', '语文', '历史', '地理', '政治']) {
            expect(subjects.has(s)).toBe(true);
        }
    });

    it('准确计算题干相似度、标签 F1、p95 与把错题判成对的比例', () => {
        expect(normalizedStemEditSimilarity('解方程 2x=6', '解方程 2x=6')).toBe(1);
        expect(normalizedStemEditSimilarity('abc', 'abd')).toBeCloseTo(2 / 3, 2);

        const tags = computeTagMetrics([
            { expected: ['方程', '移项'], predicted: ['方程'] },
            { expected: ['勾股定理'], predicted: ['勾股定理'] },
        ]);
        expect(tags.precision).toBe(1);
        expect(tags.recall).toBeCloseTo(2 / 3, 2);
        expect(computePercentile([10, 20, 30, 40, 100], 95)).toBe(100);

        const summary = evaluateTaskOutcomes(
            { task: 'grading', provider: 'test', model: 'm1' },
            [
                { id: '1', task: 'grading', expectedVerdict: 'wrong', predictedVerdict: 'correct', passed: false, latencyMs: 100, cost: 0.002 },
                { id: '2', task: 'grading', expectedVerdict: 'wrong', predictedVerdict: 'wrong', passed: true, latencyMs: 200, cost: 0.002 },
                { id: '3', task: 'grading', expectedVerdict: 'correct', predictedVerdict: 'correct', passed: true, latencyMs: 300, cost: 0.002 },
            ],
        );
        expect(summary.gradingAccuracy).toBeCloseTo(2 / 3, 3);
        expect(summary.wrongMarkedCorrectRate).toBe(0.5);
        expect(summary.costPerItem).toBe(0.002);

        const baseline = { ...summary, passRate: 1 };
        const otherModel = { ...summary, model: 'previous', passRate: 0.5 };
        expect(compareWithBaseline([{ ...summary, passRate: 0.98 }], [baseline], 0.02)).toEqual([]);
        const regression = compareWithBaseline([{ ...summary, passRate: 0.9 }], [baseline, otherModel], 0.02);
        expect(regression).toContainEqual(expect.objectContaining({ metric: 'passRate', baseline: 1 }));
        expect(formatEvalMarkdownReport([baseline], [], 0.05)).toContain('5 个百分点');
    });

    it('支持至少两个提供商输出 Markdown 与 JSON 报告并与基线对比', async () => {
        const outDir = mkdtempSync(join(tmpdir(), 'eval-report-'));
        try {
            const report = await runEvaluation({
                tasks: ['verify', 'analyze', 'grading', 'exam-read'],
                providers: [
                    { provider: 'replay-a', model: 'vision-pro' },
                    { provider: 'replay-beta-degraded', model: 'vision-lite' },
                ],
                baselinePath: resolve(process.cwd(), 'eval/baselines/baseline-sample.json'),
                outputDir: outDir,
                thresholdDrop: 0.02,
            });

            expect(report.summaries).toHaveLength(8);
            const verifyRows = report.summaries.filter((s) => s.task === 'verify');
            expect(verifyRows.every((r) => r.passRate === 1)).toBe(true);
            const [standard, degraded] = report.summaries.filter((s) => s.task === 'analyze');
            expect(standard.tagF1).toBe(1);
            expect(degraded.tagF1).toBeLessThan(standard.tagF1);
            // replay-beta-degraded 故意制造退化，应触发 > 2 个百分点基线告警
            expect(report.regressions.length).toBeGreaterThan(0);
            expect(report.markdown).toContain('replay-a');
            expect(report.markdown).toContain('replay-beta-degraded');
            expect(readFileSync(join(outDir, 'eval-report.md'), 'utf-8')).toContain('WARNING:');

            const manualRegressions = compareWithBaseline(verifyRows, verifyRows, 0.02);
            expect(manualRegressions).toEqual([]);
            expect(formatEvalMarkdownReport(verifyRows, [])).toContain('无超过阈值');
        } finally {
            rmSync(outDir, { recursive: true, force: true });
        }
    });
});
