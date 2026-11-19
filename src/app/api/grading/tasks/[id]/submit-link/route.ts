import { NextResponse } from 'next/server';
import { notFound } from '@/lib/api-errors';
import { generateShareToken } from '@/lib/grading-share-tokens';
import { prisma } from '@/lib/prisma';
import { defineApiRoute } from '@/lib/server/api-route';

export const POST = defineApiRoute({ auth: 'user' }, async (_req, { user, params }) => {
    const { id } = await params;
    const task = await prisma.gradingTask.findFirst({
        where: { id, userId: user.id },
        select: { id: true },
    });
    if (!task) {
        return notFound('Grading task not found');
    }

    const { rawToken, tokenHash } = generateShareToken();
    await prisma.gradingTask.update({
        where: { id: task.id },
        data: {
            allowSelfSubmit: true,
            submitTokenHash: tokenHash,
        },
    });

    return NextResponse.json({
        allowSelfSubmit: true,
        rawToken,
        submitPath: `/submit/${rawToken}`,
    });
});

export const DELETE = defineApiRoute({ auth: 'user' }, async (_req, { user, params }) => {
    const { id } = await params;
    const task = await prisma.gradingTask.findFirst({
        where: { id, userId: user.id },
        select: { id: true },
    });
    if (!task) {
        return notFound('Grading task not found');
    }

    await prisma.gradingTask.update({
        where: { id: task.id },
        data: {
            allowSelfSubmit: false,
            submitTokenHash: null,
        },
    });

    return NextResponse.json({ allowSelfSubmit: false });
});
