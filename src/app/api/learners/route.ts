import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { forbidden, badRequest, validationError, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { ChildLearnerLimitError, createChildLearner, LEARNER_KIND } from "@/lib/learners";
import { parsePersonas } from "@/lib/personas";
import { defineApiRoute } from "@/lib/server/api-route";

const logger = createLogger("api:learners");
const createSchema = z.object({ name: z.string().min(1) });

export const GET = defineApiRoute({ auth: 'user' }, async (_req, { user }) => {
    try {
        const children = await prisma.learner.findMany({
            where: { userId: user.id, kind: LEARNER_KIND.child, archivedAt: null },
            orderBy: [{ order: "asc" }, { createdAt: "asc" }],
            select: {
                id: true,
                name: true,
                order: true,
                createdAt: true,
                _count: { select: { errorItems: true } },
            },
        });
        return NextResponse.json({
            children: children.map((child) => ({
                id: child.id,
                name: child.name,
                order: child.order,
                createdAt: child.createdAt,
                itemCount: child._count.errorItems,
            })),
        });
    } catch (error) {
        logger.error({ error }, "Failed to list children");
        return internalError("Failed to list children");
    }
});

export const POST = defineApiRoute({ auth: 'user' }, async (req, { user }) => {
    try {
        if (!parsePersonas(user.personas).includes("parent")) {
            return forbidden("Parent persona required");
        }
        const { name } = createSchema.parse(await req.json());
        const child = await createChildLearner(prisma, user.id, name);
        return NextResponse.json({ id: child.id, name: child.name, itemCount: 0 }, { status: 201 });
    } catch (error) {
        if (error instanceof z.ZodError) return validationError("Invalid input", error.issues);
        if (error instanceof ChildLearnerLimitError) return badRequest("At most 3 children");
        logger.error({ error }, "Failed to create child");
        return internalError("Failed to create child");
    }
});
