import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { badRequest, validationError, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { ChildLearnerLimitError } from "@/lib/learners";
import {
    defaultActivePersona,
    defaultPreselect,
    isPersona,
    parsePersonas,
    type Persona,
} from "@/lib/personas";
import { applyPersonaSelection, hasGradingClass, PersonaSelectionError } from "@/lib/persona-service";
import { defineApiRoute } from "@/lib/server/api-route";

const logger = createLogger("api:persona");

const bodySchema = z.object({
    personas: z.array(z.string()).optional(),
    activePersona: z.string().optional(),
    children: z.array(z.object({ name: z.string() })).optional(),
    confirm: z.boolean().optional(),
});

export const GET = defineApiRoute({ auth: 'user' }, async (_req, { user }) => {
    try {
        const hasClass = await hasGradingClass(prisma, user.id);
        const suggestedPreselect = defaultPreselect(hasClass);
        const personas = parsePersonas(user.personas);
        return NextResponse.json({
            personas,
            activePersona: isPersona(user.activePersona) ? user.activePersona : null,
            confirmed: Boolean(user.personasConfirmedAt),
            suggestedPreselect,
            hasGradingClass: hasClass,
        });
    } catch (error) {
        logger.error({ error }, "Failed to load personas");
        return internalError("Failed to load personas");
    }
});

export const POST = defineApiRoute({ auth: 'user' }, async (req, { user }) => {
    try {
        const body = bodySchema.parse(await req.json());
        const confirmed = Boolean(user.personasConfirmedAt);
        const shouldConfirm = !confirmed;
        const hasClass = await hasGradingClass(prisma, user.id);
        const preselect = defaultPreselect(hasClass);

        if (shouldConfirm && (!body.personas || body.personas.length === 0)) {
            return badRequest("Select at least one persona");
        }

        const personasInput = body.personas ?? parsePersonas(user.personas);
        const result = await prisma.$transaction((tx) =>
            applyPersonaSelection(tx, user.id, {
                personas: personasInput,
                activePersona: body.activePersona,
                preselect,
                children: confirmed ? undefined : body.children,
                confirm: shouldConfirm || body.confirm === true || confirmed,
            })
        );

        return NextResponse.json({
            personas: result.personas,
            activePersona: result.activePersona,
            confirmed: true,
        });
    } catch (error) {
        if (error instanceof z.ZodError) return validationError("Invalid input", error.issues);
        if (error instanceof PersonaSelectionError) return badRequest("Select at least one persona");
        if (error instanceof ChildLearnerLimitError) return badRequest("At most 3 children");
        logger.error({ error }, "Failed to update personas");
        return internalError("Failed to update personas");
    }
});

export const PATCH = defineApiRoute({ auth: 'user' }, async (req, { user }) => {
    try {
        if (!user.personasConfirmedAt) return badRequest("Confirm personas first");
        const body = bodySchema.parse(await req.json());
        const personas = parsePersonas(user.personas);
        if (!isPersona(body.activePersona) || !personas.includes(body.activePersona)) {
            return badRequest("Invalid active persona");
        }
        const activePersona: Persona = body.activePersona;
        await prisma.user.update({
            where: { id: user.id },
            data: { activePersona },
        });
        return NextResponse.json({
            personas,
            activePersona: defaultActivePersona(personas, activePersona),
            confirmed: true,
        });
    } catch (error) {
        if (error instanceof z.ZodError) return validationError("Invalid input", error.issues);
        logger.error({ error }, "Failed to switch persona");
        return internalError("Failed to switch persona");
    }
});
