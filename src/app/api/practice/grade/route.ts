import { NextResponse } from "next/server";
import { z } from "zod";
import { getAIService } from "@/lib/ai";
import { toConcurrencyErrorResponse } from "@/lib/ai/concurrency";
import { internalError, kidModeRestricted, notFound, validationError } from "@/lib/api-errors";
import { parseLastPractice } from "@/lib/last-practice";
import { createLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { reserveAiQuota, runWithAiQuota } from "@/lib/ai-quota";
import { withRecoverableResponse } from "@/lib/recoverable-response";
import { defineApiRoute, type AuthenticatedRouteContext } from "@/lib/server/api-route";
import { getKidModeLearnerId } from "@/lib/server/request-context";

const logger = createLogger('api:practice:grade');

const gradeSchema = z.object({
    errorItemId: z.string().min(1),
    userAnswer: z.string().trim().min(1).max(5000),
    language: z.enum(['zh', 'en']).optional(),
});

/**
 * POST /api/practice/grade
 * 由 AI 对照该错题最近一次生成的举一反三题目判定学生答案。
 * 题目和标准答案取自服务端暂存，不信任客户端传入的答案。
 */
async function handlePost(req: Request, { user }: AuthenticatedRouteContext) {
    try {
        const parsed = gradeSchema.safeParse(await req.json());
        if (!parsed.success) {
            return validationError("Invalid grading request", parsed.error.issues);
        }
        const { errorItemId, userAnswer, language } = parsed.data;

        const item = await prisma.errorItem.findUnique({
            where: { id: errorItemId },
            select: { userId: true, learnerId: true, lastPractice: true },
        });
        const kidLearnerId = getKidModeLearnerId();
        if (item && item.userId === user.id && kidLearnerId && (item.learnerId ?? null) !== kidLearnerId) {
            return kidModeRestricted();
        }
        const practice = item && item.userId === user.id ? parseLastPractice(item.lastPractice) : null;
        if (!practice) {
            return notFound("Practice question not found");
        }

        const quota = await reserveAiQuota(user, 'grade', { request: req });
        if (quota.limited) return quota.limited;

        const result = await runWithAiQuota(quota, () => getAIService('text').gradeAnswer({
            questionText: practice.questionText,
            answerText: practice.answerText,
            analysis: practice.analysis,
            userAnswer,
            language,
        }));
        return NextResponse.json(result);
    } catch (error) {
        const busy = toConcurrencyErrorResponse(error);
        if (busy) return busy;
        logger.error({ error }, 'Error grading answer');
        return internalError(error instanceof Error ? error.message : "Failed to grade answer");
    }
}

/** 耗时 AI 请求：浏览器中断连接后，前端可通过 /api/requests/:id 取回响应 */
export const POST = defineApiRoute({ auth: 'user' }, withRecoverableResponse(handlePost));
