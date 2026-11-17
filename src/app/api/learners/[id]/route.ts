import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { forbidden, badRequest, validationError, internalError, notFound } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { deleteChildLearner, LearnerNotFoundError, updateChildLearner } from "@/lib/learners";
import { parsePersonas } from "@/lib/personas";
import { defineApiRoute } from "@/lib/server/api-route";

const logger = createLogger("api:learners");
const patchSchema = z.object({ name: z.string().min(1) });
const deleteSchema = z.object({
    deleteQuestions: z.boolean().optional(),
    confirmDeleteQuestions: z.boolean().optional(),
});

export const PATCH = defineApiRoute<Request, { id: string }>(
    { auth: 'user' },
    async (req, { user, params }) => {
        try {
            if (!parsePersonas(user.personas).includes("parent")) {
                return forbidden("Parent persona required");
            }
            const { id } = await params;
            const { name } = patchSchema.parse(await req.json());
            const child = await updateChildLearner(prisma, user.id, id, name);
            return NextResponse.json({ id: child.id, name: child.name });
        } catch (error) {
            if (error instanceof z.ZodError) return validationError("Invalid input", error.issues);
            if (error instanceof LearnerNotFoundError) return notFound("Child not found");
            if ((error as Error).message === "LEARNER_NAME_REQUIRED") return badRequest("Name is required");
            logger.error({ error }, "Failed to update child");
            return internalError("Failed to update child");
        }
    },
);

export const DELETE = defineApiRoute<Request, { id: string }>(
    { auth: 'user' },
    async (req, { user, params }) => {
        try {
            if (!parsePersonas(user.personas).includes("parent")) {
                return forbidden("Parent persona required");
            }
            const { id } = await params;
            let body: z.infer<typeof deleteSchema> = {};
            const text = await req.text();
            if (text.trim()) body = deleteSchema.parse(JSON.parse(text));
            const deleteQuestions = body.deleteQuestions === true;
            if (deleteQuestions && body.confirmDeleteQuestions !== true) {
                return badRequest("Deleting questions requires explicit confirmation");
            }
            const result = await deleteChildLearner(prisma, user.id, id, { deleteQuestions });
            return NextResponse.json({
                ok: true,
                archived: result.archived,
                deletedQuestions: result.deletedQuestions,
            });
        } catch (error) {
            if (error instanceof z.ZodError) return validationError("Invalid input", error.issues);
            if (error instanceof LearnerNotFoundError) return notFound("Child not found");
            logger.error({ error }, "Failed to delete child");
            return internalError("Failed to delete child");
        }
    },
);
