import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized, notFound, badRequest } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { listClassPaths } from "@/lib/learning-path/service";

/** GET /api/learning-path/class?classId=&language= 班级学习路径总览 */
export async function GET(req: Request) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const url = new URL(req.url);
    const language = url.searchParams.get("language") === "en" ? "en" : "zh";
    const classId = url.searchParams.get("classId");
    if (classId) {
        const data = await listClassPaths(user.id, classId, language);
        if (!data) return notFound("Class not found");
        return NextResponse.json(data);
    }
    const classes = await prisma.gradingClass.findMany({
        where: { userId: user.id },
        orderBy: { name: "asc" },
        select: { id: true, name: true, _count: { select: { students: true } } },
    });
    if (classes.length === 0) return NextResponse.json({ classes: [], classId: null });
    // 未指定班级时带上第一个班的路径总览，方便老师首页
    const first = await listClassPaths(user.id, classes[0].id, language);
    return NextResponse.json({ classes, ...first });
}

export async function POST() {
    return badRequest("Use GET");
}
