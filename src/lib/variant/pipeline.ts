/**
 * 变式题分阶段流水线：规划 → 逐题生成 → 验算 + 独立重解 → 判重 → 难度复核。
 * 流程设计借鉴 DeepTutor v1.7.2 的「先规划、再逐题生成」，以 TypeScript 重新实现，不执行模型生成的代码。
 * 无法验算或结果不一致的题目进入人工审核，绝不自动通过。
 */
import { deidentifyQuestionText } from './deidentify';
import { checkVariantSimilarity, toDedupCandidates, type DedupCandidate } from './dedup';
import {
    variantDifficultyCheckSchema, variantPlanSchema, variantQuestionSchema, variantResolveSchema,
    type VariantDifficulty, type VariantPlan, type VariantPlanItem, type VariantQuestion,
} from './schemas';
import { answersEquivalent, verifyComputable, type VerifyEvidence } from './verify';

export const MAX_VARIANTS_PER_RUN = 8;
export const MAX_AI_CALLS_PER_RUN = 24;
export const MAX_GENERATE_RETRIES = 2;
export const AUTO_APPROVE_NEVER = true;

export interface TokenUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cost?: number;
}

export interface StageLog {
    stage: 'plan' | 'generate' | 'verify' | 'dedup' | 'difficulty' | 'resolve' | 'topic';
    status: 'ok' | 'failed' | 'skipped' | 'review';
    latencyMs: number;
    usage?: TokenUsage;
    detail?: Record<string, unknown>;
}

export interface PipelineInput {
    originalQuestion: string;
    knowledgePoints: string[];
    errorType?: string | null;
    targetDifficulty: VariantDifficulty;
    language: 'zh' | 'en';
    count?: number;
    previousQuestions?: Array<{ id: string; text: string }>;
    /** 个性化练习时预分配的每题规划（跳过或约束规划阶段） */
    plannedSlots?: Array<{ knowledgePoint: string; difficulty: VariantDifficulty; sourceItemId?: string; sourceQuestion?: string; errorType?: string | null }>;
}

export interface PipelineItemResult {
    index: number;
    status: 'verified' | 'pending_review' | 'rejected';
    plan: VariantPlanItem;
    question: VariantQuestion | null;
    verification: VerifyEvidence | null;
    resolveAnswer?: string;
    resolveAgreed?: boolean;
    similarity?: number | null;
    similarTo?: string | null;
    checkedDifficulty?: VariantDifficulty;
    difficultyConsistent?: boolean;
    sourceItemId?: string;
    logs: StageLog[];
    reason: string;
}

export interface PipelineResult {
    analysis: string;
    deidentifiedQuestion: string;
    strippedIdentity: boolean;
    items: PipelineItemResult[];
    logs: StageLog[];
    usage: TokenUsage;
    callCount: number;
    budgetExhausted: boolean;
}

export interface VariantAi {
    plan(input: { question: string; knowledgePoints: string[]; errorType?: string | null; difficulty: VariantDifficulty; count: number; language: 'zh' | 'en'; slots?: PipelineInput['plannedSlots'] }): Promise<{ data: unknown; usage?: TokenUsage }>;
    generate(input: { question: string; plan: VariantPlanItem; language: 'zh' | 'en'; previousStems: string[] }): Promise<{ data: unknown; usage?: TokenUsage }>;
    resolve(input: { questionText: string; language: 'zh' | 'en' }): Promise<{ data: unknown; usage?: TokenUsage }>;
    checkDifficulty(input: { questionText: string; target: VariantDifficulty; language: 'zh' | 'en' }): Promise<{ data: unknown; usage?: TokenUsage }>;
}

class Budget {
    used = 0;
    constructor(readonly max: number) {}
    get remaining() { return this.max - this.used; }
    take(): boolean {
        if (this.used >= this.max) return false;
        this.used += 1;
        return true;
    }
}

function addUsage(total: TokenUsage, usage?: TokenUsage): TokenUsage {
    if (!usage) return total;
    return {
        promptTokens: (total.promptTokens || 0) + (usage.promptTokens || 0) || undefined,
        completionTokens: (total.completionTokens || 0) + (usage.completionTokens || 0) || undefined,
        totalTokens: (total.totalTokens || 0) + (usage.totalTokens || (usage.promptTokens || 0) + (usage.completionTokens || 0)) || undefined,
        cost: (total.cost || 0) + (usage.cost || 0) || undefined,
    };
}

async function timed<T>(stage: StageLog['stage'], run: () => Promise<{ data: T; usage?: TokenUsage }>, status: StageLog['status'] = 'ok'): Promise<{ data: T; log: StageLog }> {
    const started = Date.now();
    try {
        const result = await run();
        return { data: result.data, log: { stage, status, latencyMs: Date.now() - started, usage: result.usage } };
    } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { stage, latencyMs: Date.now() - started });
    }
}

function fallbackPlan(input: PipelineInput, count: number): VariantPlan {
    if (input.plannedSlots && input.plannedSlots.length > 0) {
        return {
            analysis: '根据学情弱点预分配的变式计划',
            variants: input.plannedSlots.slice(0, count).map((slot, index) => ({
                index,
                vary: `针对「${slot.knowledgePoint}」更换数据或情境`,
                skill: slot.knowledgePoint,
                knowledgePoints: [slot.knowledgePoint],
                difficulty: slot.difficulty,
                errorTypeFocus: slot.errorType || undefined,
                sourceHint: slot.sourceItemId,
            })),
        };
    }
    return {
        analysis: '规划阶段不可用，按目标难度生成一组变式',
        variants: Array.from({ length: count }, (_, index) => ({
            index,
            vary: '更换数据与表述，保持核心考点',
            skill: input.knowledgePoints[0] || '原题考点',
            knowledgePoints: input.knowledgePoints,
            difficulty: input.targetDifficulty,
            errorTypeFocus: input.errorType || undefined,
        })),
    };
}

function finalizeStatus(item: Omit<PipelineItemResult, 'status' | 'reason'> & { reason?: string }): PipelineItemResult {
    if (item.similarTo && (item.similarity ?? 0) > 0) {
        return { ...item, status: 'rejected', reason: item.reason || '与原题或已有题目过于相似', question: item.question };
    }
    if (!item.question) {
        return { ...item, status: 'pending_review', reason: item.reason || '未能生成有效题目' };
    }
    const mathOk = item.verification?.computable && item.verification.passed;
    const resolveOk = item.resolveAgreed === true;
    const difficultyOk = item.difficultyConsistent !== false;
    if (mathOk && resolveOk && difficultyOk) {
        return { ...item, status: 'verified', reason: '符号或数值验算与独立重解一致，难度相符' };
    }
    const reasons: string[] = [];
    if (!item.verification?.computable) reasons.push('无法自动验算');
    else if (!item.verification.passed) reasons.push('验算结果与答案不一致');
    if (item.resolveAgreed === false) reasons.push('独立重解与给定答案不一致');
    if (item.resolveAgreed === undefined) reasons.push('未能完成独立重解');
    if (item.difficultyConsistent === false) reasons.push('难度与规划不符');
    return { ...item, status: 'pending_review', reason: reasons.join('；') || '待人工审核' };
}

/** 执行一轮变式生成。AI 与预算可注入，便于单测。 */
export async function runVariantPipeline(input: PipelineInput, ai: VariantAi, options: { maxCalls?: number; maxRetries?: number } = {}): Promise<PipelineResult> {
    const count = Math.max(1, Math.min(MAX_VARIANTS_PER_RUN, input.count ?? input.plannedSlots?.length ?? 1));
    const budget = new Budget(options.maxCalls ?? MAX_AI_CALLS_PER_RUN);
    const maxRetries = options.maxRetries ?? MAX_GENERATE_RETRIES;
    const logs: StageLog[] = [];
    let usage: TokenUsage = {};
    const { text: question, stripped } = deidentifyQuestionText(input.originalQuestion);

    let plan: VariantPlan = fallbackPlan(input, count);
    if (budget.take()) {
        try {
            const planned = await timed('plan', () => ai.plan({
                question, knowledgePoints: input.knowledgePoints, errorType: input.errorType,
                difficulty: input.targetDifficulty, count, language: input.language, slots: input.plannedSlots,
            }));
            logs.push(planned.log);
            usage = addUsage(usage, planned.log.usage);
            const parsed = variantPlanSchema.safeParse(planned.data);
            if (parsed.success && parsed.data.variants.length > 0) {
                plan = { ...parsed.data, variants: parsed.data.variants.slice(0, count) };
            } else {
                logs.push({ stage: 'plan', status: 'review', latencyMs: 0, detail: { reason: '规划结果未通过校验，已回退' } });
            }
        } catch (error) {
            logs.push({ stage: 'plan', status: 'failed', latencyMs: (error as { latencyMs?: number }).latencyMs || 0, detail: { error: error instanceof Error ? error.message : String(error) } });
        }
    } else {
        logs.push({ stage: 'plan', status: 'skipped', latencyMs: 0, detail: { reason: 'budget' } });
    }

    const items: PipelineItemResult[] = [];
    const batchStems: DedupCandidate[] = [];
    const previous = input.previousQuestions ?? [];

    for (const [index, planItem] of plan.variants.entries()) {
        const sourceQuestion = input.plannedSlots?.[index]?.sourceQuestion || question;
        const sourceItemId = input.plannedSlots?.[index]?.sourceItemId || planItem.sourceHint;
        const itemLogs: StageLog[] = [];
        let generated: VariantQuestion | null = null;
        let dedupSimilar: { similarity: number | null; similarTo: string | null } = { similarity: null, similarTo: null };
        let rejectedSimilar = false;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (!budget.take()) {
                itemLogs.push({ stage: 'generate', status: 'skipped', latencyMs: 0, detail: { reason: 'budget', attempt } });
                break;
            }
            try {
                const result = await timed('generate', () => ai.generate({
                    question: sourceQuestion, plan: { ...planItem, index }, language: input.language,
                    previousStems: [...previous.map((item) => item.text), ...batchStems.map((item) => item.text)],
                }));
                itemLogs.push({ ...result.log, detail: { attempt } });
                usage = addUsage(usage, result.log.usage);
                const parsed = variantQuestionSchema.safeParse(result.data);
                if (!parsed.success) {
                    itemLogs.push({ stage: 'generate', status: 'failed', latencyMs: 0, detail: { attempt, issues: parsed.error.issues.map((issue) => issue.message) } });
                    continue;
                }
                generated = parsed.data;
                const dedup = checkVariantSimilarity(generated.questionText, toDedupCandidates(
                    { id: sourceItemId || 'original', text: sourceQuestion },
                    previous,
                    batchStems,
                ));
                itemLogs.push({ stage: 'dedup', status: dedup.tooSimilar ? 'review' : 'ok', latencyMs: 0, detail: { ...dedup, attempt } });
                if (!dedup.tooSimilar) {
                    dedupSimilar = { similarity: dedup.similarity, similarTo: null };
                    break;
                }
                dedupSimilar = { similarity: dedup.similarity, similarTo: dedup.similarTo };
                generated = null;
                if (attempt === maxRetries) rejectedSimilar = true;
            } catch (error) {
                itemLogs.push({ stage: 'generate', status: 'failed', latencyMs: (error as { latencyMs?: number }).latencyMs || 0, detail: { attempt, error: error instanceof Error ? error.message : String(error) } });
            }
        }

        let verification: VerifyEvidence | null = null;
        let resolveAnswer: string | undefined;
        let resolveAgreed: boolean | undefined;
        let checkedDifficulty: VariantDifficulty | undefined;
        let difficultyConsistent: boolean | undefined;

        if (generated) {
            verification = verifyComputable(generated.computable, generated.answerText);
            itemLogs.push({ stage: 'verify', status: verification.computable && verification.passed ? 'ok' : 'review', latencyMs: 0, detail: { ...verification } });

            if (budget.take()) {
                try {
                    const resolved = await timed('resolve', () => ai.resolve({ questionText: generated!.questionText, language: input.language }));
                    itemLogs.push(resolved.log);
                    usage = addUsage(usage, resolved.log.usage);
                    const parsed = variantResolveSchema.safeParse(resolved.data);
                    if (parsed.success) {
                        resolveAnswer = parsed.data.answer;
                        resolveAgreed = answersEquivalent(generated.answerText, parsed.data.answer);
                        itemLogs.push({ stage: 'resolve', status: resolveAgreed ? 'ok' : 'review', latencyMs: 0, detail: { answer: resolveAnswer, agreed: resolveAgreed } });
                    } else {
                        itemLogs.push({ stage: 'resolve', status: 'failed', latencyMs: 0, detail: { issues: parsed.error.issues.map((issue) => issue.message) } });
                    }
                } catch (error) {
                    itemLogs.push({ stage: 'resolve', status: 'failed', latencyMs: (error as { latencyMs?: number }).latencyMs || 0, detail: { error: error instanceof Error ? error.message : String(error) } });
                }
            } else {
                itemLogs.push({ stage: 'resolve', status: 'skipped', latencyMs: 0, detail: { reason: 'budget' } });
            }

            if (budget.take()) {
                try {
                    const checked = await timed('difficulty', () => ai.checkDifficulty({ questionText: generated!.questionText, target: planItem.difficulty, language: input.language }));
                    itemLogs.push(checked.log);
                    usage = addUsage(usage, checked.log.usage);
                    const parsed = variantDifficultyCheckSchema.safeParse(checked.data);
                    if (parsed.success) {
                        checkedDifficulty = parsed.data.difficulty;
                        difficultyConsistent = parsed.data.consistent && parsed.data.difficulty === planItem.difficulty;
                    } else {
                        itemLogs.push({ stage: 'difficulty', status: 'failed', latencyMs: 0 });
                    }
                } catch (error) {
                    itemLogs.push({ stage: 'difficulty', status: 'failed', latencyMs: (error as { latencyMs?: number }).latencyMs || 0, detail: { error: error instanceof Error ? error.message : String(error) } });
                }
            } else {
                itemLogs.push({ stage: 'difficulty', status: 'skipped', latencyMs: 0, detail: { reason: 'budget' } });
            }

            batchStems.push({ id: `batch-${index}`, text: generated.questionText, kind: 'batch' });
        }

        const item = finalizeStatus({
            index,
            plan: { ...planItem, index },
            question: rejectedSimilar ? null : generated,
            verification,
            resolveAnswer,
            resolveAgreed,
            similarity: dedupSimilar.similarity,
            similarTo: rejectedSimilar ? dedupSimilar.similarTo : null,
            checkedDifficulty,
            difficultyConsistent,
            sourceItemId,
            logs: itemLogs,
            reason: rejectedSimilar ? '多次重生成后仍与已有题目过于相似' : undefined,
        });
        items.push(item);
    }

    return {
        analysis: plan.analysis,
        deidentifiedQuestion: question,
        strippedIdentity: stripped,
        items,
        logs,
        usage,
        callCount: budget.used,
        budgetExhausted: budget.remaining <= 0,
    };
}

export function emptyUsage(usage: TokenUsage): boolean {
    return !usage.promptTokens && !usage.completionTokens && !usage.totalTokens && !usage.cost;
}
