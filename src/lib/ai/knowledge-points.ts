import { SUBJECT_DISPLAY_NAMES } from '@/lib/notebook-scope';
import { MAX_KNOWLEDGE_TAGS } from './schema';
import type { PromptOptions } from './prompts';

const SUBJECT_TAG_FIELDS = {
    [SUBJECT_DISPLAY_NAMES.math]: 'prefetchedMathTags',
    [SUBJECT_DISPLAY_NAMES.physics]: 'prefetchedPhysicsTags',
    [SUBJECT_DISPLAY_NAMES.chemistry]: 'prefetchedChemistryTags',
    [SUBJECT_DISPLAY_NAMES.biology]: 'prefetchedBiologyTags',
    [SUBJECT_DISPLAY_NAMES.english]: 'prefetchedEnglishTags',
    [SUBJECT_DISPLAY_NAMES.chinese]: 'prefetchedChineseTags',
    [SUBJECT_DISPLAY_NAMES.history]: 'prefetchedHistoryTags',
    [SUBJECT_DISPLAY_NAMES.geography]: 'prefetchedGeographyTags',
    [SUBJECT_DISPLAY_NAMES.politics]: 'prefetchedPoliticsTags',
} as const;

/** 有候选集合时只采用集合内的标签；未提供集合时仍去重并限制数量。 */
export function normalizeAiQuestionTags<T extends { knowledgePoints: string[]; subject?: string }>(question: T, options: PromptOptions): T {
    let allowedTags = options.candidateTags?.tags;
    if (!options.candidateTags) {
        const field = SUBJECT_TAG_FIELDS[question.subject as keyof typeof SUBJECT_TAG_FIELDS];
        if (field) {
            allowedTags = options[field];
        } else {
            const available = Object.values(SUBJECT_TAG_FIELDS).flatMap(key => options[key] ? [options[key]] : []);
            allowedTags = available.length ? available.flat() : undefined;
        }
    }
    const allowed = allowedTags ? new Set(allowedTags) : null;
    const knowledgePoints = [...new Set(question.knowledgePoints.map(tag => tag.trim()).filter(tag => tag && (!allowed || allowed.has(tag))))].slice(0, MAX_KNOWLEDGE_TAGS);
    return { ...question, knowledgePoints };
}
