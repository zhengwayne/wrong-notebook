import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notFound, internalError, kidModeRestricted } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { describeQuestion, trackBackgroundTask } from "@/lib/background-tasks";
import { parseLastPractice } from "@/lib/last-practice";
import { consumeAiQuota } from "@/lib/ai-quota";
import { withRecoverableResponse } from "@/lib/recoverable-response";
import { startItemPipeline, startLegacyRun } from "@/lib/variant/service";
import { toConcurrencyErrorResponse } from "@/lib/ai/concurrency";
import { serializeRun } from "@/lib/variant/serialize";
import { defineApiRoute, type AuthenticatedRouteContext } from "@/lib/server/api-route";
import { getKidModeLearnerId } from "@/lib/server/request-context";

const logger = createLogger('api:practice:generate');

const DIFFICULTIES = ['easy', 'medium', 'hard', 'harder'] as const;

/**
 * GET /api/practice/generate?errorItemId=xxx
 * 读取该错题最近一次生成的举一反三题目，没有时返回 { practice: null }
 */
export const GET = defineApiRoute({ auth: 'user' }, async (req, { user }) => {
    try {
        const errorItemId = new URL(req.url).searchParams.get("errorItemId");
        if (!errorItemId) {
            return notFound("Item not found");
        }

        const item = await prisma.errorItem.findUnique({
            where: { id: errorItemId },
            select: { userId: true, learnerId: true, lastPractice: true }
        });
        if (!item || item.userId !== user.id) {
            return notFound("Item not found");
        }
        const kidLearnerId = getKidModeLearnerId();
        if (kidLearnerId && (item.learnerId ?? null) !== kidLearnerId) {
            return kidModeRestricted();
        }

        return NextResponse.json({ practice: parseLastPractice(item.lastPractice) });
    } catch (error) {
        logger.error({ error }, 'Error loading last practice');
        return internalError("Failed to load last practice question");
    }
});

async function handlePost(req: Request, { user }: AuthenticatedRouteContext) {
    try {
        const { errorItemId, language, difficulty } = await req.json();

        const errorItemWithSubject = await prisma.errorItem.findUnique({
            where: { id: errorItemId },
            include: { subject: true }
        });

        // 只能基于自己的错题生成，否则等于间接读取他人题目
        if (!errorItemWithSubject || errorItemWithSubject.userId !== user.id) {
            return notFound("Item not found");
        }
        const kidLearnerId = getKidModeLearnerId();
        if (kidLearnerId && (errorItemWithSubject.learnerId ?? null) !== kidLearnerId) {
            return kidModeRestricted();
        }

        let tags: string[] = [];
        try {
            tags = JSON.parse(errorItemWithSubject.knowledgePoints || "[]");
        } catch {
            tags = [];
        }

        const limited = await consumeAiQuota(user, 'practice');
        if (limited) return limited;

        const targetDifficulty = DIFFICULTIES.find(d => d === difficulty) ?? 'medium';

        // 默认走分阶段规划-验算-审核；设置中可切回原来的一次生成，便于对比
        if (user.variantPipelineEnabled !== false) {
            const started = await startItemPipeline(user, errorItemId, language || 'zh', targetDifficulty, { skipQuota: true });
            if (!started) return notFound("Item not found");
            const run = await prisma.variantRun.findFirst({ where: { id: started.id, userId: user.id }, include: { items: { orderBy: { index: 'asc' } } } });
            return NextResponse.json({ pipeline: true, run: run ? serializeRun(run) : { id: started.id } });
        }

        const generated = await trackBackgroundTask(
            { userId: user.id, kind: 'practice', subject: describeQuestion(errorItemWithSubject), link: `/error-items/${errorItemId}` },
            () => startLegacyRun({
                user,
                errorItemId,
                question: errorItemWithSubject.questionText || "",
                knowledgePoints: tags,
                language: language || 'zh',
                difficulty: targetDifficulty,
                gradeSemester: errorItemWithSubject.gradeSemester,
                figureSvg: errorItemWithSubject.figureSvg,
                subjectName: errorItemWithSubject.subject?.name || "其他",
            })
        );
        return NextResponse.json({ ...generated, pipeline: false });
    } catch (error) {
        const busy = toConcurrencyErrorResponse(error);
        if (busy) return busy;
        logger.error({ error }, 'Error generating practice');
        const errorMessage = error instanceof Error ? error.message : "Failed to generate practice question";
        return internalError(errorMessage);
    }
}

/** 耗时 AI 请求：浏览器中断连接后，前端可通过 /api/requests/:id 取回响应 */
export const POST = defineApiRoute({ auth: 'user' }, withRecoverableResponse(handlePost));
