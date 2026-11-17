/**
 * AI 离线评测运行器（OPT-19）：按 task × provider × model 运行，
 * 输出结构化 JSON、Markdown 对比表并与基线比较是否超过退化阈值。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    compareWithBaseline,
    evaluateTaskOutcomes,
    formatEvalMarkdownReport,
    type BaselineRegression,
    type EvalCaseOutcome,
    type EvalMetricsSummary,
} from '../src/lib/ai/eval-metrics';
import { extractJsonObject } from '../src/lib/ai/schema';
import { checkAnswers, verifyComputable } from '../src/lib/variant/verify';
import type { ComputableSpec } from '../src/lib/variant/schemas';

export type EvalTaskName = 'verify' | 'analyze' | 'grading' | 'exam-read';

export interface ProviderEvalSpec {
    provider: string;
    model: string;
    /** 离线/回放适配器参数，或自定义执行函数 */
    runCase?: (task: EvalTaskName, rawCase: Record<string, unknown>) => Promise<EvalCaseOutcome>;
}

export interface RunEvalOptions {
    tasks: EvalTaskName[];
    providers: ProviderEvalSpec[];
    datasetsDir?: string;
    baselinePath?: string | null;
    outputDir?: string | null;
    thresholdDrop?: number;
}

export interface RunEvalResult {
    generatedAt: string;
    summaries: EvalMetricsSummary[];
    regressions: BaselineRegression[];
    markdown: string;
}

interface GoldenVerifyFile {
    answerEquivalenceCases: Array<{ id: string; expected: string; actual: string; expectedStatus: 'passed' | 'failed' | 'unknown' }>;
    computableCases: Array<{ id: string; spec: ComputableSpec; answerText: string; expectedPassed: boolean; expectedComputable?: boolean }>;
    latexJsonCases: Array<{ id: string; raw: string; expectedSubstring?: string; targetField?: string; mustContainQ?: string[]; mustEqualA?: string }>;
}

function readJsonFile<T>(filePath: string): T {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
}

function runVerifySuite(datasetsDir: string, providerMeta: { provider: string; model: string }): EvalMetricsSummary {
    const file = readJsonFile<GoldenVerifyFile>(join(datasetsDir, 'verify', 'golden-cases.json'));
    const outcomes: EvalCaseOutcome[] = [];

    for (const c of file.answerEquivalenceCases) {
        const t0 = performance.now();
        const res = checkAnswers(c.expected, c.actual);
        const passed = res.status === c.expectedStatus;
        outcomes.push({
            id: c.id,
            task: 'verify',
            passed,
            expectedAnswer: c.expected,
            predictedAnswer: c.expectedStatus === 'passed' ? c.actual : c.expected,
            latencyMs: Math.max(1, Math.round(performance.now() - t0)),
            cost: 0,
        });
    }

    for (const c of file.computableCases) {
        const t0 = performance.now();
        const res = verifyComputable(c.spec, c.answerText);
        const computableOk = c.expectedComputable === undefined || res.computable === c.expectedComputable;
        const passed = res.passed === c.expectedPassed && computableOk;
        outcomes.push({
            id: c.id,
            task: 'verify',
            passed,
            latencyMs: Math.max(1, Math.round(performance.now() - t0)),
            cost: 0,
        });
    }

    for (const c of file.latexJsonCases) {
        const t0 = performance.now();
        let passed = false;
        let jsonParseFailed = false;
        try {
            const parsed = extractJsonObject(c.raw) as Record<string, string>;
            if (c.expectedSubstring && c.targetField) {
                passed = String(parsed[c.targetField] || '').includes(c.expectedSubstring);
            } else if (c.mustContainQ && c.mustEqualA !== undefined) {
                passed = c.mustContainQ.every((frag) => String(parsed.q || '').includes(frag)) && parsed.a === c.mustEqualA;
            }
        } catch {
            jsonParseFailed = true;
            passed = false;
        }
        outcomes.push({
            id: c.id,
            task: 'verify',
            passed,
            jsonParseFailed,
            latencyMs: Math.max(1, Math.round(performance.now() - t0)),
            cost: 0,
        });
    }

    return evaluateTaskOutcomes({ task: 'verify', provider: providerMeta.provider, model: providerMeta.model }, outcomes);
}

/** 确定性离线回放模型输出，用于在无外网/API Key 环境下验证对比管线与基线退化告警 */
async function deterministicReplayCase(
    task: Exclude<EvalTaskName, 'verify'>,
    spec: ProviderEvalSpec,
    rawCase: Record<string, unknown>,
): Promise<EvalCaseOutcome> {
    const id = String(rawCase.id || 'unknown');
    const isDegradedReplay = spec.provider.includes('degraded') || spec.provider.includes('beta');

    if (task === 'analyze') {
        const subject = String(rawCase.subject || '其他');
        const expectedStem = String(rawCase.questionText || '');
        const expectedAnswer = String(rawCase.answerText || '');
        const expectedTags = Array.isArray(rawCase.expectedTags) ? rawCase.expectedTags.map(String) : [];
        const indexNum = parseInt(id.replace(/\D/g, '') || '1', 10);
        // replay-b 模拟略低的标签命中率以展示多提供商对照差异
        const dropTag = isDegradedReplay && indexNum % 5 === 0;
        return {
            id,
            task,
            subject,
            expectedStem,
            predictedStem: expectedStem,
            expectedAnswer,
            predictedAnswer: expectedAnswer,
            expectedTags,
            predictedTags: dropTag ? [] : expectedTags,
            passed: !dropTag,
            latencyMs: isDegradedReplay ? 420 : 280,
            cost: isDegradedReplay ? 0.0012 : 0.0018,
        };
    }

    if (task === 'grading') {
        const expectedVerdict = String(rawCase.expectedVerdict || 'wrong') as 'correct' | 'wrong' | 'partial';
        const indexNum = parseInt(id.replace(/\D/g, '') || '1', 10);
        const predictedVerdict: 'correct' | 'wrong' | 'partial' = isDegradedReplay && indexNum % 10 === 0
            ? 'correct'
            : expectedVerdict;
        return {
            id,
            task,
            subject: String(rawCase.subject || '数学'),
            expectedVerdict,
            predictedVerdict,
            passed: predictedVerdict === expectedVerdict,
            latencyMs: isDegradedReplay ? 360 : 240,
            cost: 0.001,
        };
    }

    // exam-read
    const expectedStem = String(rawCase.questionText || '');
    const expectedAnswer = String(rawCase.correctAnswer || '');
    const expectedVerdict = rawCase.verdict ? String(rawCase.verdict) as 'correct' | 'wrong' | 'partial' : undefined;
    return {
        id,
        task,
        expectedStem,
        predictedStem: expectedStem,
        expectedAnswer,
        predictedAnswer: expectedAnswer,
        ...(expectedVerdict ? { expectedVerdict, predictedVerdict: expectedVerdict } : {}),
        passed: true,
        latencyMs: isDegradedReplay ? 480 : 310,
        cost: 0.002,
    };
}

/** 运行一组离线评测任务，返回汇总指标、基线退化列表与 Markdown 报告 */
export async function runEvaluation(options: RunEvalOptions): Promise<RunEvalResult> {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const datasetsDir = options.datasetsDir ?? join(repoRoot, 'eval', 'datasets');
    const summaries: EvalMetricsSummary[] = [];

    for (const providerSpec of options.providers) {
        for (const task of options.tasks) {
            if (task === 'verify') {
                summaries.push(runVerifySuite(datasetsDir, { provider: providerSpec.provider, model: providerSpec.model }));
                continue;
            }
            const datasetPath = join(datasetsDir, task, 'cases.json');
            const dataset = readJsonFile<{ cases: Array<Record<string, unknown>> }>(datasetPath);
            const outcomes: EvalCaseOutcome[] = [];
            for (const rawCase of dataset.cases) {
                const outcome = providerSpec.runCase
                    ? await providerSpec.runCase(task, rawCase)
                    : await deterministicReplayCase(task, providerSpec, rawCase);
                outcomes.push(outcome);
            }
            summaries.push(evaluateTaskOutcomes({ task, provider: providerSpec.provider, model: providerSpec.model }, outcomes));
        }
    }

    let baseline: EvalMetricsSummary[] = [];
    if (options.baselinePath && existsSync(options.baselinePath)) {
        baseline = readJsonFile<EvalMetricsSummary[]>(options.baselinePath);
    }
    const regressions = compareWithBaseline(summaries, baseline, options.thresholdDrop ?? 0.02);
    const markdown = formatEvalMarkdownReport(summaries, regressions);
    const result: RunEvalResult = {
        generatedAt: new Date().toISOString(),
        summaries,
        regressions,
        markdown,
    };

    if (options.outputDir) {
        mkdirSync(options.outputDir, { recursive: true });
        writeFileSync(join(options.outputDir, 'eval-report.json'), JSON.stringify(result, null, 2), 'utf-8');
        writeFileSync(join(options.outputDir, 'eval-report.md'), markdown, 'utf-8');
    }

    return result;
}

function parseCliArgs(argv: string[]): RunEvalOptions {
    let taskArg = 'all';
    let providerArg = 'replay-a,replay-b';
    let baselineArg: string | null = 'eval/baselines/baseline-sample.json';
    let outputArg: string | null = null;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--task' && argv[i + 1]) taskArg = argv[++i];
        else if (arg === '--provider' && argv[i + 1]) providerArg = argv[++i];
        else if (arg === '--baseline' && argv[i + 1]) baselineArg = argv[++i];
        else if (arg === '--output' && argv[i + 1]) outputArg = argv[++i];
    }

    const tasks: EvalTaskName[] = taskArg === 'all'
        ? ['verify', 'analyze', 'grading', 'exam-read']
        : (taskArg.split(',').map((s) => s.trim()).filter(Boolean) as EvalTaskName[]);

    const providers: ProviderEvalSpec[] = providerArg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((entry) => {
            const [provider, model] = entry.split(':');
            return { provider, model: model || `${provider}-model` };
        });

    return {
        tasks,
        providers,
        baselinePath: baselineArg,
        outputDir: outputArg,
    };
}

export async function runCli(argv: string[]): Promise<void> {
    const res = await runEvaluation(parseCliArgs(argv));
    process.stdout.write(res.markdown);
}

const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCli) {
    runCli(process.argv.slice(2))
        .then(() => {
            process.exit(0);
        })
        .catch((err) => {
            process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
            process.exit(1);
        });
}
