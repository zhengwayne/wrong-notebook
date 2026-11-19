import { NextResponse } from 'next/server';
import { badRequest, notFound } from '@/lib/api-errors';
import { generateShareToken } from '@/lib/grading-share-tokens';
import { prisma } from '@/lib/prisma';
import { defineApiRoute } from '@/lib/server/api-route';

export const POST = defineApiRoute({ auth: 'user' }, async (_req, { user, params }) => {
    const { id } = await params;
    const task = await prisma.gradingTask.findFirst({
        where: { id, userId: user.id },
        select: { id: true, taskMode: true },
    });
    if (!task) {
        return notFound('Grading task not found');
    }
    if (task.taskMode === 'quick') {
        return badRequest('随堂速批模式不支持公开扫码交卷，请使用标准花名册模式');
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
