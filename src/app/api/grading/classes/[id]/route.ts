import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { conflict, notFound, unauthorized, validationError } from "@/lib/api-errors";

const updateSchema = z.object({ name: z.string().trim().min(1).max(100) });

type Params = { params: Promise<{ id: string }> };

/** PUT /api/grading/classes/:id：班级改名（学生增改用名册导入，删除用学生接口） */
export async function PUT(req: Request, { params }: Params) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const parsed = updateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return validationError("Invalid class", parsed.error.issues);
    const existing = await prisma.gradingClass.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!existing) return notFound("Class not found");
    try {
        const updated = await prisma.gradingClass.update({
            where: { id },
            data: { name: parsed.data.name },
            include: { students: { orderBy: { order: 'asc' }, select: { id: true, name: true, studentNo: true } } },
        });
        return NextResponse.json({ id: updated.id, name: updated.name, students: updated.students });
    } catch (error) {
        if ((error as { code?: string })?.code === 'P2002') return conflict("Class name already exists");
        throw error;
    }
}

/** DELETE /api/grading/classes/:id：删除班级及其改卷任务（已导入的错题保留） */
export async function DELETE(_req: Request, { params }: Params) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const result = await prisma.gradingClass.deleteMany({ where: { id, userId: user.id } });
    if (result.count === 0) return notFound("Class not found");
    return NextResponse.json({ success: true });
}
