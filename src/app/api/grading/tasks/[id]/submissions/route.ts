import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { badRequest, notFound, unauthorized, validationError } from "@/lib/api-errors";
import { consumeAiQuota } from "@/lib/ai-quota";
import { loadTaskRoster, resolveMatch, scheduleGrading, takenStudentIds } from "@/lib/grading-service";
import { identitySchema, imageDataUrlSchema, languageSchema, MAX_PAGES_PER_PAPER, MAX_PAPERS_PER_UPLOAD } from "@/lib/grading-api";
import { hasIdentity } from "@/lib/student-match";

const schema = z.object({
    papers: z.array(z.object({
        images: z.array(imageDataUrlSchema).min(1).max(MAX_PAGES_PER_PAPER),
        /** 老师手动指定的学生；自动匹配的结果由服务端按 identity 重新计算，不直接采信 */
        studentId: z.string().min(1).nullish(),
        identity: identitySchema.nullish(),
    })).min(1).max(MAX_PAPERS_PER_UPLOAD),
    language: languageSchema,
});

/** POST /api/grading/tasks/:id/submissions：上传一叠答卷（每份可多页），在后台依次 AI 判分 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return validationError("Invalid papers", parsed.error.issues);

    const task = await prisma.gradingTask.findFirst({
        where: { id, userId: user.id },
        include: { _count: { select: { questions: true } } },
    });
    if (!task) return notFound("Grading task not found");
    if (task._count.questions === 0) return badRequest("Answer key is empty");

    const roster = await loadTaskRoster(task);
    const studentIds = new Set(roster.map((student) => student.id));
    if (parsed.data.papers.some((paper) => paper.studentId && !studentIds.has(paper.studentId))) {
        return badRequest("Student not in class");
    }

    const taken = await takenStudentIds(id);
    const created: string[] = [];
    for (const paper of parsed.data.papers) {
        // 每份答卷计一次 AI 调用，超出每日额度时停止（已上传的照常判分）
        const limited = await consumeAiQuota(user, 'grade');
        if (limited) {
            if (created.length === 0) return limited;
            break;
        }
        let identityData = {};
        if (paper.studentId) {
            identityData = { studentId: paper.studentId, matchStatus: 'manual', matchReason: JSON.stringify({ code: 'manual' }) };
        } else if (paper.identity && hasIdentity(paper.identity)) {
            identityData = resolveMatch(paper.identity, roster, taken);
        }
        const assigned = (identityData as { studentId?: string | null }).studentId;
        if (assigned) taken.add(assigned);
        const submission = await prisma.gradingSubmission.create({
            data: { taskId: id, images: JSON.stringify(paper.images), ...identityData },
            select: { id: true },
        });
        created.push(submission.id);
    }
    scheduleGrading(created, parsed.data.language);
    return NextResponse.json({ ids: created, skipped: parsed.data.papers.length - created.length }, { status: 202 });
}
