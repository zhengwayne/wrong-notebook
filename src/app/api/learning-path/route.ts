import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, kidModeRestricted, notFound } from "@/lib/api-errors";
import { suggestKnowledgeOrder } from "@/lib/learning-path/ai";
import { getOrReplanPath } from "@/lib/learning-path/service";
import { SELF_STUDENT_KEY } from "@/lib/learning-path/types";
import { prisma } from "@/lib/prisma";
import { defineApiRoute } from "@/lib/server/api-route";
import { getKidModeLearnerId } from "@/lib/server/request-context";

function languageOf(req: Request, fallback: "zh" | "en" = "zh"): "zh" | "en" {
    const url = new URL(req.url);
    const query = url.searchParams.get("language") || url.searchParams.get("lang");
    if (query === "en" || query === "zh") return query;
    const header = req.headers.get("accept-language") || "";
    return header.toLowerCase().startsWith("en") ? "en" : fallback;
}

const postPathSchema = z.object({
    action: z.enum(["replan", "suggest-order"]).optional(),
    studentKey: z.string().trim().max(64).optional(),
    language: z.enum(["zh", "en"]).optional(),
});

/** GET /api/learning-path?studentKey=&subjectId=&language= 获取学习路径（只读；缓存命中时不写库） */
export const GET = defineApiRoute({ auth: "user" }, async (req, { user }) => {
    const url = new URL(req.url);
    const kidLearnerId = getKidModeLearnerId();
    const studentKey = kidLearnerId || url.searchParams.get("studentKey") || SELF_STUDENT_KEY;
    const result = await getOrReplanPath(user.id, {
        studentKey,
        subjectId: url.searchParams.get("subjectId"),
        language: languageOf(req),
        force: false,
    });
    if (!result) return notFound("Student not found");
    return NextResponse.json({ ...result.path, replanned: result.replanned });
});

/** POST /api/learning-path  { action: "replan" | "suggest-order", studentKey?, language? } */
export const POST = defineApiRoute({ auth: "user", maxBodyBytes: 8192 }, async (req, { user }) => {
    if (getKidModeLearnerId()) {
        return kidModeRestricted();
    }
    const rawBody = await req.json().catch(() => ({}));
    const parsed = postPathSchema.safeParse(rawBody);
    if (!parsed.success) {
        return badRequest("Unknown action");
    }
    const body = parsed.data;
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

    const result = await getOrReplanPath(user.id, { studentKey, language, force: true });
    if (!result) return notFound("Student not found");
    return NextResponse.json({ ...result.path, replanned: true });
});
