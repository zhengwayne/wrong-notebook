import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { internalError, notFound, unauthorized, validationError } from "@/lib/api-errors";
import { consumeAiQuota } from "@/lib/ai-quota";
import { getAIService } from "@/lib/ai";
import { splitDataUrl } from "@/lib/ai/exam-paper-read";
import { createLogger } from "@/lib/logger";
import { imageDataUrlSchema, languageSchema } from "@/lib/grading-api";
import { loadTaskRoster, takenStudentIds } from "@/lib/grading-service";
import { hasIdentity, matchStudent } from "@/lib/student-match";

const logger = createLogger('api:grading:identify');

const schema = z.object({ image: imageDataUrlSchema, language: languageSchema });

/** POST /api/grading/tasks/:id/identify：拍照后立即读一页的卷头（班级、学号、姓名）并匹配花名册 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return validationError("Invalid image", parsed.error.issues);
    const task = await prisma.gradingTask.findFirst({ where: { id, userId: user.id }, select: { id: true, classId: true, extraClassIds: true, userId: true } });
    if (!task) return notFound("Grading task not found");
    const limited = await consumeAiQuota(user, 'grade');
    if (limited) return limited;

    try {
        const read = await getAIService().readExamPaper({ mode: 'identify', images: [splitDataUrl(parsed.data.image)], language: parsed.data.language });
        const identity = { className: read.className, studentNo: read.studentNo, name: read.studentName };
        if (!hasIdentity(identity)) return NextResponse.json({ identity, match: null, alreadySubmitted: false });
        const match = matchStudent(identity, await loadTaskRoster(task));
        const taken = match.studentId ? await takenStudentIds(id) : new Set<string>();
        return NextResponse.json({ identity, match, alreadySubmitted: !!match.studentId && taken.has(match.studentId) });
    } catch (error) {
        logger.error({ error, taskId: id }, '卷头识别失败');
        return internalError("Failed to read paper header");
    }
}
