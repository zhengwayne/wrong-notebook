import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { forbidden, notFound, badRequest, internalError } from "@/lib/api-errors";
import { LearnerNotFoundError } from "@/lib/learners";
import { resolveLearningScope } from "@/lib/learning-scope";
import { createLogger } from "@/lib/logger";
import { defineApiRoute } from "@/lib/server/api-route";

const logger = createLogger('api:notebooks:id');

/**
 * GET /api/notebooks/[id]
 * 获取单个错题本详情
 */
export const GET = defineApiRoute<Request, { id: string }>(
    { auth: 'user' },
    async (req, { user, params }) => {
        const { id } = await params;

        try {
            const rawLearnerId = new URL(req.url).searchParams.get("learnerId")?.trim();
        let filterLearnerId: string | null | undefined;
        if (rawLearnerId) {
            try {
                const scope = await resolveLearningScope(prisma, user.id, rawLearnerId);
                filterLearnerId = scope.learnerId;
            } catch (error) {
                if (error instanceof LearnerNotFoundError) {
                    return notFound("Learner not found");
                }
                throw error;
            }
        }
        const notebook = await prisma.subject.findUnique({
            where: { id },
            include: {
                _count: {
                    select: {
                        errorItems: filterLearnerId !== undefined ? { where: { learnerId: filterLearnerId } } : true,
                    },
                },
            },
        });

        if (!notebook) {
            return notFound("Notebook not found");
        }

        if (notebook.userId !== user.id) {
            return forbidden("Not authorized to access this notebook");
        }

        return NextResponse.json(notebook);
    } catch (error) {
        logger.error({ error }, 'Error fetching notebook');
        return internalError("Failed to fetch notebook");
    }
});

/**
 * PUT /api/notebooks/[id]
 * 更新错题本信息
 */
export const PUT = defineApiRoute<Request, { id: string }>(
    { auth: 'user' },
    async (req, { user, params }) => {
        const { id } = await params;

        try {
            const notebook = await prisma.subject.findUnique({
                where: { id },
            });

        if (!notebook) {
            return notFound("Notebook not found");
        }

        if (notebook.userId !== user.id) {
            return forbidden("Not authorized to update this notebook");
        }

        const body = await req.json();
        const { name } = body;

        if (!name || !name.trim()) {
            return badRequest("Notebook name is required");
        }

        const updated = await prisma.subject.update({
            where: { id },
            data: {
                name: name.trim(),
            },
            include: {
                _count: {
                    select: {
                        errorItems: true,
                    },
                },
            },
        });

        return NextResponse.json(updated);
    } catch (error) {
        logger.error({ error }, 'Error updating notebook');
        return internalError("Failed to update notebook");
    }
});

/**
 * DELETE /api/notebooks/[id]
 * 删除错题本
 */
export const DELETE = defineApiRoute<Request, { id: string }>(
    { auth: 'user' },
    async (_req, { user, params }) => {
        const { id } = await params;

        try {
            const notebook = await prisma.subject.findUnique({
                where: { id },
                include: {
                    _count: {
                        select: {
                            errorItems: true,
                        },
                    },
                },
            });

            if (!notebook) {
                return notFound("Notebook not found");
            }

            if (notebook.userId !== user.id) {
                return forbidden("Not authorized to delete this notebook");
            }

            // 检查是否有错题
            if (notebook._count.errorItems > 0) {
                return badRequest("Cannot delete notebook with error items. Please move or delete all items first.");
            }

            await prisma.subject.delete({
                where: { id },
            });

            return NextResponse.json({ message: "Notebook deleted successfully" });
        } catch (error) {
            logger.error({ error }, 'Error deleting notebook');
            return internalError("Failed to delete notebook");
        }
    },
);
