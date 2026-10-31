import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { conflict, internalError, unauthorized, validationError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { parseRoster } from "@/lib/grading";

const logger = createLogger('api:grading:classes');

const createSchema = z.object({
    name: z.string().trim().min(1).max(100),
    roster: z.string().max(20000).default(''),
});

/** GET /api/grading/classes：老师的班级与花名册 */
export async function GET() {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const classes = await prisma.gradingClass.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'asc' },
        include: { students: { orderBy: { order: 'asc' }, select: { id: true, name: true, studentNo: true } } },
    });
    return NextResponse.json(classes.map(({ id, name, students }) => ({ id, name, students })));
}

/** POST /api/grading/classes：新建班级，roster 为换行或逗号分隔的学生姓名（带学号的名册用导入接口） */
export async function POST(req: Request) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return validationError("Invalid class", parsed.error.issues);

    try {
        const names = parseRoster(parsed.data.roster);
        const created = await prisma.gradingClass.create({
            data: {
                userId: user.id,
                name: parsed.data.name,
                students: { create: names.map((name, order) => ({ name, order })) },
            },
            include: { students: { orderBy: { order: 'asc' }, select: { id: true, name: true, studentNo: true } } },
        });
        return NextResponse.json({ id: created.id, name: created.name, students: created.students }, { status: 201 });
    } catch (error) {
        if ((error as { code?: string })?.code === 'P2002') return conflict("Class name already exists");
        logger.error({ error }, '新建班级失败');
        return internalError("Failed to create class");
    }
}
