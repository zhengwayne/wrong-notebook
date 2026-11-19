import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { badRequest, conflict, internalError } from "@/lib/api-errors";
import { resolveNotebookItemFilter } from "@/lib/server/notebook-item-filter";
import { createLogger } from "@/lib/logger";
import { isValidNotebookScope, stageFromEducationStage, STAGE_SUBJECTS, type NotebookSubject } from "@/lib/notebook-scope";
import { defineApiRoute } from "@/lib/server/api-route";

const logger = createLogger('api:notebooks');

/**
 * GET /api/notebooks?learnerId=&classId=&nonEmptyOnly=1
 * 获取用户所有错题本（Subjects）；支持按单个学习者或整个班级过滤统计，并可隐藏 0 题空错题本
 */
export const GET = defineApiRoute({ auth: 'user' }, async (req, { user }) => {
    const searchParams = new URL(req.url).searchParams;
    const rawClassId = searchParams.get("classId")?.trim();
    const nonEmptyOnly = searchParams.get("nonEmptyOnly") === "1";

    try {
        const itemFilter = await resolveNotebookItemFilter(user.id, searchParams);
        if (itemFilter instanceof Response) return itemFilter;
        const whereClause = {
            userId: user.id,
            ...(rawClassId ? { errorItems: { some: itemFilter } } : {}),
        };
        const include = {
            _count: { select: { errorItems: itemFilter.learnerId !== undefined ? { where: itemFilter } : true } },
        } as const;

        let notebooks = await prisma.subject.findMany({
            where: whereClause,
            include,
            orderBy: {
                createdAt: 'desc',
            },
        });

        // If no notebooks exist (仅在未加班级筛选的初始态下自动初始化默认错题本)
        if (notebooks.length === 0 && !rawClassId && !nonEmptyOnly) {
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

            notebooks = await prisma.subject.findMany({
                where: whereClause,
                include,
                orderBy: {
                    createdAt: 'desc',
                },
            });
        }

        if (nonEmptyOnly) {
            notebooks = notebooks.filter((nb) => (nb._count?.errorItems ?? 0) > 0);
        }

        return NextResponse.json(notebooks);
    } catch (error) {
        logger.error({ error }, 'Error fetching notebooks');
        return internalError("Failed to fetch notebooks");
    }
});

/**
 * POST /api/notebooks
 * 创建新错题本
 */
export const POST = defineApiRoute({ auth: 'user' }, async (req, { user }) => {
    try {
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
});
