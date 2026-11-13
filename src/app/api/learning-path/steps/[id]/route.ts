import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized, notFound, badRequest } from "@/lib/api-errors";
import { patchStep } from "@/lib/learning-path/service";

const ACTIONS = new Set(["lock", "unlock", "skip", "complete", "start", "move", "note", "attach_run"]);

/** PATCH /api/learning-path/steps/:id 锁定、完成、调序或批注某一步 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({})) as {
        action?: string;
        direction?: "up" | "down";
        teacherNote?: string | null;
        variantRunId?: string | null;
    };
    if (!body.action || !ACTIONS.has(body.action)) return badRequest("Invalid action");
    const path = await patchStep(user.id, id, {
        action: body.action as "lock" | "unlock" | "skip" | "complete" | "start" | "move" | "note" | "attach_run",
        direction: body.direction,
        teacherNote: body.teacherNote,
        variantRunId: body.variantRunId,
    });
    if (!path) return notFound("Step not found");
    return NextResponse.json(path);
}
