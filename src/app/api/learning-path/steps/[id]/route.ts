import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, kidModeRestricted, notFound } from "@/lib/api-errors";
import { patchStep, StepPatchError } from "@/lib/learning-path/service";
import { defineApiRoute } from "@/lib/server/api-route";
import { getKidModeLearnerId } from "@/lib/server/request-context";

const patchStepSchema = z.object({
    action: z.enum(["lock", "unlock", "skip", "complete", "start", "move", "note", "attach_run"]),
    direction: z.enum(["up", "down"]).optional(),
    teacherNote: z.string().trim().max(500).nullable().optional(),
    variantRunId: z.string().trim().min(1).max(64).nullable().optional(),
});

/** PATCH /api/learning-path/steps/:id 锁定、完成、调序或批注某一步 */
export const PATCH = defineApiRoute<Request, { id: string }>(
    { auth: "user", maxBodyBytes: 8192 },
    async (req, { user, params }) => {
        const { id } = await params;
        const raw = await req.json().catch(() => null);
        const parsed = patchStepSchema.safeParse(raw);
        if (!parsed.success) {
            return badRequest("Invalid action");
        }

        const kidLearnerId = getKidModeLearnerId();
        if (kidLearnerId && parsed.data.action !== "start" && parsed.data.action !== "complete") {
            return kidModeRestricted();
        }

        try {
            const path = await patchStep(
                user.id,
                id,
                {
                    action: parsed.data.action,
                    direction: parsed.data.direction,
                    teacherNote: parsed.data.teacherNote,
                    variantRunId: parsed.data.variantRunId,
                },
                kidLearnerId ? { expectedStudentKey: kidLearnerId } : undefined,
            );
            if (!path) return notFound("Step not found");
            return NextResponse.json(path);
        } catch (error) {
            if (error instanceof StepPatchError) {
                if (error.code === "KID_MODE_RESTRICTED") return kidModeRestricted();
                if (error.code === "VARIANT_RUN_NOT_FOUND") return notFound("Variant run not found");
            }
            throw error;
        }
    },
);
