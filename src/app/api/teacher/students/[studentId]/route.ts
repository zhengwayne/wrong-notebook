import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized, notFound } from "@/lib/api-errors";
import { getTeacherStudentProfile } from "@/lib/teacher-home";

/** GET /api/teacher/students/[studentId]?language= 学生档案：掌握、薄弱点、最近错题与今日路径 */
export async function GET(req: Request, { params }: { params: Promise<{ studentId: string }> }) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const { studentId } = await params;
    const language = new URL(req.url).searchParams.get("language") === "en" ? "en" : "zh";
    const data = await getTeacherStudentProfile(user.id, studentId, language);
    if (!data) return notFound("Student not found");
    return NextResponse.json(data);
}
