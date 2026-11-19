import { NextResponse } from 'next/server';
import { z } from 'zod';
import { notFound } from '@/lib/api-errors';
import { isWrong, parseJsonStringArray } from '@/lib/grading';
import { resolveCroppedGradingItemImage } from '@/lib/grading-bbox-and-pool';
import { hashShareToken } from '@/lib/grading-share-tokens';
import { inferSubjectFromName } from '@/lib/knowledge-tags';
import { LEARNER_KIND } from '@/lib/learners';
import { isNotebookSubject, stageFromEducationStage } from '@/lib/notebook-scope';
import { prisma } from '@/lib/prisma';
import { defineApiRoute } from '@/lib/server/api-route';
import { generateUniqueShortId } from '@/lib/short-id';

const importSharedSchema = z.object({
    token: z.string().trim().min(20).max(128),
    learnerId: z.string().trim().min(1).max(64),
});

export const POST = defineApiRoute(
    { auth: 'user', maxBodyBytes: 8192, bodySchema: importSharedSchema },
    async (_req, { user, body }) => {
        const tokenHash = hashShareToken(body.token);
        if (!tokenHash) {
            return notFound('反馈链接无效或已过期');
        }

        const learner = await prisma.learner.findFirst({
            where: {
                id: body.learnerId,
                userId: user.id,
                kind: LEARNER_KIND.child,
                archivedAt: null,
            },
            select: { id: true, name: true },
        });
        if (!learner) {
            return notFound('未找到该孩子档案');
        }

        const submission = await prisma.gradingSubmission.findFirst({
            where: { shareTokenHash: tokenHash },
            include: {
                task: true,
                results: {
                    include: { keyQuestion: true },
                    orderBy: { keyQuestion: { order: 'asc' } },
                },
            },
        });
        if (!submission || (submission.shareExpiresAt && submission.shareExpiresAt.getTime() < Date.now())) {
            return notFound('反馈链接无效或已过期');
        }

        const wrongResults = submission.results.filter((res) => isWrong(res.verdict));
        if (wrongResults.length === 0) {
            return NextResponse.json({ importedCount: 0, skippedCount: 0, learnerId: learner.id });
        }

        const pages = parseJsonStringArray(submission.images);
        const croppedMap = new Map<string, string>();
        await Promise.all(
            wrongResults.map(async (res) => {
                const img = await resolveCroppedGradingItemImage(pages, res.bbox);
                croppedMap.set(res.id, img || pages[0] || '');
            }),
        );

        const subjectName = submission.task.subjectName || '数学';
        const inferredKey = inferSubjectFromName(subjectName);
        const tagSubjectKey = inferredKey || 'other';

        const resultSummary = await prisma.$transaction(async (tx) => {
            const notebook = await tx.subject.upsert({
                where: { name_userId: { name: subjectName, userId: user.id } },
                update: {},
                create: {
                    name: subjectName,
                    userId: user.id,
                    stage: stageFromEducationStage(user.educationStage),
                    subjectKey: isNotebookSubject(inferredKey) ? inferredKey : null,
                },
                select: { id: true },
            });

            let importedCount = 0;
            let skippedCount = 0;

            for (const res of wrongResults) {
                const sourceQuestionId = `${learner.id}:${res.id}`;
                const existingImport = await tx.sourceImport.findUnique({
                    where: {
                        userId_sourceKind_sourceQuestionId: {
                            userId: user.id,
                            sourceKind: 'shared_submission',
                            sourceQuestionId,
                        },
                    },
                    select: { errorItemId: true },
                });
                if (existingImport) {
                    skippedCount += 1;
                    continue;
                }

                const kps = parseJsonStringArray(res.keyQuestion.knowledgePoints);
                const tagIds: Array<{ id: string }> = [];
                for (const kp of kps) {
                    const foundTag = await tx.knowledgeTag.findFirst({
                        where: {
                            name: kp,
                            subject: tagSubjectKey,
                            OR: [{ isSystem: true }, { userId: user.id }],
                        },
                        select: { id: true },
                    });
                    const tag = foundTag || await tx.knowledgeTag.create({
                        data: { name: kp, subject: tagSubjectKey, isSystem: false, userId: user.id },
                        select: { id: true },
                    });
                    tagIds.push({ id: tag.id });
                }

                const noteParts = [submission.teacherComment, res.comment].filter(Boolean);
                const createdItem = await tx.errorItem.create({
                    data: {
                        shortId: await generateUniqueShortId(tx),
                        userId: user.id,
                        learnerId: learner.id,
                        subjectId: notebook.id,
                        originalImageUrl: croppedMap.get(res.id) || '',
                        questionText: res.keyQuestion.questionText || `（${submission.task.title} 第 ${res.keyQuestion.number} 题）`,
                        answerText: res.keyQuestion.answer,
                        wrongAnswerText: res.studentAnswer || null,
                        mistakeAnalysis: res.reason || null,
                        mistakeStatus: res.verdict === 'blank' ? 'not_attempted' : 'wrong_attempt',
                        source: submission.task.title,
                        userNotes: noteParts.length > 0 ? noteParts.join(' · ') : null,
                        ...(tagIds.length > 0 ? { tags: { connect: tagIds } } : {}),
                    },
                    select: { id: true },
                });

                await tx.sourceImport.create({
                    data: {
                        userId: user.id,
                        sourceKind: 'shared_submission',
                        sourceId: submission.id,
                        sourceQuestionId,
                        errorItemId: createdItem.id,
                    },
                });
                importedCount += 1;
            }

            return { importedCount, skippedCount };
        });

        return NextResponse.json({
            ...resultSummary,
            learnerId: learner.id,
        });
    },
);
