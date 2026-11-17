import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, badRequest, notFound, conflict, internalError } from "@/lib/api-errors";
import { LearnerNotFoundError } from "@/lib/learners";
import { resolveLearningScope } from "@/lib/learning-scope";
import { createLogger } from "@/lib/logger";
import { isValidNotebookScope, stageFromEducationStage, STAGE_SUBJECTS, type NotebookSubject } from "@/lib/notebook-scope";

const logger = createLogger('api:notebooks');

function notebookListInclude(learnerId: string | null | undefined) {
    return {
        _count: {
            select: {
                errorItems: learnerId !== undefined ? { where: { learnerId } } : true,
            },
        },
    } as const;
}

/**
 * GET /api/notebooks?learnerId=
 * 获取用户所有错题本（Subjects）；传入 learnerId 时只统计该学习者的错题数
 */
export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    const rawLearnerId = new URL(req.url).searchParams.get("learnerId")?.trim();

    try {
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({
                where: { email: session.user.email },
            });
        }

        if (!user) {
            return unauthorized("Authentication required");
        }

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

        let notebooks = await prisma.subject.findMany({
            where: {
                userId: user.id,
            },
            include: notebookListInclude(filterLearnerId),
            orderBy: {
                createdAt: 'desc',
            },
        });

        // If no notebooks exist, create default ones（学段取用户的教育阶段）
        if (notebooks.length === 0) {
            const stage = stageFromEducationStage(user.educationStage);
            const defaults: { name: string; subjectKey: NotebookSubject }[] = [
                { name: "数学", subjectKey: "math" },
                { name: "英语", subjectKey: "english" },
            ];
            const defaultSubjects = defaults.filter((subject) => STAGE_SUBJECTS[stage].includes(subject.subjectKey));

            await Promise.all(defaultSubjects.map(({ name, subjectKey }) =>
                prisma.subject.create({
                    data: {
                        name,
                        stage,
                        subjectKey,
                        userId: user!.id,
                    }
                })
            ));

            // Fetch again
            notebooks = await prisma.subject.findMany({
                where: {
                    userId: user.id,
                },
                include: notebookListInclude(filterLearnerId),
                orderBy: {
                    createdAt: 'desc',
                },
            });
        }

        return NextResponse.json(notebooks);
    } catch (error) {
        logger.error({ error }, 'Error fetching notebooks');
        return internalError("Failed to fetch notebooks");
    }
}

/**
 * POST /api/notebooks
 * 创建新错题本
 */
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    try {
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({
                where: { email: session.user.email },
            });
        }

        if (!user) {
            return unauthorized("Authentication required");
        }

        const body = await req.json();
        const { name, stage, subjectKey } = body;

        if (typeof name !== "string" || !name.trim()) {
            return badRequest("Notebook name is required");
        }
        // 学段和学科只能在创建时选择，之后不可修改
        if (!isValidNotebookScope(stage, subjectKey)) {
            return badRequest("A valid stage and subject are required");
        }

        // 检查是否已存在同名错题本
        const existing = await prisma.subject.findUnique({
            where: {
                name_userId: {
                    name: name.trim(),
                    userId: user.id,
                },
            },
        });

        if (existing) {
            return conflict("Notebook with this name already exists");
        }

        const notebook = await prisma.subject.create({
            data: {
                name: name.trim(),
                stage,
                subjectKey,
                userId: user.id,
            },
            include: {
                _count: {
                    select: {
                        errorItems: true,
                    },
                },
            },
        });

        return NextResponse.json(notebook, { status: 201 });
    } catch (error) {
        logger.error({ error }, 'Error creating notebook');
        return internalError("Failed to create notebook");
    }
}
