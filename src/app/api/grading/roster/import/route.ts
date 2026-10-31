import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { badRequest, conflict, unauthorized, validationError } from "@/lib/api-errors";
import { MAX_ROSTER_ROWS, parseRosterTable, planRosterImport, splitTable } from "@/lib/roster-import";

const schema = z.object({
    /** 粘贴的表格文本或 CSV 文件内容 */
    text: z.string().max(500000).optional(),
    /** Excel 在浏览器中解析后的行 */
    rows: z.array(z.array(z.string().max(200)).max(30)).max(MAX_ROSTER_ROWS + 1).optional(),
    /** 表格中没有班级列时使用 */
    defaultClassName: z.string().trim().max(100).default(''),
    /** false 只返回预览；true 写入 */
    commit: z.boolean().default(false),
}).refine((value) => value.text !== undefined || value.rows !== undefined, { message: 'text or rows is required' });

/**
 * POST /api/grading/roster/import：导入学生名册（班级、学号、姓名），可一次导入多个班。
 * 先预览（新增、更新、不变、重复、错误），确认后写入；按 班级+学号 更新已有学生，不删除名册中已有的学生。
 */
export async function POST(req: Request) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return validationError("Invalid roster", parsed.error.issues);
    const { text, rows, defaultClassName, commit } = parsed.data;

    const table = rows ?? splitTable(text || '');
    const roster = parseRosterTable(table, defaultClassName);
    const classes = await prisma.gradingClass.findMany({
        where: { userId: user.id },
        include: { students: { select: { id: true, name: true, studentNo: true, classId: true, order: true } } },
    });
    const existing = classes.flatMap((item) => item.students.map((student) => ({ ...student, className: item.name })));
    const plan = planRosterImport(roster.rows, existing, classes.map((item) => item.name));
    const preview = { ...plan, errors: roster.errors, duplicates: roster.duplicates, hasHeader: roster.hasHeader };
    if (!commit) return NextResponse.json(preview);
    if (plan.rows.length === 0) return badRequest("No valid rows");

    try {
        await prisma.$transaction(async (tx) => {
            const classIds = new Map(classes.map((item) => [item.name, item.id]));
            const nextOrder = new Map(classes.map((item) => [item.id, Math.max(-1, ...item.students.map((student) => student.order)) + 1]));
            for (const name of plan.newClasses) {
                const created = await tx.gradingClass.create({ data: { userId: user.id, name }, select: { id: true } });
                classIds.set(name, created.id);
                nextOrder.set(created.id, 0);
            }
            for (const row of plan.rows) {
                if (row.action === 'unchanged') continue;
                if (row.action === 'update' && row.studentId) {
                    await tx.gradingStudent.update({ where: { id: row.studentId }, data: { name: row.name, ...(row.studentNo ? { studentNo: row.studentNo } : {}) } });
                    continue;
                }
                const classId = classIds.get(row.className)!;
                const order = nextOrder.get(classId) || 0;
                nextOrder.set(classId, order + 1);
                await tx.gradingStudent.create({ data: { classId, name: row.name, studentNo: row.studentNo, order } });
            }
        });
    } catch (error) {
        if ((error as { code?: string })?.code === 'P2002') return conflict("Duplicate student number in class");
        throw error;
    }
    return NextResponse.json({ ...preview, committed: true });
}
