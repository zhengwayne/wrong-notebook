import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, internalError, validationError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getOnboardingStatus, setOnboardingDismissed } from "@/lib/onboarding";
import { isPersona, parsePersonas, type Persona } from "@/lib/personas";
import { prisma } from "@/lib/prisma";
import { defineApiRoute } from "@/lib/server/api-route";

const logger = createLogger("api:onboarding");

function resolvePersona(requested: string | null | undefined, user: { personas?: string | null; activePersona?: string | null }): Persona {
    if (isPersona(requested)) return requested;
    if (isPersona(user.activePersona)) return user.activePersona;
    return parsePersonas(user.personas ?? "[]")[0] ?? "self";
}

/** 当前身份的新手引导进度（按真实数据） */
export const GET = defineApiRoute({ auth: "user" }, async (req, { user }) => {
    try {
        const url = new URL(req.url);
        const persona = resolvePersona(url.searchParams.get("persona"), user);
        return NextResponse.json(await getOnboardingStatus(prisma, user.id, persona));
    } catch (error) {
        logger.error({ error }, "Failed to load onboarding");
        return internalError("Failed to load onboarding");
    }
});

const bodySchema = z.object({
    persona: z.string().optional(),
    action: z.enum(["dismiss", "reopen"]),
});

/** 收起 / 重新打开 */
export const POST = defineApiRoute({ auth: "user" }, async (req, { user }) => {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return badRequest("Invalid JSON body");
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) return validationError("Invalid onboarding action", parsed.error.flatten());
    try {
        const persona = resolvePersona(parsed.data.persona, user);
        await setOnboardingDismissed(prisma, user.id, persona, parsed.data.action === "dismiss");
        return NextResponse.json(await getOnboardingStatus(prisma, user.id, persona));
    } catch (error) {
        logger.error({ error }, "Failed to update onboarding");
        return internalError("Failed to update onboarding");
    }
});
