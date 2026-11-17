import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, notFound, validationError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { PRACTICE_RESULTS, scheduleMasteryEvaluation } from "@/lib/mastery";
import { MAX_FIGURE_SVG_LENGTH, sanitizeFigureSvg } from "@/lib/figure-svg";
import { LearnerNotFoundError } from "@/lib/learners";
import { resolveLearningScope } from "@/lib/learning-scope";
import { syncItemMemory } from "@/lib/due-items";
import { scheduleLearningPathReplan } from "@/lib/learning-path/service";

const logger = createLogger('api:practice:record');

const recordSchema = z.object({
    errorItemId: z.string().min(1).optional(),
    learnerId: z.string().min(1).max(64).nullish(),
    result: z.enum(PRACTICE_RESULTS as [string, ...string[]]).optional(),
    isCorrect: z.boolean().nullable().optional(),
    subject: z.string().max(50).nullable().optional(),
    difficulty: z.string().max(20).nullable().optional(),
    questionText: z.string().max(20000).nullable().optional(),
    answerText: z.string().max(20000).nullable().optional(),
    analysis: z.string().max(50000).nullable().optional(),
    figureSvg: z.string().max(MAX_FIGURE_SVG_LENGTH).nullable().optional(),
    // manual：在错题详情中直接录入结果，不附带新题
    source: z.enum(['practice', 'manual']).optional(),
    takenAt: z.string().datetime({ offset: true }).optional(),
});

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    try {
        const parsed = recordSchema.safeParse(await req.json());
        if (!parsed.success) {
            return validationError("Invalid practice record", parsed.error.issues);
        }
        const { errorItemId, difficulty, questionText, answerText, analysis } = parsed.data;
        let subject = parsed.data.subject;
        const source = parsed.data.source ?? 'practice';
        const figureSvg = sanitizeFigureSvg(parsed.data.figureSvg);
        // 兼容旧客户端只传 isCorrect 的情况
        const result = parsed.data.result
            ?? (parsed.data.isCorrect === true ? 'correct' : parsed.data.isCorrect === false ? 'wrong' : undefined);

        const userId = session.user.id;

        let requestedScope: { userId: string; learnerId: string | null } | undefined;
        if (parsed.data.learnerId !== undefined && parsed.data.learnerId !== null) {
            try {
                requestedScope = await resolveLearningScope(prisma, userId, parsed.data.learnerId);
            } catch (error) {
                if (error instanceof LearnerNotFoundError) {
                    return notFound("Learner not found");
                }
                throw error;
            }
        }

        let resolvedLearnerId: string | null = requestedScope ? requestedScope.learnerId : null;

        // 关联原题时校验归属，防止写入他人的错题或混淆学习者作用域
        if (errorItemId) {
            const item = await prisma.errorItem.findUnique({
                where: { id: errorItemId },
                select: { userId: true, learnerId: true, subject: { select: { name: true } } },
            });
            if (!item || item.userId !== userId) {
                return notFound("Item not found");
            }
            const itemLearnerId = item.learnerId ?? null;
            if (requestedScope && itemLearnerId !== requestedScope.learnerId) {
                return notFound("Item not found");
            }
            resolvedLearnerId = requestedScope ? requestedScope.learnerId : itemLearnerId;
            subject ??= item.subject?.name ?? null;
        }

        const isCorrect = result ? result === 'correct' : parsed.data.isCorrect;

        const record = await prisma.practiceRecord.create({
            data: {
                userId,
                ...(resolvedLearnerId ? { learnerId: resolvedLearnerId } : {}),
                subject,
                difficulty,
                isCorrect,
                ...(errorItemId ? {
                    errorItemId,
                    result,
                    questionText,
                    answerText,
                    analysis,
                    figureSvg,
                    source,
                } : {}),
                ...(parsed.data.takenAt ? { createdAt: new Date(parsed.data.takenAt) } : {}),
            },
        });

        if (errorItemId && result) {
            await syncItemMemory(prisma, errorItemId);
            scheduleMasteryEvaluation([errorItemId]);
            scheduleLearningPathReplan(userId, 'zh', resolvedLearnerId);
        }

        return NextResponse.json(record);
    } catch (error) {
        logger.error({ error }, 'Error saving practice record');
        return internalError("Failed to save record");
    }
}
