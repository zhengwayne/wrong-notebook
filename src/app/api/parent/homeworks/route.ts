import { NextResponse } from 'next/server';
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
    dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    subjectKey: z.enum(HOMEWORK_SUBJECTS).default('math'),
    category: z.enum(HOMEWORK_CATEGORIES).default('written'),
    title: z.string().trim().min(1).max(200),
    estimatedMinutes: z.number().int().min(1).max(480).nullable().optional(),
});

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
    const windowStartKey = shiftDateKey(dateKey, -65);

    const [items, recentCompletedHomeworks, recentPracticeRecords] = await Promise.all([
        prisma.dailyHomeworkItem.findMany({
            where: { userId: user.id, learnerId: learner.id, dateKey },
            orderBy: [{ completed: 'asc' }, { order: 'asc' }, { createdAt: 'asc' }],
        }),
        prisma.dailyHomeworkItem.findMany({
            where: {
                userId: user.id,
                learnerId: learner.id,
                completed: true,
                dateKey: { gte: windowStartKey, lte: dateKey },
            },
            select: { dateKey: true },
        }),
        prisma.practiceRecord.findMany({
            where: {
                userId: user.id,
                learnerId: learner.id,
                createdAt: { gte: new Date(Date.now() - 70 * 24 * 3600 * 1000) },
            },
            select: { createdAt: true },
        }),
    ]);

    const activeDateKeys = new Set<string>();
    for (const hw of recentCompletedHomeworks) {
        activeDateKeys.add(hw.dateKey);
    }
    for (const pr of recentPracticeRecords) {
        activeDateKeys.add(formatDateTime(pr.createdAt, 'yyyy-MM-dd', tz));
    }

    const completedCount = items.filter((item) => item.completed).length;
    const estimatedMinutes = items.reduce((sum, item) => sum + (item.estimatedMinutes ?? 0), 0);
    const streakDays = computeHomeworkStreak(activeDateKeys, dateKey);

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
