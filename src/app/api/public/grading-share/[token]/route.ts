import { NextResponse } from 'next/server';
import { notFound, tooManyRequests } from '@/lib/api-errors';
import { isWrong, parseJsonStringArray } from '@/lib/grading';
import {
    checkPublicTokenRateLimit,
    hashShareToken,
    resolveRequestClientIp,
} from '@/lib/grading-share-tokens';
import { prisma } from '@/lib/prisma';
import { defineApiRoute } from '@/lib/server/api-route';

export const GET = defineApiRoute({ auth: 'public' }, async (req, { params }) => {
    const { token } = await params;
    const tokenHash = hashShareToken(token);
    if (!tokenHash) {
        return notFound('反馈链接无效或已过期');
    }

    const ip = resolveRequestClientIp(req);
    const rate = checkPublicTokenRateLimit(`pub-share:${ip}:${tokenHash.slice(0, 12)}`, 30, 60_000);
    if (!rate.allowed) {
        return tooManyRequests(rate.retryAfterMs);
    }

    const submission = await prisma.gradingSubmission.findFirst({
        where: { shareTokenHash: tokenHash },
        include: {
            student: { select: { name: true } },
            task: {
                select: {
                    title: true,
                    subjectName: true,
                    scoringMode: true,
                    questions: { select: { id: true, maxScore: true } },
                },
            },
            results: {
                include: { keyQuestion: true },
                orderBy: { keyQuestion: { order: 'asc' } },
            },
        },
    });
    if (!submission) {
        return notFound('反馈链接无效或已过期');
    }
    if (submission.shareExpiresAt && submission.shareExpiresAt.getTime() < Date.now()) {
        return notFound('反馈链接已过期');
    }

    const maxTotalScore = submission.task.questions.reduce((sum, q) => sum + q.maxScore, 0);
    const wrongQuestions = submission.results
        .filter((res) => isWrong(res.verdict))
        .map((res) => ({
            id: res.id,
            number: res.keyQuestion.number,
            questionText: res.keyQuestion.questionText || `第 ${res.keyQuestion.number} 题`,
            studentAnswer: res.studentAnswer || '',
            correctAnswer: res.keyQuestion.answer,
            verdict: res.verdict,
            score: res.score,
            maxScore: res.keyQuestion.maxScore,
            reason: res.reason || '',
            comment: res.comment || '',
            knowledgePoints: parseJsonStringArray(res.keyQuestion.knowledgePoints),
        }));

    return NextResponse.json({
        taskTitle: submission.task.title,
        subjectName: submission.task.subjectName,
        scoringMode: submission.task.scoringMode,
        studentName: submission.student?.name || submission.detectedName || '',
        totalScore: submission.totalScore,
        maxTotalScore,
        handwritingLevel: submission.handwritingLevel,
        neatnessLevel: submission.neatnessLevel,
        attitudeLevel: submission.attitudeLevel,
        teacherComment: submission.teacherComment,
        wrongQuestions,
    });
});
