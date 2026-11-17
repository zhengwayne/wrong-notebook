import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { unauthorized, forbidden, badRequest, validationError, internalError, notFound } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { deleteChildLearner, LearnerNotFoundError, updateChildLearner } from "@/lib/learners";
import { parsePersonas } from "@/lib/personas";

const logger = createLogger("api:learners");
const patchSchema = z.object({ name: z.string().min(1) });
const deleteSchema = z.object({
    deleteQuestions: z.boolean().optional(),
    confirmDeleteQuestions: z.boolean().optional(),
});

async function parentUser(email: string) {
    const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, personas: true },
    });
    if (!user) return null;
    return { ...user, isParent: parsePersonas(user.personas).includes("parent") };
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return unauthorized();
    try {
        const user = await parentUser(session.user.email);
        if (!user) return unauthorized();
        if (!user.isParent) return forbidden("Parent persona required");
        const { id } = await ctx.params;
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
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return unauthorized();
    try {
        const user = await parentUser(session.user.email);
        if (!user) return unauthorized();
        if (!user.isParent) return forbidden("Parent persona required");
        const { id } = await ctx.params;
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
}
