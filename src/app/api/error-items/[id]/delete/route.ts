import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { forbidden, notFound, internalError } from "@/lib/api-errors";
import { scheduleLearningPathReplan } from "@/lib/learning-path/service";
import { createLogger } from "@/lib/logger";
import { defineApiRoute } from "@/lib/server/api-route";

const logger = createLogger('api:error-items:delete');

export const DELETE = defineApiRoute<Request, { id: string }>(
    { auth: 'user' },
    async (_req, { user, params }) => {
        const { id } = await params;

        try {
            // Verify ownership before deletion
            const errorItem = await prisma.errorItem.findUnique({
                where: { id: id },
            });

            if (!errorItem) {
                return notFound("Item not found");
            }

            if (errorItem.userId !== user.id) {
                return forbidden("Not authorized to delete this item");
            }

            // Delete the item
            await prisma.errorItem.delete({
                where: { id: id },
            });
            scheduleLearningPathReplan(user.id, 'zh', errorItem.learnerId);

            return NextResponse.json({ message: "Deleted successfully" });
        } catch (error) {
            logger.error({ error }, 'Error deleting item');
            return internalError("Failed to delete error item");
        }
    },
);
