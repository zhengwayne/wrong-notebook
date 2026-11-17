import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { learningScopeWhere, type LearningScope } from '@/lib/learning-scope';
import { DEFAULT_QUESTION_DUPLICATE_THRESHOLD, duplicateQuestionSimilarity } from '@/lib/question-similarity';
import { translations } from '@/lib/translations';

export interface ImportedQuestionContent {
    questionText?: string | null;
    ocrText?: string | null;
    answerText?: string | null;
    analysis?: string | null;
    wrongAnswerText?: string | null;
    mistakeAnalysis?: string | null;
    originalImageUrl?: string | null;
}

interface DuplicateQuestion {
    id: string;
    similarity: number;
}

/** 分页比较同一学习者作用域下的题库；允许同一学习者跨错题本判重，但不跨孩子/学习者混淆。 */
export async function findDuplicateQuestion(
    client: Prisma.TransactionClient,
    scope: LearningScope,
    content: ImportedQuestionContent,
): Promise<DuplicateQuestion | null> {
    const text = content.questionText?.trim() || content.ocrText?.trim();
    if (!text) return null;
    const user = await client.user.findUnique({ where: { id: scope.userId }, select: { questionDuplicateThreshold: true } });
    const threshold = user?.questionDuplicateThreshold ?? DEFAULT_QUESTION_DUPLICATE_THRESHOLD;
    if (threshold >= 100) return null;

    const scopeWhere = learningScopeWhere(scope);
    const pageSize = 200;
    let cursor: string | undefined;
    let bestMatch: DuplicateQuestion | null = null;
    while (true) {
        const candidates = await client.errorItem.findMany({
            where: scopeWhere,
            select: { id: true, questionText: true, ocrText: true },
            orderBy: { id: 'asc' },
            take: pageSize,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        for (const candidate of candidates) {
            const candidateText = candidate.questionText?.trim() || candidate.ocrText?.trim();
            if (!candidateText) continue;
            const similarity = duplicateQuestionSimilarity(text, candidateText, threshold);
            if (similarity !== null && (!bestMatch || similarity > bestMatch.similarity)) {
                bestMatch = { id: candidate.id, similarity };
                if (similarity === 1) return bestMatch;
            }
        }
        if (candidates.length < pageSize) return bestMatch;
        cursor = candidates[candidates.length - 1].id;
    }
}

/** 与判重处于同一事务内，保存本次做错快照并写入同一学习者 ID，原题内容和历史记录均保留。 */
export async function recordDuplicateQuestion(
    client: Prisma.TransactionClient,
    scope: LearningScope,
    duplicate: DuplicateQuestion,
    content: ImportedQuestionContent,
) {
    const existing = await client.errorItem.findFirstOrThrow({
        where: { id: duplicate.id, ...learningScopeWhere(scope) },
        include: { tags: true, subject: { select: { id: true, name: true } } },
    });
    const record = await client.practiceRecord.create({
        data: {
            userId: scope.userId,
            learnerId: scope.learnerId,
            errorItemId: existing.id,
            subject: existing.subject?.name ?? null,
            result: 'wrong',
            isCorrect: false,
            source: 'duplicate_import',
            questionText: content.questionText?.trim() || content.ocrText?.trim() || existing.questionText,
            answerText: content.answerText || null,
            analysis: content.analysis || null,
            wrongAnswerText: content.wrongAnswerText || null,
            mistakeAnalysis: content.mistakeAnalysis || null,
            originalImageUrl: content.originalImageUrl || null,
        },
    });
    return {
        ...existing,
        duplicate: true as const,
        similarity: duplicate.similarity,
        mistakeRecorded: true as const,
        practiceRecordId: record.id,
        message: translations.zh.importFlow.duplicate,
    };
}

// 进程内导入事务队列：SQLite 同一时刻只允许一个写事务，先读后写的并发事务在慢机器上会互相等待写锁直到超时
let importQueue: Promise<unknown> = Promise.resolve();

function isRetryableWriteConflict(error: unknown): boolean {
    const code = (error as { code?: string })?.code;
    const message = error instanceof Error ? error.message : String(error);
    return code === 'P2034' || code === 'P1008' || /database is locked|SQLITE_BUSY/i.test(message);
}

async function runWithRetry<T>(operation: (client: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await prisma.$transaction(operation, { maxWait: 10000, timeout: 30000 });
        } catch (error) {
            if (attempt >= 2 || !isRetryableWriteConflict(error)) throw error;
        }
    }
}

/** 判重与写入一起提交，并在进程内串行执行，避免同时导入的相同题目都判为新题或互相锁等待。 */
export function runQuestionImportTransaction<T>(operation: (client: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const run = importQueue.then(() => runWithRetry(operation));
    importQueue = run.catch(() => undefined);
    return run;
}
