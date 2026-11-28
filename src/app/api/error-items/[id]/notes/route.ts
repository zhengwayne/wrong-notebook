import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notFound, badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { defineApiRoute } from "@/lib/server/api-route";

const logger = createLogger('api:error-items:notes');

export const PATCH = defineApiRoute<Request, { id: string }>(
    { auth: 'user' },
    async (req, { user, params }) => {
        const { id } = await params;

        try {
            const { userNotes } = await req.json();
            if (userNotes !== null && typeof userNotes !== 'string') {
                return badRequest("userNotes must be a string");
            }

            const existing = await prisma.errorItem.findUnique({ where: { id }, select: { userId: true } });
            if (!existing || existing.userId !== user.id) {
                return notFound("Item not found");
            }

            const errorItem = await prisma.errorItem.update({
                where: {
                    id: id,
                },
                data: {
                    userNotes: userNotes,
                },
            });

            return NextResponse.json(errorItem);
        } catch (error) {
            logger.error({ error }, 'Error updating notes');
            return internalError("Failed to update notes");
        }
    },
);

/** POST 与 PATCH 相同：小程序 wx.request 不支持 PATCH 方法 */
export const POST = PATCH;
