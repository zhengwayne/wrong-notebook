import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized, notFound } from "@/lib/api-errors";
import { serializeRun } from "@/lib/variant/serialize";

/** GET /api/variants/runs/:id：一轮生成的题目、阶段日志与学情摘要 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const { id } = await params;
    const run = await prisma.variantRun.findFirst({
        where: { id, userId: user.id },
        include: {
            items: { orderBy: { index: 'asc' }, include: { stages: { orderBy: { createdAt: 'asc' } } } },
            stages: { orderBy: { createdAt: 'asc' } },
            student: { select: { name: true, studentNo: true } },
            class: { select: { name: true } },
        },
    });
    if (!run) return notFound('Run not found');
    return NextResponse.json({ run: serializeRun(run) });
}
