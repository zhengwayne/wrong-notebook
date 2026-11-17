import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized } from "@/lib/api-errors";
import { getParentHome } from "@/lib/parent-home";

/** GET /api/parent/home?learnerId=&language= 家长首页：当前孩子的薄弱点、今日任务与练习趋势 */
export async function GET(req: Request) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const url = new URL(req.url);
    const language = url.searchParams.get("language") === "en" ? "en" : "zh";
    const learnerId = url.searchParams.get("learnerId");
    const data = await getParentHome(user.id, learnerId, language);
    return NextResponse.json(data);
}
