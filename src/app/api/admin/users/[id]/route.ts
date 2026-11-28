import { NextResponse } from "next/server"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { badRequest, internalError, notFound, validationError } from "@/lib/api-errors"
import { createLogger } from "@/lib/logger"
import { USER_SAFE_SELECT } from "@/lib/user-select"
import { deleteUserAccount, UserDeletionError } from "@/lib/user-deletion"
import { defineApiRoute } from "@/lib/server/api-route"

const logger = createLogger('api:admin:users:id');

const updateUserStatusSchema = z.object({
    isActive: z.boolean(),
});

export const PATCH = defineApiRoute<Request, { id: string }>(
    { auth: 'admin', unauthenticatedStatus: 403 },
    async (req, { user: actorUser, params }) => {
        const { id } = await params;

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
            if (id === actorUser.id) {
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
                where: { id },
                data: {
                    isActive,
                    // 禁用账户时同步递增会话版本，令既有会话立即撤销
                    ...(isActive === false ? { authVersion: { increment: 1 } } : {}),
                },
                select: USER_SAFE_SELECT,
            })

            return NextResponse.json(user)
        } catch (error) {
            logger.error({ error }, 'Error updating user');
            return internalError("Failed to update user")
        }
    },
);

export const DELETE = defineApiRoute<Request, { id: string }>(
    { auth: 'admin', unauthenticatedStatus: 403 },
    async (_req, { user: actorUser, params }) => {
        const { id } = await params;

        try {
            // Prevent deleting self
            if (id === actorUser.id) {
                return badRequest("Cannot delete your own account");
            }

            const user = await deleteUserAccount(prisma, {
                targetUserId: id,
                actorKind: "admin",
            });
            return NextResponse.json(user);
        } catch (error) {
            if (error instanceof UserDeletionError) {
                if (error.code === "NOT_FOUND") return notFound("User not found");
                if (error.code === "PROTECTED_DEFAULT_ADMIN") return badRequest("Cannot delete super admin");
                if (error.code === "LAST_ACTIVE_ADMIN") return badRequest("Cannot delete the last active admin");
            }
            logger.error({ error }, 'Error deleting user');
            return internalError("Failed to delete user");
        }
    },
);
