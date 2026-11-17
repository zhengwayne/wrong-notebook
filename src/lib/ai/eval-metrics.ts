/**
 * AI 离线评测核心指标计算、基线对比与 Markdown 报告生成（OPT-19）。
 */
import { answersEquivalent } from '../variant/verify';

export interface EvalCaseOutcome {
    id: string;
    task: 'verify' | 'analyze' | 'grading' | 'exam-read';
    subject?: string;
    expectedStem?: string;
    predictedStem?: string;
    expectedAnswer?: string;
    predictedAnswer?: string;
    expectedTags?: string[];
    predictedTags?: string[];
    expectedVerdict?: 'correct' | 'wrong' | 'partial';
    predictedVerdict?: 'correct' | 'wrong' | 'partial';
    passed?: boolean;
    jsonParseFailed?: boolean;
    latencyMs: number;
    cost?: number;
}

export interface EvalMetricsSummary {
    task: string;
    provider: string;
    model: string;
    totalCases: number;
    passRate: number;
    stemSimilarityAvg: number;
    answerMatchRate: number;
    tagPrecision: number;
    tagRecall: number;
    tagF1: number;
    perSubjectTagF1: Record<string, number>;
    gradingAccuracy: number;
    /** 错题被误判为对的比例（越低越好） */
    wrongMarkedCorrectRate: number;
    jsonParseFailureRate: number;
    p95LatencyMs: number;
    costPerItem: number;
}

export interface BaselineRegression {
    task: string;
    provider: string;
    metric: string;
    baseline: number;
    current: number;
    delta: number;
    message: string;
}

/** 计算两个字符串的 Levenshtein 编辑距离 */
export function levenshteinDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    const curr = new Array<number>(b.length + 1).fill(0);

    for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
    }
    return prev[b.length];
}

/** 归一化题干相似度（0~1，1 为完全一致） */
export function normalizedStemEditSimilarity(expected: string, actual: string): number {
    const left = expected.replace(/\s+/g, ' ').trim();
    const right = actual.replace(/\s+/g, ' ').trim();
    const maxLen = Math.max(left.length, right.length);
    if (maxLen === 0) return 1;
    return Math.max(0, 1 - levenshteinDistance(left, right) / maxLen);
}

/** 计算知识点标签 Precision / Recall / F1 */
export function computeTagMetrics(pairs: Array<{ expected: string[]; predicted: string[] }>): {
    precision: number;
    recall: number;
    f1: number;
} {
    let tp = 0;
    let fp = 0;
    let fn = 0;

    for (const pair of pairs) {
        const expSet = new Set(pair.expected.map((t) => t.trim().toLowerCase()).filter(Boolean));
        const predSet = new Set(pair.predicted.map((t) => t.trim().toLowerCase()).filter(Boolean));
        for (const p of predSet) {
            if (expSet.has(p)) tp += 1;
            else fp += 1;
        }
        for (const e of expSet) {
            if (!predSet.has(e)) fn += 1;
        }
    }

    if (tp === 0 && fp === 0 && fn === 0) return { precision: 1, recall: 1, f1: 1 };
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    return { precision, recall, f1 };
}

/** 计算分位数（默认 p95） */
export function computePercentile(values: number[], percentile: number = 95): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
    return sorted[idx];
}

function round4(num: number): number {
    return Math.round(num * 10000) / 10000;
}

/** 汇总单组 (task, provider, model) 的评测指标 */
export function evaluateTaskOutcomes(
    meta: { task: string; provider: string; model: string },
    outcomes: EvalCaseOutcome[],
): EvalMetricsSummary {
    const totalCases = outcomes.length;
    if (totalCases === 0) {
        return {
            ...meta,
            totalCases: 0,
            passRate: 0,
            stemSimilarityAvg: 0,
            answerMatchRate: 0,
            tagPrecision: 0,
            tagRecall: 0,
            tagF1: 0,
            perSubjectTagF1: {},
            gradingAccuracy: 0,
            wrongMarkedCorrectRate: 0,
            jsonParseFailureRate: 0,
            p95LatencyMs: 0,
            costPerItem: 0,
        };
    }

    const passItems = outcomes.filter((o) => typeof o.passed === 'boolean');
    const passRate = passItems.length > 0
        ? passItems.filter((o) => o.passed).length / passItems.length
        : 0;

    const stemItems = outcomes.filter((o) => o.expectedStem !== undefined && o.predictedStem !== undefined);
    const stemSimilarityAvg = stemItems.length > 0
        ? stemItems.reduce((sum, o) => sum + normalizedStemEditSimilarity(o.expectedStem!, o.predictedStem!), 0) / stemItems.length
        : 0;

    const ansItems = outcomes.filter((o) => o.expectedAnswer !== undefined && o.predictedAnswer !== undefined);
    const answerMatchRate = ansItems.length > 0
        ? ansItems.filter((o) => answersEquivalent(o.expectedAnswer!, o.predictedAnswer!)).length / ansItems.length
        : 0;

    const tagItems = outcomes.filter((o) => o.expectedTags !== undefined && o.predictedTags !== undefined);
    const overallTags = tagItems.length > 0
        ? computeTagMetrics(tagItems.map((o) => ({ expected: o.expectedTags!, predicted: o.predictedTags! })))
        : { precision: 0, recall: 0, f1: 0 };

    const bySubject = new Map<string, Array<{ expected: string[]; predicted: string[] }>>();
    for (const item of tagItems) {
        const subject = item.subject || '其他';
        const list = bySubject.get(subject) ?? [];
        list.push({ expected: item.expectedTags!, predicted: item.predictedTags! });
        bySubject.set(subject, list);
    }
    const perSubjectTagF1: Record<string, number> = {};
    for (const [subject, pairs] of bySubject.entries()) {
        perSubjectTagF1[subject] = round4(computeTagMetrics(pairs).f1);
    }

    const gradeItems = outcomes.filter((o) => o.expectedVerdict !== undefined && o.predictedVerdict !== undefined);
    const gradingAccuracy = gradeItems.length > 0
        ? gradeItems.filter((o) => o.expectedVerdict === o.predictedVerdict).length / gradeItems.length
        : 0;
    const wrongTruthItems = gradeItems.filter((o) => o.expectedVerdict === 'wrong' || o.expectedVerdict === 'partial');
    const wrongMarkedCorrectRate = wrongTruthItems.length > 0
        ? wrongTruthItems.filter((o) => o.predictedVerdict === 'correct').length / wrongTruthItems.length
        : 0;

    const jsonParseFailureRate = outcomes.filter((o) => o.jsonParseFailed).length / totalCases;
    const p95LatencyMs = Math.round(computePercentile(outcomes.map((o) => o.latencyMs), 95));
    const costPerItem = outcomes.reduce((sum, o) => sum + (o.cost ?? 0), 0) / totalCases;

    return {
        ...meta,
        totalCases,
        passRate: round4(passRate),
        stemSimilarityAvg: round4(stemSimilarityAvg),
        answerMatchRate: round4(answerMatchRate),
        tagPrecision: round4(overallTags.precision),
        tagRecall: round4(overallTags.recall),
        tagF1: round4(overallTags.f1),
        perSubjectTagF1,
        gradingAccuracy: round4(gradingAccuracy),
        wrongMarkedCorrectRate: round4(wrongMarkedCorrectRate),
        jsonParseFailureRate: round4(jsonParseFailureRate),
        p95LatencyMs,
        costPerItem: Math.round(costPerItem * 1_000_000) / 1_000_000,
    };
}

const HIGHER_IS_BETTER: Array<keyof Pick<
    EvalMetricsSummary,
    'passRate' | 'stemSimilarityAvg' | 'answerMatchRate' | 'tagF1' | 'gradingAccuracy'
>> = ['passRate', 'stemSimilarityAvg', 'answerMatchRate', 'tagF1', 'gradingAccuracy'];

const LOWER_IS_BETTER: Array<keyof Pick<
    EvalMetricsSummary,
    'wrongMarkedCorrectRate' | 'jsonParseFailureRate'
>> = ['wrongMarkedCorrectRate', 'jsonParseFailureRate'];

/** 与基线逐项比对，超过阈值（默认 2 个百分点）记录退化说明 */
export function compareWithBaseline(
    current: EvalMetricsSummary[],
    baseline: EvalMetricsSummary[],
    thresholdDrop: number = 0.02,
): BaselineRegression[] {
    const regressions: BaselineRegression[] = [];
    const baselineByTask = new Map<string, EvalMetricsSummary>();
    for (const entry of baseline) {
        baselineByTask.set(`${entry.task}::${entry.provider}`, entry);
        if (!baselineByTask.has(entry.task)) baselineByTask.set(entry.task, entry);
    }

    for (const row of current) {
        const ref = baselineByTask.get(`${row.task}::${row.provider}`) || baselineByTask.get(row.task);
        if (!ref) continue;

        for (const metric of HIGHER_IS_BETTER) {
            const curVal = row[metric];
            const baseVal = ref[metric];
            if (baseVal <= 0) continue;
            const delta = curVal - baseVal;
            if (delta < -thresholdDrop) {
                regressions.push({
                    task: row.task,
                    provider: row.provider,
                    metric,
                    baseline: baseVal,
                    current: curVal,
                    delta: round4(delta),
                    message: `[${row.task}/${row.provider}] ${metric} 下降 ${(Math.abs(delta) * 100).toFixed(2)}% (基线 ${(baseVal * 100).toFixed(2)}% -> 当前 ${(curVal * 100).toFixed(2)}%)`,
                });
            }
        }

        for (const metric of LOWER_IS_BETTER) {
            const curVal = row[metric];
            const baseVal = ref[metric];
            const delta = curVal - baseVal;
            if (delta > thresholdDrop) {
                regressions.push({
                    task: row.task,
                    provider: row.provider,
                    metric,
                    baseline: baseVal,
                    current: curVal,
                    delta: round4(delta),
                    message: `[${row.task}/${row.provider}] ${metric} 上升 ${(delta * 100).toFixed(2)}% (基线 ${(baseVal * 100).toFixed(2)}% -> 当前 ${(curVal * 100).toFixed(2)}%)`,
                });
            }
        }
    }

    return regressions;
}

/** 格式化为 Markdown 对比报告 */
export function formatEvalMarkdownReport(
    summaries: EvalMetricsSummary[],
    regressions: BaselineRegression[],
): string {
    const lines: string[] = [
        '# AI 离线评测报告',
        '',
        '| Task | Provider | Model | Cases | Pass | StemSim | AnsMatch | TagF1 | GradeAcc | Wrong->Right | ParseFail | p95(ms) | Cost/Item |',
        '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ];

    const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
    for (const s of summaries) {
        lines.push(
            `| ${s.task} | ${s.provider} | ${s.model} | ${s.totalCases} | ${pct(s.passRate)} | ${pct(s.stemSimilarityAvg)} | ${pct(s.answerMatchRate)} | ${pct(s.tagF1)} | ${pct(s.gradingAccuracy)} | ${pct(s.wrongMarkedCorrectRate)} | ${pct(s.jsonParseFailureRate)} | ${s.p95LatencyMs} | ${s.costPerItem.toFixed(4)} |`,
        );
    }

    lines.push('', '## 基线回归检查');
    if (regressions.length === 0) {
        lines.push('', '- 无超过阈值（2 个百分点）的核心指标退化。');
    } else {
        lines.push('');
        for (const reg of regressions) {
            lines.push(`- WARNING: ${reg.message}`);
        }
    }

    return lines.join('\n') + '\n';
}
