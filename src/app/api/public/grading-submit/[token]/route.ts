import { NextResponse } from 'next/server';
import { z } from 'zod';
import { consumeAiQuota } from '@/lib/ai-quota';
import { badRequest, conflict, notFound, tooManyRequests } from '@/lib/api-errors';
import { imageDataUrlSchema, languageSchema, MAX_PAGES_PER_PAPER } from '@/lib/grading-api';
import { loadTaskRoster, scheduleGrading } from '@/lib/grading-service';
import {
    checkPublicTokenRateLimit,
    hashShareToken,
    resolveRequestClientIp,
    withBridgeMutex,
} from '@/lib/grading-share-tokens';
import { prisma } from '@/lib/prisma';
import { defineApiRoute } from '@/lib/server/api-route';
import { ImageValidationError, normalizeImageDataUrl } from '@/lib/server/image-normalize';

const publicSubmitSchema = z.object({
    studentNo: z.string().trim().max(40).optional(),
    studentName: z.string().trim().min(1).max(60),
    images: z.array(imageDataUrlSchema).min(1).max(MAX_PAGES_PER_PAPER),
    language: languageSchema,
});

export const GET = defineApiRoute({ auth: 'public' }, async (req, { params }) => {
    const { token } = await params;
    const tokenHash = hashShareToken(token);
    if (!tokenHash) {
        return notFound('交卷链接无效或已关闭');
    }

    const ip = resolveRequestClientIp(req);
    const rate = checkPublicTokenRateLimit(`pub-submit-get:${ip}:${tokenHash.slice(0, 12)}`, 30, 60_000);
    if (!rate.allowed) {
        return tooManyRequests(rate.retryAfterMs);
    }

    const task = await prisma.gradingTask.findFirst({
        where: { submitTokenHash: tokenHash, allowSelfSubmit: true },
        select: {
            title: true,
            subjectName: true,
            deadline: true,
            taskMode: true,
            user: { select: { isActive: true } },
        },
    });
    if (!task || task.user.isActive === false || task.taskMode === 'quick') {
        return notFound('交卷链接无效或已关闭');
    }
    if (task.deadline && task.deadline.getTime() < Date.now()) {
        return badRequest('本次作业交卷已截止');
    }

    return NextResponse.json({
        title: task.title,
        subjectName: task.subjectName,
        deadline: task.deadline ? task.deadline.toISOString() : null,
        maxPages: MAX_PAGES_PER_PAPER,
    });
});

export const POST = defineApiRoute(
    { auth: 'public', maxBodyBytes: 25 * 1024 * 1024, bodySchema: publicSubmitSchema },
    async (req, { params, body }) => {
        const { token } = await params;
        const tokenHash = hashShareToken(token);
        if (!tokenHash) {
            return notFound('交卷链接无效或已关闭');
        }

        const ip = resolveRequestClientIp(req);
        const rate = checkPublicTokenRateLimit(`pub-submit-post:${ip}:${tokenHash.slice(0, 12)}`, 10, 60_000);
        if (!rate.allowed) {
            return tooManyRequests(rate.retryAfterMs, '提交过于频繁，请稍后再试');
        }

        const task = await prisma.gradingTask.findFirst({
            where: { submitTokenHash: tokenHash, allowSelfSubmit: true },
            include: {
                user: { select: { id: true, role: true, isActive: true } },
                _count: { select: { questions: true } },
            },
        });
        if (!task || task.user.isActive === false || task.taskMode === 'quick') {
            return notFound('交卷链接无效或已关闭');
        }
        if (task.deadline && task.deadline.getTime() < Date.now()) {
            return badRequest('本次作业交卷已截止');
        }
        if (task._count.questions === 0) {
            return badRequest('老师尚未完成标准答案配置，请稍后提交');
        }

        const trimmedName = body.studentName.trim();
        const trimmedNo = body.studentNo?.trim() || '';
        const roster = await loadTaskRoster(task);
        const sameName = roster.filter((s) => s.name.trim() === trimmedName);
        let matchedStudentId: string | null = null;
        if (sameName.length === 1 && !sameName[0].studentNo) {
            matchedStudentId = sameName[0].id;
        } else {
            const exact = sameName.find((s) => (s.studentNo?.trim() || '') === trimmedNo && trimmedNo.length > 0);
            matchedStudentId = exact?.id ?? null;
        }
        if (!matchedStudentId) {
            return badRequest('学号与姓名核验未通过，请核对后重试');
        }

        let normalizedImages: string[];
        try {
            normalizedImages = await Promise.all(
                body.images.map(async (img) => (await normalizeImageDataUrl(img)).dataUrl),
            );
        } catch (error) {
            if (error instanceof ImageValidationError) {
                return badRequest('上传的图片格式无效或已损坏，请重新拍照上传');
            }
            throw error;
        }

        return withBridgeMutex(`submit:${task.id}:${matchedStudentId}`, async () => {
            const duplicate = await prisma.gradingSubmission.findFirst({
                where: { taskId: task.id, studentId: matchedStudentId },
                select: { id: true },
            });
            if (duplicate) {
                return conflict('该同学已提交过本次作业，如需重交请联系老师');
            }

            const quotaLimited = await consumeAiQuota(task.user, 'grade');
            if (quotaLimited) {
                return quotaLimited;
            }

            const submission = await prisma.gradingSubmission.create({
                data: {
                    taskId: task.id,
                    studentId: matchedStudentId,
                    detectedName: trimmedName,
                    detectedStudentNo: trimmedNo || null,
                    matchStatus: 'manual',
                    matchConfidence: 1,
                    matchReason: JSON.stringify({ code: 'self_submit' }),
                    images: JSON.stringify(normalizedImages),
                },
                select: { id: true },
            });

            scheduleGrading([submission.id], body.language);
            return NextResponse.json({ submitted: true, submissionId: submission.id }, { status: 202 });
        });
    },
);
