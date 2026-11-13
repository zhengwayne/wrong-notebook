import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized, notFound, badRequest } from "@/lib/api-errors";
import { getOrReplanPath } from "@/lib/learning-path/service";
import { suggestKnowledgeOrder } from "@/lib/learning-path/ai";
import { prisma } from "@/lib/prisma";
import { SELF_STUDENT_KEY } from "@/lib/learning-path/types";

function languageOf(req: Request, fallback: "zh" | "en" = "zh"): "zh" | "en" {
    const url = new URL(req.url);
    const query = url.searchParams.get("language") || url.searchParams.get("lang");
    if (query === "en" || query === "zh") return query;
    const header = req.headers.get("accept-language") || "";
    return header.toLowerCase().startsWith("en") ? "en" : fallback;
}

/** GET /api/learning-path?studentKey=&subjectId=&language= 获取或按最新证据自动重排路径 */
export async function GET(req: Request) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const url = new URL(req.url);
    const result = await getOrReplanPath(user.id, {
        studentKey: url.searchParams.get("studentKey") || SELF_STUDENT_KEY,
        subjectId: url.searchParams.get("subjectId"),
        language: languageOf(req),
        force: url.searchParams.get("replan") === "1",
    });
    if (!result) return notFound("Student not found");
    return NextResponse.json({ ...result.path, replanned: result.replanned });
}

/** POST /api/learning-path  { action: "replan" | "suggest-order", studentKey?, language? } */
export async function POST(req: Request) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const body = await req.json().catch(() => ({})) as { action?: string; studentKey?: string; language?: "zh" | "en" };
    const language = body.language === "en" ? "en" : "zh";
    const studentKey = body.studentKey || SELF_STUDENT_KEY;

    if (body.action === "suggest-order") {
        const current = await getOrReplanPath(user.id, { studentKey, language });
        if (!current) return notFound("Student not found");
        const pathRow = await prisma.learningPath.findUnique({ where: { id: current.path.id } });
        if (pathRow?.aiSuggestedAt && Date.now() - pathRow.aiSuggestedAt.getTime() < 24 * 60 * 60 * 1000 && pathRow.aiSuggestCount >= 1) {
            return NextResponse.json({ error: "AI_CAP", message: language === "en" ? "Today's AI ordering suggestion has been used." : "今日的 AI 顺序建议次数已用完。", path: current.path }, { status: 429 });
        }
        const points = current.path.mastery
            .filter((item) => item.score < 0.85)
            .sort((a, b) => a.score - b.score)
            .slice(0, 8)
            .map((item) => ({ knowledgePoint: item.knowledgePoint, mastery: item.score }));
        const suggestion = await suggestKnowledgeOrder(points, language);
        await prisma.learningPath.update({
            where: { id: current.path.id },
            data: { aiSuggestCount: { increment: 1 }, aiSuggestedAt: new Date() },
        });
        return NextResponse.json({ suggestion, path: current.path });
    }

    if (body.action && body.action !== "replan") return badRequest("Unknown action");
    const result = await getOrReplanPath(user.id, { studentKey, language, force: true });
    if (!result) return notFound("Student not found");
    return NextResponse.json({ ...result.path, replanned: true });
}
