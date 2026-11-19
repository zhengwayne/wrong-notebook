import { NextResponse } from 'next/server';
import { z } from 'zod';
import { notFound } from '@/lib/api-errors';
import { HOMEWORK_CATEGORIES, HOMEWORK_SUBJECTS } from '@/lib/daily-homework';
import { prisma } from '@/lib/prisma';
import { defineApiRoute } from '@/lib/server/api-route';

const patchHomeworkSchema = z.object({
    completed: z.boolean().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    subjectKey: z.enum(HOMEWORK_SUBJECTS).optional(),
    category: z.enum(HOMEWORK_CATEGORIES).optional(),
    estimatedMinutes: z.number().int().min(1).max(480).nullable().optional(),
    actualMinutes: z.number().int().min(1).max(480).nullable().optional(),
});

export const PATCH = defineApiRoute(
    { auth: 'user', maxBodyBytes: 8192, bodySchema: patchHomeworkSchema },
    async (_req, { user, params, body }) => {
        const { id } = await params;
        const existing = await prisma.dailyHomeworkItem.findFirst({
            where: { id, userId: user.id },
            select: { id: true, completed: true },
        });
        if (!existing) {
            return notFound('Homework item not found');
        }

        const updated = await prisma.dailyHomeworkItem.update({
            where: { id: existing.id },
            data: {
                ...(body.title !== undefined ? { title: body.title } : {}),
                ...(body.subjectKey !== undefined ? { subjectKey: body.subjectKey } : {}),
                ...(body.category !== undefined ? { category: body.category } : {}),
                ...(body.estimatedMinutes !== undefined ? { estimatedMinutes: body.estimatedMinutes } : {}),
                ...(body.actualMinutes !== undefined ? { actualMinutes: body.actualMinutes } : {}),
                ...(body.completed !== undefined
                    ? {
                        completed: body.completed,
                        completedAt: body.completed ? new Date() : null,
                    }
                    : {}),
            },
        });

        return NextResponse.json(updated);
    },
);

export const DELETE = defineApiRoute({ auth: 'user' }, async (_req, { user, params }) => {
    const { id } = await params;
    const existing = await prisma.dailyHomeworkItem.findFirst({
        where: { id, userId: user.id },
        select: { id: true },
    });
    if (!existing) {
        return notFound('Homework item not found');
    }

    await prisma.dailyHomeworkItem.delete({ where: { id: existing.id } });
    return NextResponse.json({ deleted: true });
});
