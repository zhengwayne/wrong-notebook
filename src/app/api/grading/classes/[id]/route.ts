import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { notFound, unauthorized, validationError } from "@/lib/api-errors";
import { parseRoster } from "@/lib/grading";

const updateSchema = z.object({
    name: z.string().trim().min(1).max(100).optional(),
    roster: z.string().max(20000).optional(),
});

type Params = { params: Promise<{ id: string }> };

/** PUT /api/grading/classes/:id：改名或同步花名册（保留已有学生及其答卷，移除不在名单中的学生） */
export async function PUT(req: Request, { params }: Params) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const parsed = updateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return validationError("Invalid class", parsed.error.issues);

    const existing = await prisma.gradingClass.findFirst({ where: { id, userId: user.id }, include: { students: true } });
    if (!existing) return notFound("Class not found");

    await prisma.$transaction(async (tx) => {
        if (parsed.data.name) await tx.gradingClass.update({ where: { id }, data: { name: parsed.data.name } });
        if (parsed.data.roster !== undefined) {
            const names = parseRoster(parsed.data.roster);
            const byName = new Map(existing.students.map((student) => [student.name, student]));
            const removed = existing.students.filter((student) => !names.includes(student.name)).map((student) => student.id);
            if (removed.length) await tx.gradingStudent.deleteMany({ where: { id: { in: removed } } });
            for (const [order, name] of names.entries()) {
                const student = byName.get(name);
                if (student) await tx.gradingStudent.update({ where: { id: student.id }, data: { order } });
                else await tx.gradingStudent.create({ data: { classId: id, name, order } });
            }
        }
    });

    const updated = await prisma.gradingClass.findUniqueOrThrow({
        where: { id },
        include: { students: { orderBy: { order: 'asc' }, select: { id: true, name: true } } },
    });
    return NextResponse.json({ id: updated.id, name: updated.name, students: updated.students });
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
