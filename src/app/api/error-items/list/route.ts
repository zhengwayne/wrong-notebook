import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { internalError } from "@/lib/api-errors";
import { resolveNotebookItemFilter } from "@/lib/server/notebook-item-filter";
import { createLogger } from "@/lib/logger";
import { getAppTimeZone } from "@/lib/config";
import { shiftCalendarDate } from "@/lib/date-time";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MIN_PAGE_SIZE } from "@/lib/constants/pagination";
import { isShortId } from "@/lib/short-id";
import { isMasteryStatus, masteryStatusOf, masteryStatusWhere } from "@/lib/mastery-status";
import { ERROR_ITEM_LIST_SELECT, ERROR_ITEM_PRINT_SELECT } from "@/lib/error-list-select";
import { defineApiRoute } from "@/lib/server/api-route";
import { mpSafeBody } from "@/lib/server/mp-review-safe";

const logger = createLogger('api:error-items:list');

export const GET = defineApiRoute({ auth: 'user' }, async (req, { user }) => {
    const { searchParams } = new URL(req.url);
    const subjectId = searchParams.get("subjectId");
    const query = searchParams.get("query");
    const mastery = searchParams.get("mastery");
    const timeRange = searchParams.get("timeRange");
    const tag = searchParams.get("tag");

    // 分页参数
    const parsedPage = Number(searchParams.get("page"));
    const page = Number.isSafeInteger(parsedPage) ? Math.max(1, parsedPage) : 1;
    const parsedSize = parseInt(searchParams.get("pageSize") ?? "", 10);
    const pageSize = Number.isFinite(parsedSize) ? Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, parsedSize)) : DEFAULT_PAGE_SIZE;

    try {
        const itemFilter = await resolveNotebookItemFilter(user.id, searchParams);
        if (itemFilter instanceof Response) return itemFilter;
        const whereClause: Prisma.ErrorItemWhereInput = { userId: user.id, ...itemFilter };
        if (subjectId) whereClause.subjectId = subjectId;

        // 搜索条件需要使用 AND 包装，避免与其他 OR 条件冲突
        // 最终的 whereClause.AND 会包含所有需要同时满足的条件
        const andConditions: Prisma.ErrorItemWhereInput[] = [];

        if (query) {
            // 搜索条件：在题目、解析、知识点中任一匹配即可
            andConditions.push({
                OR: [
                    { questionText: { contains: query } },
                    { analysis: { contains: query } },
                    { wrongAnswerText: { contains: query } },
                    { mistakeAnalysis: { contains: query } },
                    { knowledgePoints: { contains: query } },
                    ...(isShortId(query.trim()) ? [{ shortId: query.trim() }] : []),
                ]
            });
        }

        // 复习状态筛选：new 待复习 / reviewing 复习中 / mastered 已掌握
        if (isMasteryStatus(mastery)) {
            andConditions.push(masteryStatusWhere(mastery, user.masteryThreshold));
        }

        // Time range filter
        if (timeRange && timeRange !== "all") {
            const now = new Date();
            const timeZone = getAppTimeZone();
            let startDate = now;

            if (timeRange === "week") {
                startDate = shiftCalendarDate(now, timeZone, -7);
            } else if (timeRange === "month") {
                startDate = shiftCalendarDate(now, timeZone, 0, -1);
            }

            whereClause.createdAt = {
                gte: startDate,
            };
        }

        const chapter = searchParams.get("chapter");
        if (chapter) {
            const ids = await findChapterDescendantTagIds(chapter, user.id);
            whereClause.tags = { some: { id: { in: ids }, ...(tag ? { name: tag } : {}) } };
        } else if (tag) {
            // 兼容只写入 knowledgePoints 的旧题，按完整标签名匹配。
            andConditions.push({
                OR: [
                    { tags: { some: { name: tag } } },
                    { knowledgePoints: { contains: JSON.stringify(tag) } },
                ],
            });
        }

        // Grade/Semester filter
        const gradeSemester = searchParams.get("gradeSemester");
        if (gradeSemester) {
            const gradeFilter = buildGradeFilter(gradeSemester);
            if (gradeFilter) {
                // Merge into main whereClause
                Object.assign(whereClause, gradeFilter);
            }
        }

        // Paper Level filter
        const paperLevel = searchParams.get("paperLevel");
        if (paperLevel && paperLevel !== "all") {
            whereClause.paperLevel = paperLevel;
        }

        // 将所有 AND 条件合并到 whereClause
        if (andConditions.length > 0) {
            whereClause.AND = andConditions;
        }

        // 获取总数
        const total = await prisma.errorItem.count({
            where: whereClause,
        });

        // 分页查询
        const skip = (page - 1) * pageSize;
        const errorItems = skip >= total ? [] : await prisma.errorItem.findMany({
            where: whereClause,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: searchParams.get("view") === "print" ? ERROR_ITEM_PRINT_SELECT : ERROR_ITEM_LIST_SELECT,
            skip,
            take: pageSize,
        });

        const totalPages = Math.ceil(total / pageSize);

        return NextResponse.json(mpSafeBody(req, {
            items: errorItems.map(({ _count, ...item }) => ({
                ...item,
                masteryStatus: masteryStatusOf(_count.practiceRecords, item.masteryProbability, user.masteryThreshold),
            })),
            total,
            page,
            pageSize,
            totalPages,
        }));
    } catch (error) {
        logger.error({ error }, 'Error fetching items');
        return internalError("Failed to fetch error items");
    }
});

function buildGradeFilter(gradeSemester: string): Prisma.ErrorItemWhereInput {
    // 1. 恢复别名映射表 (Support aliases like 初一 for 七年级)
    const gradeMap: Record<string, string[]> = {
        "七年级": ["七年级", "初一", "7年级", "七"],
        "八年级": ["八年级", "初二", "8年级", "八"],
        "九年级": ["九年级", "初三", "9年级", "九"],
        "高一": ["高一", "10年级"],
        "高二": ["高二", "11年级"],
        "高三": ["高三", "12年级"],
    };

    // 2. 解析输入
    let targetGrades: string[] = [gradeSemester]; // Default fallback
    let targetSemester = "";

    // 提取年级关键字
    let foundKey = "";
    if (gradeSemester.includes("七年级") || gradeSemester.includes("初一")) foundKey = "七年级";
    else if (gradeSemester.includes("八年级") || gradeSemester.includes("初二")) foundKey = "八年级";
    else if (gradeSemester.includes("九年级") || gradeSemester.includes("初三")) foundKey = "九年级";
    else if (gradeSemester.includes("高一")) foundKey = "高一";
    else if (gradeSemester.includes("高二")) foundKey = "高二";
    else if (gradeSemester.includes("高三")) foundKey = "高三";
    else {
        // 如果无法识别标准年级，尝试直接解析前缀 (e.g. "一年级")
        const match = gradeSemester.match(/^(.+?)[上下]/);
        if (match) {
            targetGrades = [match[1]]; // e.g. "一年级"
        } else {
            // 完全完全无法解析，直接模糊匹配原字符串
            return { gradeSemester: { contains: gradeSemester } };
        }
    }

    if (foundKey) {
        targetGrades = gradeMap[foundKey];
    }

    // 提取学期
    if (gradeSemester.includes("上")) targetSemester = "上";
    else if (gradeSemester.includes("下")) targetSemester = "下";

    // 3. 构建多重组合查询条件
    // 对每一个可能的别名，生成多种格式变体
    const orConditions: Prisma.ErrorItemWhereInput[] = [];

    targetGrades.forEach(grade => {
        // 变体 1: 仅年级 (如果没有学期限制)
        if (!targetSemester) {
            orConditions.push({ gradeSemester: { contains: grade } });
        } else {
            // 变体 2: 年级 + 学期 (包含多种连接符)
            // 紧凑型: "初一上"
            orConditions.push({ gradeSemester: { contains: `${grade}${targetSemester}` } });
            // 逗号型: "初一，上" 或 "初一，上期"
            // 由于 contains 的特性，我们不需要穷举 "上期"/"上学期"，只要包含 "grade" 和 "学期关键字" 即可
            // 但 Prisma 的 AND 逻辑更适合处理这种情况
            // Let's use specific composed strings for precision if possible, or broad AND

            // 下面的逻辑能匹配 "初一，上期" (因为包含 "初一" 和 "，"?? 不，contains 是子串)
            // 这种组合 "grade + 任意字符 + semester" 很难用一个 contains 表达。
            // 简单粗暴点：
            orConditions.push({ gradeSemester: { contains: `${grade}，${targetSemester}` } }); // 中文逗号
            orConditions.push({ gradeSemester: { contains: `${grade},${targetSemester}` } }); // 英文逗号
            orConditions.push({ gradeSemester: { contains: `${grade} ${targetSemester}` } }); // 空格

            // 针对 "上期" 的特殊处理 (旧数据的 "高一，上期")
            const semesterTerm = targetSemester === '上' ? '上期' : '下期';
            orConditions.push({ gradeSemester: { contains: `${grade}，${semesterTerm}` } });
        }
    });

    if (orConditions.length === 0) {
        return { gradeSemester: { contains: gradeSemester } };
    }

    return { OR: orConditions };
}

// 一次查询所有可见同名章节及后代。UNION 也会对旧数据中的循环引用去重。
async function findChapterDescendantTagIds(chapterName: string, userId: string): Promise<string[]> {
    const tags = await prisma.$queryRaw<Array<{ id: string }>>`
        WITH RECURSIVE descendants(id) AS (
            SELECT id FROM KnowledgeTag WHERE name = ${chapterName} AND (isSystem OR userId = ${userId})
            UNION
            SELECT child.id FROM KnowledgeTag child JOIN descendants ON child.parentId = descendants.id
            WHERE child.isSystem OR child.userId = ${userId}
        )
        SELECT id FROM descendants
    `;
    return tags.map(tag => tag.id);
}
