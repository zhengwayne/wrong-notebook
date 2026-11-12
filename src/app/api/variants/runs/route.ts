import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { badRequest, unauthorized, validationError, internalError, notFound } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { variantDifficultySchema } from "@/lib/variant/schemas";
import { QuotaError, startClassRuns, startItemPipeline, startPersonalizedRun } from "@/lib/variant/service";
import { serializeRun } from "@/lib/variant/serialize";

const logger = createLogger('api:variants:runs');

const postSchema = z.object({
    kind: z.enum(['practice', 'personalized_set', 'topic', 'class_topic']),
    language: z.enum(['zh', 'en']).default('zh'),
    difficulty: variantDifficultySchema.optional(),
    count: z.number().int().min(1).max(8).optional(),
    errorItemId: z.string().min(1).optional(),
    studentId: z.string().min(1).optional(),
    classId: z.string().min(1).optional(),
    subjectId: z.string().min(1).optional(),
    title: z.string().trim().max(80).optional(),
});

/** GET /api/variants/runs：当前老师的变式生成与审核队列 */
export async function GET(req: Request) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const url = new URL(req.url);
    const status = url.searchParams.get('status');
    const kind = url.searchParams.get('kind');
    const runs = await prisma.variantRun.findMany({
        where: {
            userId: user.id,
            ...(status ? { items: { some: { status } } } : {}),
            ...(kind ? { kind } : {}),
        },
        orderBy: { startedAt: 'desc' },
        take: 50,
        include: {
            items: { orderBy: { index: 'asc' } },
            student: { select: { name: true, studentNo: true } },
            class: { select: { name: true } },
        },
    });
    return NextResponse.json({ runs: runs.map(serializeRun) });
}

/** POST /api/variants/runs：按错题、学生或班级启动分阶段变式 / 专题生成 */
export async function POST(req: Request) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const parsed = postSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return validationError('Invalid variant request', parsed.error.issues);
    const body = parsed.data;
    try {
        if (body.kind === 'practice') {
            if (!body.errorItemId) return badRequest('errorItemId is required');
            const run = await startItemPipeline(user, body.errorItemId, body.language, body.difficulty ?? 'medium');
            if (!run) return notFound('Item not found');
            const saved = await prisma.variantRun.findFirst({ where: { id: run.id, userId: user.id }, include: { items: { orderBy: { index: 'asc' } } } });
            return NextResponse.json({ run: saved ? serializeRun(saved) : { id: run.id } }, { status: 201 });
        }
        if (body.kind === 'class_topic' || (body.kind === 'personalized_set' && body.classId && !body.studentId && !body.subjectId)) {
            if (!body.classId) return badRequest('classId is required');
            const result = await startClassRuns(user, { classId: body.classId, kind: body.kind === 'class_topic' ? 'class_topic' : 'personalized_set', language: body.language, count: body.count });
            if (!result) return notFound('Class not found');
            if ('error' in result && result.error) return NextResponse.json(result, { status: 400 });
            return NextResponse.json(result, { status: 201 });
        }
        const result = await startPersonalizedRun(user, {
            kind: body.kind === 'topic' ? 'topic' : 'personalized_set',
            language: body.language,
            count: body.count,
            studentId: body.studentId,
            subjectId: body.subjectId,
            title: body.title,
        });
        if (!result) return notFound('Student or notebook not found');
        if ('error' in result) return NextResponse.json(result, { status: 400 });
        return NextResponse.json({ runId: result.id }, { status: 202 });
    } catch (error) {
        if (error instanceof QuotaError) return new NextResponse(null, { status: error.status });
        logger.error({ error }, '启动变式流水线失败');
        return internalError('Failed to start variant pipeline');
    }
}
