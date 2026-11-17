/**
 * AI 产出结果溯源记录：基于 prompts.ts 自动计算提示词哈希，并在相同
 * (task, provider, model, promptVersion, parserVersion) 组合下复用同一条 AiProvenance 行。
 */
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getAppConfig } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import {
    FIGURE_SVG_RULES,
    LATEX_RULES,
    generateAnalyzePrompt,
    generateExamPaperReadPrompt,
    generateGradingPrompt,
    generateReanswerPrompt,
    generateVariantDifficultyPrompt,
    generateVariantPlanPrompt,
    generateVariantQuestionPrompt,
    generateVariantResolvePrompt,
} from './prompts';
import { getConfigForRole, type AiModelRole } from './roles';
import { isVendorProvider, resolveVendorConfig } from './vendor-presets';

const logger = createLogger('ai:provenance');

export type ProvenanceTask = 'analyze' | 'grade' | 'exam-read' | 'variant' | 'reanswer';

/** 各任务解析与结构校验器的逻辑版本；修改解析器时显式递增 */
export const PARSER_VERSIONS: Record<ProvenanceTask, string> = {
    analyze: 'v2-latex-sm',
    grade: 'v1',
    'exam-read': 'v1',
    variant: 'v2-structured-verify',
    reanswer: 'v1',
};

const promptVersionCache = new Map<ProvenanceTask, string>();

function normalizeForHash(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function buildCanonicalPromptText(task: ProvenanceTask): string {
    switch (task) {
        case 'analyze':
            return [
                generateAnalyzePrompt('zh', null, '数学', {
                    candidateTags: { subjectName: '数学', tags: ['__probe__'] },
                }),
                LATEX_RULES,
                FIGURE_SVG_RULES,
            ].join('\n');
        case 'grade':
            return generateGradingPrompt({
                questionText: '__probe__',
                answerText: '__probe__',
                userAnswer: '__probe__',
                language: 'zh',
            });
        case 'exam-read':
            return [
                generateExamPaperReadPrompt('parent_review', 'zh'),
                generateExamPaperReadPrompt('student', 'zh'),
                generateExamPaperReadPrompt('answer_key', 'zh'),
                generateExamPaperReadPrompt('identify', 'zh'),
            ].join('\n');
        case 'variant':
            return [
                generateVariantPlanPrompt('zh'),
                generateVariantQuestionPrompt('zh'),
                generateVariantResolvePrompt('zh'),
                generateVariantDifficultyPrompt('zh'),
            ].join('\n');
        case 'reanswer':
            return generateReanswerPrompt('zh', '__probe__', '数学', {
                candidateTags: { subjectName: '数学', tags: ['__probe__'] },
            });
    }
}

/** 获取对应任务提示词的 12 位 SHA-256 哈希指纹（自动随 prompts.ts 变化，无需人工维护） */
export function getPromptVersion(task: ProvenanceTask): string {
    const cached = promptVersionCache.get(task);
    if (cached) return cached;
    const hash = createHash('sha256')
        .update(normalizeForHash(buildCanonicalPromptText(task)))
        .digest('hex')
        .slice(0, 12);
    promptVersionCache.set(task, hash);
    return hash;
}

/** 读取当前生效角色的 AI 提供商与模型名称 */
export function resolveActiveProviderAndModel(role: AiModelRole): { provider: string; model: string } {
    const roleConfig = getConfigForRole(getAppConfig(), role);
    const provider = roleConfig.aiProvider || 'gemini';

    if (provider === 'openai') {
        const instances = roleConfig.openai?.instances || [];
        const activeId = roleConfig.openai?.activeInstanceId;
        const active = activeId ? instances.find((item) => item.id === activeId) : undefined;
        return { provider: 'openai', model: active?.model || 'default' };
    }
    if (provider === 'azure') {
        return { provider: 'azure', model: roleConfig.azure?.model || roleConfig.azure?.deploymentName || 'default' };
    }
    if (provider === 'anthropic') {
        return { provider: 'anthropic', model: roleConfig.anthropic?.model || 'default' };
    }
    if (provider === 'minimax-code') {
        return { provider: 'minimax-code', model: roleConfig.minimaxCode?.model || 'default' };
    }
    if (provider === 'gemini') {
        return { provider: 'gemini', model: roleConfig.gemini?.model || 'default' };
    }
    const vendor = isVendorProvider(provider) ? provider : 'minimax';
    const resolved = resolveVendorConfig(vendor, roleConfig[vendor]);
    return { provider: vendor, model: resolved.model || 'default' };
}

type ProvenanceClientLike = {
    aiProvenance?: {
        upsert?: PrismaClient['aiProvenance']['upsert'];
        findUnique?: PrismaClient['aiProvenance']['findUnique'];
    };
};

export interface RecordAiProvenanceOptions {
    task: ProvenanceTask;
    role: AiModelRole;
    providerOverride?: string;
    modelOverride?: string;
    parserVersionOverride?: string;
}

/**
 * 复用或写入 AiProvenance 记录，返回对应的 provenanceId。
 * 若传入的是未 mock aiProvenance 的局部测试客户端，安全返回 null。
 */
export async function recordAiProvenance(
    db: unknown,
    options: RecordAiProvenanceOptions,
): Promise<string | null> {
    const client = db as ProvenanceClientLike | null | undefined;
    const upsert = client?.aiProvenance?.upsert;
    if (typeof upsert !== 'function') return null;

    const active = resolveActiveProviderAndModel(options.role);
    const provider = (options.providerOverride || active.provider || 'unknown').slice(0, 64);
    const model = (options.modelOverride || active.model || 'default').slice(0, 128);
    const promptVersion = getPromptVersion(options.task);
    const parserVersion = options.parserVersionOverride || PARSER_VERSIONS[options.task];
    const key = {
        task: options.task,
        provider,
        model,
        promptVersion,
        parserVersion,
    };

    try {
        const row = await upsert({
            where: { task_provider_model_promptVersion_parserVersion: key },
            update: {},
            create: key,
            select: { id: true },
        });
        return row.id;
    } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code === 'P2002' && typeof client?.aiProvenance?.findUnique === 'function') {
            try {
                const existing = await client.aiProvenance.findUnique({
                    where: { task_provider_model_promptVersion_parserVersion: key },
                    select: { id: true },
                });
                if (existing?.id) return existing.id;
            } catch {
                // 回退查库失败仍由外层降级处理
            }
        }
        logger.warn({ error, task: options.task, provider, model }, '记录 AI 溯源信息失败，已跳过');
        return null;
    }
}
