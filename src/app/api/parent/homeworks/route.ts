import { NextResponse } from 'next/server';
import { fromZonedTime } from 'date-fns-tz';
import { z } from 'zod';
import { badRequest, notFound } from '@/lib/api-errors';
import { getAppTimeZone } from '@/lib/config';
import {
    HOMEWORK_CATEGORIES,
    HOMEWORK_SUBJECTS,
    computeHomeworkStreak,
    isValidDateKey,
    shiftDateKey,
} from '@/lib/daily-homework';
import { formatDateTime } from '@/lib/date-time';
import { prisma } from '@/lib/prisma';
import { defineApiRoute } from '@/lib/server/api-route';

const createHomeworkSchema = z.object({
    learnerId: z.string().trim().min(1).max(64),
    dateKey: z.string().refine(isValidDateKey).optional(),
    subjectKey: z.enum(HOMEWORK_SUBJECTS).default('math'),
    category: z.enum(HOMEWORK_CATEGORIES).default('written'),
    title: z.string().trim().min(1).max(200),
    estimatedMinutes: z.number().int().min(1).max(480).nullable().optional(),
});

/** 分段读取已完成的日期。只有连续记录延伸到上一段时才继续查库。 */
async function homeworkStreak(userId: string, learnerId: string, dateKey: string, timeZone: string) {
    const windowDays = 64;
    let end = dateKey;
    let total = 0;
    for (;;) {
        const start = shiftDateKey(end, 1 - windowDays);
        const [homework, practice] = await Promise.all([
            prisma.dailyHomeworkItem.groupBy({
                by: ['dateKey'],
                where: { userId, learnerId, completed: true, dateKey: { gte: start, lte: end } },
            }),
            prisma.practiceRecord.findMany({
                where: {
                    userId, learnerId,
                    createdAt: {
                        gte: fromZonedTime(`${start}T00:00:00`, timeZone),
                        lt: fromZonedTime(`${shiftDateKey(end, 1)}T00:00:00`, timeZone),
                    },
                },
                select: { createdAt: true },
            }),
        ]);
        const active = new Set(homework.map(item => item.dateKey));
        for (const item of practice) active.add(formatDateTime(item.createdAt, 'yyyy-MM-dd', timeZone));
        // 仅查询日期当天未打卡时，允许从昨天接续。
        if (end !== dateKey && !active.has(end)) return total;
        const streak = computeHomeworkStreak(active, end);
        total += streak;
        if (streak + Number(!active.has(end)) < windowDays) return total;
        end = shiftDateKey(start, -1);
    }
}

export const GET = defineApiRoute({ auth: 'user' }, async (req, { user }) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const learnerId = url.searchParams.get('learnerId')?.trim() || '';
    if (!learnerId) {
        return badRequest('learnerId is required');
    }

    const learner = await prisma.learner.findFirst({
        where: { id: learnerId, userId: user.id, archivedAt: null },
        select: { id: true },
    });
    if (!learner) {
        return notFound('Learner not found');
    }

    const tz = getAppTimeZone();
    const rawDateKey = url.searchParams.get('dateKey');
    const dateKey = isValidDateKey(rawDateKey) ? rawDateKey : formatDateTime(new Date(), 'yyyy-MM-dd', tz);
    const [items, streakDays] = await Promise.all([
        prisma.dailyHomeworkItem.findMany({
            where: { userId: user.id, learnerId: learner.id, dateKey },
            orderBy: [{ completed: 'asc' }, { order: 'asc' }, { createdAt: 'asc' }],
        }),
        homeworkStreak(user.id, learner.id, dateKey, tz),
    ]);

    const completedCount = items.filter((item) => item.completed).length;
    const estimatedMinutes = items.reduce((sum, item) => sum + (item.estimatedMinutes ?? 0), 0);

    return NextResponse.json({
        dateKey,
        items,
        summary: {
            total: items.length,
            completed: completedCount,
            estimatedMinutes,
            streakDays,
        },
    });
});

export const POST = defineApiRoute(
    { auth: 'user', maxBodyBytes: 8192, bodySchema: createHomeworkSchema },
    async (_req, { user, body }) => {
        const learner = await prisma.learner.findFirst({
            where: { id: body.learnerId, userId: user.id, archivedAt: null },
            select: { id: true },
        });
        if (!learner) {
            return notFound('Learner not found');
        }

        const tz = getAppTimeZone();
        const dateKey = body.dateKey ?? formatDateTime(new Date(), 'yyyy-MM-dd', tz);
        const existingCount = await prisma.dailyHomeworkItem.count({
            where: { userId: user.id, learnerId: learner.id, dateKey },
        });

        const created = await prisma.dailyHomeworkItem.create({
            data: {
                userId: user.id,
                learnerId: learner.id,
                dateKey,
                subjectKey: body.subjectKey,
                category: body.category,
                title: body.title,
                estimatedMinutes: body.estimatedMinutes ?? null,
                order: existingCount,
            },
        });

        return NextResponse.json(created, { status: 201 });
    },
);
