import type { VariantItem, VariantRun, VariantStageLog } from '@prisma/client';

function parseJson(value: string | null): unknown {
    if (!value) return null;
    try { return JSON.parse(value); } catch { return value; }
}

export function serializeItem(item: VariantItem & { stages?: VariantStageLog[] }) {
    return {
        id: item.id,
        runId: item.runId,
        index: item.index,
        status: item.status,
        plan: parseJson(item.plan),
        questionText: item.questionText,
        answerText: item.answerText,
        analysis: item.analysis,
        figureSvg: item.figureSvg,
        knowledgePoints: parseJson(item.knowledgePoints) || [],
        plannedDifficulty: item.plannedDifficulty,
        checkedDifficulty: item.checkedDifficulty,
        difficultyConsistent: item.difficultyConsistent,
        verification: parseJson(item.verification),
        similarity: item.similarity,
        similarTo: item.similarTo,
        sourceItemId: item.sourceItemId,
        practiceRecordId: item.practiceRecordId,
        examQuestionId: item.examQuestionId,
        reviewNote: item.reviewNote,
        reviewedAt: item.reviewedAt,
        createdAt: item.createdAt,
        stages: item.stages?.map(serializeStage),
    };
}

export function serializeStage(log: VariantStageLog) {
    return {
        id: log.id,
        stage: log.stage,
        status: log.status,
        latencyMs: log.latencyMs,
        promptTokens: log.promptTokens,
        completionTokens: log.completionTokens,
        totalTokens: log.totalTokens,
        cost: log.cost,
        detail: parseJson(log.detail),
        createdAt: log.createdAt,
    };
}

export function serializeRun(run: VariantRun & { items?: VariantItem[]; stages?: VariantStageLog[]; student?: { name: string; studentNo: string | null } | null; class?: { name: string } | null }) {
    return {
        id: run.id,
        kind: run.kind,
        mode: run.mode,
        status: run.status,
        language: run.language,
        targetDifficulty: run.targetDifficulty,
        requestedCount: run.requestedCount,
        title: run.title,
        errorItemId: run.errorItemId,
        studentId: run.studentId,
        studentName: run.student?.name,
        classId: run.classId,
        className: run.class?.name,
        subjectId: run.subjectId,
        examPaperId: run.examPaperId,
        weaknessProfile: parseJson(run.weaknessProfile),
        topicSuggestion: parseJson(run.topicSuggestion),
        totalLatencyMs: run.totalLatencyMs,
        promptTokens: run.promptTokens,
        completionTokens: run.completionTokens,
        totalTokens: run.totalTokens,
        cost: run.cost,
        error: run.error,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        items: run.items?.map(serializeItem),
        stages: run.stages?.map(serializeStage),
        counts: run.items ? {
            verified: run.items.filter((item) => item.status === 'verified').length,
            pending_review: run.items.filter((item) => item.status === 'pending_review').length,
            rejected: run.items.filter((item) => item.status === 'rejected').length,
            approved: run.items.filter((item) => item.status === 'approved').length,
        } : undefined,
    };
}
