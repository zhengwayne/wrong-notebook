import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { z } from "zod"
import { authOptions } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { requireAdmin } from "@/lib/auth-utils"
import { forbidden, badRequest, internalError, validationError } from "@/lib/api-errors"
import { createLogger } from "@/lib/logger"
import { USER_SAFE_SELECT } from "@/lib/user-select"

const logger = createLogger('api:admin:users:id');

const updateUserStatusSchema = z.object({
    isActive: z.boolean(),
});

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions)

    if (!requireAdmin(session)) {
        return forbidden("Admin access required")
    }

    let rawBody: unknown;
    try {
        rawBody = await req.json();
    } catch {
        return badRequest("Invalid JSON body");
    }
    const parsed = updateUserStatusSchema.safeParse(rawBody);
    if (!parsed.success) {
        return validationError("Invalid user update payload", parsed.error.issues);
    }
    const { isActive } = parsed.data;

    try {
        // Prevent disabling self
        if (id === session?.user.id) {
            return badRequest("Cannot disable your own account")
        }

        // Prevent disabling super admin
        const targetUser = await prisma.user.findUnique({
            where: { id },
            select: { id: true, email: true, role: true },
        })

        if (targetUser?.email === 'admin@localhost') {
            return badRequest("Cannot disable super admin")
        }

        const user = await prisma.user.update({
            where: {
                id
            },
            data: {
                isActive
            },
            select: USER_SAFE_SELECT,
        })

        return NextResponse.json(user)
    } catch (error) {
        logger.error({ error }, 'Error updating user');
        return internalError("Failed to update user")
    }
}

export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions)

    if (!requireAdmin(session)) {
        return forbidden("Admin access required")
    }

    try {
        // Prevent deleting self
        if (id === session?.user.id) {
            return badRequest("Cannot delete your own account")
        }

        // Prevent deleting super admin
        const targetUser = await prisma.user.findUnique({
            where: { id },
            select: { id: true, email: true, role: true },
        })

        if (targetUser?.role === 'admin') {
            if (targetUser.email === 'admin@localhost') {
                return badRequest("Cannot delete super admin")
            }
        }

        const user = await prisma.user.delete({
            where: {
                id
            },
            select: USER_SAFE_SELECT,
        })

        return NextResponse.json(user)
    } catch (error) {
        logger.error({ error }, 'Error deleting user');
        return internalError("Failed to delete user")
    }
}
