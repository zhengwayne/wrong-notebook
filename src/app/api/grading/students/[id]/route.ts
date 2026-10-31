import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { notFound, unauthorized } from "@/lib/api-errors";

/** DELETE /api/grading/students/:id：从名册中移除学生（其答卷变为未指定学生，已导入的错题保留） */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const result = await prisma.gradingStudent.deleteMany({ where: { id, class: { userId: user.id } } });
    if (result.count === 0) return notFound("Student not found");
    return NextResponse.json({ success: true });
}
