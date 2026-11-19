import { NextResponse } from 'next/server';
import { notFound } from '@/lib/api-errors';
import { DEFAULT_SHARE_TTL_MS, generateShareToken } from '@/lib/grading-share-tokens';
import { prisma } from '@/lib/prisma';
import { defineApiRoute } from '@/lib/server/api-route';

export const POST = defineApiRoute({ auth: 'user' }, async (_req, { user, params }) => {
    const { id } = await params;
    const submission = await prisma.gradingSubmission.findFirst({
        where: { id, task: { userId: user.id } },
        select: { id: true },
    });
    if (!submission) {
        return notFound('Submission not found');
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
