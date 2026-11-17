import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { unauthorized, forbidden, badRequest, validationError, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { ChildLearnerLimitError, createChildLearner, LEARNER_KIND } from "@/lib/learners";
import { parsePersonas } from "@/lib/personas";

const logger = createLogger("api:learners");
const createSchema = z.object({ name: z.string().min(1) });

async function parentUser(email: string) {
    const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, personas: true, personasConfirmedAt: true },
    });
    if (!user) return null;
    return { ...user, isParent: parsePersonas(user.personas).includes("parent") };
}

export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return unauthorized();
    try {
        const user = await parentUser(session.user.email);
        if (!user) return unauthorized();
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
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return unauthorized();
    try {
        const user = await parentUser(session.user.email);
        if (!user) return unauthorized();
        if (!user.isParent) return forbidden("Parent persona required");
        const { name } = createSchema.parse(await req.json());
        const child = await createChildLearner(prisma, user.id, name);
        return NextResponse.json({ id: child.id, name: child.name, itemCount: 0 }, { status: 201 });
    } catch (error) {
        if (error instanceof z.ZodError) return validationError("Invalid input", error.issues);
        if (error instanceof ChildLearnerLimitError) return badRequest("At most 3 children");
        logger.error({ error }, "Failed to create child");
        return internalError("Failed to create child");
    }
}
