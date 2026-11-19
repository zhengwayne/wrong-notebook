import { NextResponse } from 'next/server';
import { badRequest, notFound } from '@/lib/api-errors';
import { DEFAULT_SHARE_TTL_MS, generateShareToken } from '@/lib/grading-share-tokens';
import { prisma } from '@/lib/prisma';
import { defineApiRoute } from '@/lib/server/api-route';

export const POST = defineApiRoute({ auth: 'user' }, async (_req, { user, params }) => {
    const { id } = await params;
    const submission = await prisma.gradingSubmission.findFirst({
        where: { id, task: { userId: user.id } },
        select: { id: true, status: true },
    });
    if (!submission) {
        return notFound('Submission not found');
    }
    if (submission.status !== 'graded' && submission.status !== 'confirmed') {
        return badRequest('请等待答卷批改完成后再生成家长反馈卡');
    }

    const { rawToken, tokenHash } = generateShareToken();
    const expiresAt = new Date(Date.now() + DEFAULT_SHARE_TTL_MS);

    await prisma.gradingSubmission.update({
        where: { id: submission.id },
        data: {
            shareTokenHash: tokenHash,
            shareExpiresAt: expiresAt,
        },
    });

    return NextResponse.json({
        rawToken,
        sharePath: `/share/submission/${rawToken}`,
        expiresAt: expiresAt.toISOString(),
    });
});

export const DELETE = defineApiRoute({ auth: 'user' }, async (_req, { user, params }) => {
    const { id } = await params;
    const submission = await prisma.gradingSubmission.findFirst({
        where: { id, task: { userId: user.id } },
        select: { id: true },
    });
    if (!submission) {
        return notFound('Submission not found');
    }

    await prisma.gradingSubmission.update({
        where: { id: submission.id },
        data: {
            shareTokenHash: null,
            shareExpiresAt: null,
        },
    });

    return NextResponse.json({ revoked: true });
});
