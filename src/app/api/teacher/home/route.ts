import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized } from "@/lib/api-errors";
import { getTeacherHome } from "@/lib/teacher-home";

/** GET /api/teacher/home?classId= 老师首页：班级收卷情况与按班筛选的统计 */
export async function GET(req: Request) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const classId = new URL(req.url).searchParams.get("classId");
    const data = await getTeacherHome(user.id, classId);
    return NextResponse.json(data);
}
