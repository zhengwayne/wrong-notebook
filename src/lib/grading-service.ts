/**
 * 收卷改卷的数据库与 AI 编排：读卷判分、确认后导入错题本、从已有试卷生成答案。
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAIService } from "@/lib/ai";
import { splitDataUrl } from "@/lib/ai/exam-paper-read";
import { recordAiProvenance } from "@/lib/ai/provenance";
import { createLogger } from "@/lib/logger";
import { getErrorMessage } from "@/lib/error-message";
import { generateUniqueShortId } from "@/lib/short-id";
import { inferSubjectFromName } from "@/lib/knowledge-tags";
import { isNotebookSubject, stageFromEducationStage } from "@/lib/notebook-scope";
import { ensureLearnerForGradingStudent } from "@/lib/learners";
import { DEFAULT_GRADING_CONCURRENCY, resolveCroppedGradingItemImage, runBoundedConcurrency } from "@/lib/grading-bbox-and-pool";
import { ensureQuickStudentInClass, inferAnswerKeyFromSampleImages } from "@/lib/grading-quick-key";
import { computeSubmissionBucket } from "@/lib/grading-triage";
import {
    gradeAnswers, isWrong, parseJsonStringArray, totalScore,
    MAX_GRADING_QUESTIONS,
} from "@/lib/grading";
import type { AnswerSourceKind, KeyQuestion, KeyQuestionInput } from "@/lib/grading";
import { flagDuplicate, hasIdentity, matchStudent, type MatchResult, type PaperIdentity, type RosterStudent } from "@/lib/student-match";

const logger = createLogger('grading');

type KeyQuestionRow = {
    id: string; order: number; number: string; type: string; maxScore: number; answer: string;
    answerSource?: string;
    acceptedAnswers: string | null; questionText: string | null; knowledgePoints: string | null;
};

export function toKeyQuestion(row: KeyQuestionRow): KeyQuestion {
    const validSource = (['manual', 'exam_paper', 'key_image', 'ai_inferred'] as const).includes(row.answerSource as AnswerSourceKind)
        ? (row.answerSource as AnswerSourceKind)
        : 'manual';
    return {
        id: row.id,
        order: row.order,
        number: row.number,
        type: row.type === 'subjective' ? 'subjective' : 'objective',
        maxScore: row.maxScore,
        answer: row.answer,
        answerSource: validSource,
        acceptedAnswers: parseJsonStringArray(row.acceptedAnswers),
        questionText: row.questionText,
        knowledgePoints: parseJsonStringArray(row.knowledgePoints),
    };
}

/** 题目输入转为数据库字段 */
export function keyQuestionData(question: KeyQuestionInput, order: number) {
    return {
        order,
        number: question.number.trim(),
        type: question.type,
        maxScore: question.maxScore,
        answer: question.answer.trim(),
        answerSource: question.answerSource ?? 'manual',
        acceptedAnswers: question.acceptedAnswers?.length ? JSON.stringify(question.acceptedAnswers) : null,
        questionText: question.questionText?.trim() || null,
        knowledgePoints: question.knowledgePoints?.length ? JSON.stringify(question.knowledgePoints) : null,
    };
}

/** 拍照识别答案卷，返回可编辑的题目清单 */
export async function readAnswerKeyFromImages(images: string[], language: 'zh' | 'en'): Promise<KeyQuestionInput[]> {
    const result = await getAIService('vision').readExamPaper({
        mode: 'answer_key',
        images: images.map((image) => splitDataUrl(image)),
        language,
    });
    return result.questions.slice(0, MAX_GRADING_QUESTIONS).map((question) => ({
        number: question.number,
        type: question.type === 'subjective' ? 'subjective' : 'objective',
        maxScore: question.maxScore && question.maxScore > 0 ? question.maxScore : 1,
        answer: question.answer.trim(),
        questionText: question.questionText?.trim() || null,
        knowledgePoints: (question.knowledgePoints || []).map((point) => point.trim()).filter(Boolean).slice(0, 5),
    }));
}

/** 用应用内已生成的试卷作为答案：短答案按客观题，长答案按主观题 */
export async function buildKeyFromExam(examPaperId: string, userId: string): Promise<KeyQuestionInput[] | null> {
    const paper = await prisma.examPaper.findFirst({
        where: { id: examPaperId, userId },
        include: { questions: { orderBy: { order: 'asc' }, include: { errorItem: { select: { tags: { select: { name: true } } } } } } },
    });
    if (!paper) return null;
    return paper.questions.map((question, index) => {
        const answer = (question.answerText || '').trim();
        const objective = answer.length > 0 && answer.length <= 20 && !answer.includes('\n');
        return {
            number: String(index + 1),
            type: objective ? 'objective' : 'subjective',
            maxScore: objective ? 1 : 5,
            answer,
            questionText: question.questionText,
            knowledgePoints: question.errorItem?.tags.map((tag) => tag.name) || [],
        };
    });
}

/** 本次收卷涉及的所有班级（主班级 + 一起收卷的班级） */
export function taskClassIds(task: { classId: string; extraClassIds: string | null }): string[] {
    return [...new Set([task.classId, ...parseJsonStringArray(task.extraClassIds)])];
}

/** 本次收卷的花名册（只取属于该老师的班级） */
export async function loadTaskRoster(task: { classId: string; extraClassIds: string | null; userId: string }): Promise<RosterStudent[]> {
    const students = await prisma.gradingStudent.findMany({
        where: { classId: { in: taskClassIds(task) }, class: { userId: task.userId } },
        orderBy: [{ class: { createdAt: 'asc' } }, { order: 'asc' }],
        include: { class: { select: { name: true } } },
    });
    return students.map((student) => ({ id: student.id, name: student.name, studentNo: student.studentNo, classId: student.classId, className: student.class.name }));
}

/** 任务中已有答卷的学生（排除指定答卷） */
export async function takenStudentIds(taskId: string, excludeSubmissionId?: string): Promise<Set<string>> {
    const rows = await prisma.gradingSubmission.findMany({
        where: { taskId, studentId: { not: null }, ...(excludeSubmissionId ? { id: { not: excludeSubmissionId } } : {}) },
        select: { studentId: true },
    });
    return new Set(rows.map((row) => row.studentId!).filter(Boolean));
}

/** 匹配结果写入答卷的字段 */
export function matchData(identity: PaperIdentity, result: MatchResult) {
    return {
        detectedName: identity.name?.trim() || null,
        detectedClass: identity.className?.trim() || null,
        detectedStudentNo: identity.studentNo?.trim() || null,
        studentId: result.status === 'matched' ? result.studentId : null,
        matchStatus: result.status === 'matched' ? 'auto' : 'review',
        matchConfidence: result.confidence,
        matchReason: JSON.stringify({ code: result.reason, studentNoUnmatched: !!result.studentNoUnmatched }),
        matchCandidates: JSON.stringify(result.candidates),
    };
}

/** 按卷面身份匹配学生并检查是否与其他答卷重复 */
export function resolveMatch(identity: PaperIdentity, roster: RosterStudent[], taken: Set<string>) {
    return matchData(identity, flagDuplicate(matchStudent(identity, roster), taken));
}

/**
 * 读卷判分：AI 转写作答并给主观题建议分，客观题本地比对。
 * 尚未确定学生（非老师指定、非已自动匹配）时按卷头班级、学号、姓名匹配花名册。失败时记录错误，老师可重试。
 */
export async function gradeSubmission(submissionId: string, language: 'zh' | 'en' = 'zh'): Promise<void> {
    const submission = await prisma.gradingSubmission.findUnique({
        where: { id: submissionId },
        include: { task: { include: { questions: { orderBy: { order: 'asc' } } } } },
    });
    if (!submission) return;
    let questions = submission.task.questions.map(toKeyQuestion);
    await prisma.gradingSubmission.update({ where: { id: submissionId }, data: { status: 'grading', error: null } });

    try {
        const images = parseJsonStringArray(submission.images);
        // 随堂无答案速批模式：若当前任务尚无标准答案，用首份样本卷三段解耦推导标准答案并落库复用
        if (questions.length === 0 && submission.task.taskMode === 'quick' && images.length > 0) {
            const inferred = await inferAnswerKeyFromSampleImages(images, submission.task.subjectName, language);
            if (inferred.length > 0) {
                await prisma.$transaction(async (tx) => {
                    const existingCount = await tx.gradingKeyQuestion.count({ where: { taskId: submission.taskId } });
                    if (existingCount === 0) {
                        await tx.gradingKeyQuestion.createMany({
                            data: inferred.map((qItem, idx) => ({
                                taskId: submission.taskId,
                                ...keyQuestionData(qItem, idx),
                            })),
                        });
                    }
                });
                const refreshed = await prisma.gradingKeyQuestion.findMany({
                    where: { taskId: submission.taskId },
                    orderBy: { order: 'asc' },
                });
                questions = refreshed.map(toKeyQuestion);
            }
        }
        const read = await getAIService('vision').readExamPaper({
            mode: 'student',
            images: images.map((image) => splitDataUrl(image)),
            questions: questions.map(({ number, type, maxScore, answer, questionText }) => ({ number, type, maxScore, answer, questionText })),
            language,
        });
        const graded = gradeAnswers(questions, read.questions);
        // 已由老师指定或已自动匹配的不再改动；否则用拍照时识别的身份，缺失的字段用整卷读出的补上
        let identityData: Record<string, unknown> = {};
        if (!submission.studentId && submission.matchStatus !== 'manual') {
            const identity: PaperIdentity = {
                className: submission.detectedClass || read.className,
                studentNo: submission.detectedStudentNo || read.studentNo,
                name: submission.detectedName || read.studentName,
            };
            if (hasIdentity(identity) || submission.matchStatus === null) {
                const roster = await loadTaskRoster(submission.task);
                identityData = resolveMatch(identity, roster, await takenStudentIds(submission.taskId, submissionId));
                // 随堂速批免花名册模式：若姓名清晰但花名册中无此学生，自动在任务班级补建学生档案
                if (!identityData.studentId && submission.task.taskMode === 'quick' && identity.name?.trim()) {
                    const createdStu = await ensureQuickStudentInClass(prisma, {
                        userId: submission.task.userId,
                        classId: submission.task.classId,
                        studentName: identity.name,
                        studentNo: identity.studentNo,
                    });
                    identityData = {
                        ...identityData,
                        studentId: createdStu.id,
                        matchStatus: 'auto',
                        matchConfidence: 0.92,
                    };
                }
            }
        }

        const provenanceId = await recordAiProvenance(prisma, { task: 'grade', role: 'vision' });
        const appearance = read.paperAppearance;
        const appearanceData = appearance ? {
            ...(submission.handwritingLevel ? {} : { handwritingLevel: appearance.handwritingLevel }),
            ...(submission.neatnessLevel ? {} : { neatnessLevel: appearance.neatnessLevel }),
            ...(submission.attitudeLevel ? {} : { attitudeLevel: appearance.attitudeLevel }),
            visualAlerts: appearance.visualAlerts.length > 0 ? JSON.stringify(appearance.visualAlerts) : null,
        } : {};

        const finalStudentId = (identityData.studentId as string | null | undefined) !== undefined
            ? (identityData.studentId as string | null)
            : submission.studentId;
        const finalMatchStatus = (identityData.matchStatus as string | null | undefined) !== undefined
            ? (identityData.matchStatus as string | null)
            : submission.matchStatus;
        const finalMatchConfidence = (identityData.matchConfidence as number | null | undefined) !== undefined
            ? (identityData.matchConfidence as number | null)
            : submission.matchConfidence;
        const questionTypeById = new Map(questions.map((qItem) => [qItem.id, qItem.type]));
        const reviewBucket = computeSubmissionBucket({
            studentId: finalStudentId,
            matchStatus: finalMatchStatus,
            matchConfidence: finalMatchConfidence,
            visualAlertsCount: appearance?.visualAlerts.length ?? 0,
            results: graded.map((res) => ({
                type: questionTypeById.get(res.keyQuestionId) || 'objective',
                verdict: res.verdict,
                confidence: res.confidence,
            })),
        });

        await prisma.$transaction([
            prisma.gradingResult.deleteMany({ where: { submissionId } }),
            prisma.gradingResult.createMany({ data: graded.map((result) => ({ ...result, submissionId, provenanceId })) }),
            prisma.gradingSubmission.update({
                where: { id: submissionId },
                data: { status: 'graded', reviewBucket, totalScore: totalScore(graded), error: null, ...identityData, ...appearanceData },
            }),
        ]);
        logger.info({ submissionId, questionCount: graded.length }, '答卷判分完成');
    } catch (error) {
        logger.error({ error, submissionId }, '答卷判分失败');
        await prisma.gradingSubmission.update({
            where: { id: submissionId },
            data: { status: 'failed', error: getErrorMessage(error).slice(0, 500) },
        });
    }
}

/** 在后台按有界并发池（默认 3 路）判分，大幅缩短全班几十份试卷的等待时间且受控不打满并发 */
export function scheduleGrading(submissionIds: string[], language: 'zh' | 'en'): void {
    void runBoundedConcurrency(submissionIds, DEFAULT_GRADING_CONCURRENCY, async (id) => {
        await gradeSubmission(id, language);
    }).catch((error) => logger.error({ error }, '后台判分异常'));
}

async function resolveStudentNotebook(tx: Prisma.TransactionClient, userId: string, name: string, subjectName: string) {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { educationStage: true } });
    const subjectKey = inferSubjectFromName(subjectName);
    return tx.subject.upsert({
        where: { name_userId: { name, userId } },
        update: {},
        create: {
            name,
            userId,
            stage: stageFromEducationStage(user?.educationStage),
            subjectKey: isNotebookSubject(subjectKey) ? subjectKey : null,
        },
        select: { id: true },
    });
}

async function resolveTags(tx: Prisma.TransactionClient, userId: string, names: string[], subjectKey: string) {
    const ids: { id: string }[] = [];
    for (const name of names) {
        const existing = await tx.knowledgeTag.findFirst({ where: { name, subject: subjectKey, OR: [{ isSystem: true }, { userId }] }, select: { id: true } });
        const tag = existing || await tx.knowledgeTag.create({ data: { name, subject: subjectKey, isSystem: false, userId }, select: { id: true } });
        ids.push({ id: tag.id });
    }
    return ids;
}

/**
 * 老师确认答卷：把未得满分的题导入该学生的错题本（老师账户下名为「学生名·学科」的错题本），
 * 复用错题的知识点标签；已导入的题不会重复导入。
 */
export async function confirmSubmission(
    submissionId: string,
    userId: string,
    options?: { expectedVersion?: number },
): Promise<{ importedCount: number } | null> {
    const submission = await prisma.gradingSubmission.findFirst({
        where: { id: submissionId, task: { userId } },
        include: { task: true, student: true, results: { include: { keyQuestion: true } } },
    });
    if (!submission) return null;
    if (!submission.student) throw new Error('STUDENT_REQUIRED');
    if (submission.status === 'grading' || submission.status === 'failed') {
        throw new Error('SUBMISSION_LOCKED');
    }
    if (options?.expectedVersion !== undefined && options.expectedVersion !== submission.version) {
        throw new Error('VERSION_CONFLICT');
    }
    if (submission.status === 'confirmed') {
        return { importedCount: 0 };
    }

    const snapshotVersion = submission.version;
    const studentName = submission.student.name;
    const { task } = submission;
    const pages = parseJsonStringArray(submission.images);
    const firstImage = pages[0] || '';
    const subjectKey = inferSubjectFromName(task.subjectName) || 'other';

    // 在数据库写事务之外预先按单题 bbox 裁出清晰单题图，避免图像解码阻塞 SQLite 写锁
    const croppedImageByResultId = new Map<string, string>();
    await Promise.all(
        submission.results
            .filter((res) => isWrong(res.verdict) && !res.errorItemId)
            .map(async (res) => {
                const img = await resolveCroppedGradingItemImage(pages, res.bbox);
                croppedImageByResultId.set(res.id, img || firstImage);
            }),
    );

    const imported = await prisma.$transaction(async (tx) => {
        // 先用 status + version CAS 条件更新抢占确认所有权
        const claimed = await tx.gradingSubmission.updateMany({
            where: {
                id: submissionId,
                status: { notIn: ['confirmed', 'grading', 'failed'] },
                version: snapshotVersion,
            },
            data: {
                status: 'confirmed',
                confirmedAt: new Date(),
                version: { increment: 1 },
            },
        });
        if (claimed.count === 0) {
            const latest = await tx.gradingSubmission.findUnique({
                where: { id: submissionId },
                select: { status: true },
            });
            if (!latest) return null;
            if (latest.status === 'confirmed') return 0;
            if (latest.status === 'grading' || latest.status === 'failed') throw new Error('SUBMISSION_LOCKED');
            throw new Error('VERSION_CONFLICT');
        }

        const notebook = await resolveStudentNotebook(tx, userId, `${studentName}·${task.subjectName}`, task.subjectName);
        const learner = await ensureLearnerForGradingStudent(tx, {
            userId,
            gradingStudentId: submission.student!.id,
            name: studentName,
        });
        let count = 0;
        for (const result of submission.results) {
            if (!isWrong(result.verdict) || result.errorItemId) continue;

            const existingImport = await tx.sourceImport.findUnique({
                where: {
                    userId_sourceKind_sourceQuestionId: {
                        userId,
                        sourceKind: 'grading_submission',
                        sourceQuestionId: result.id,
                    },
                },
                select: { errorItemId: true },
            });
            if (existingImport) {
                await tx.gradingResult.update({ where: { id: result.id }, data: { errorItemId: existingImport.errorItemId } });
                continue;
            }

            const question = toKeyQuestion(result.keyQuestion);
            const tags = await resolveTags(tx, userId, question.knowledgePoints || [], subjectKey);
            const itemImageUrl = croppedImageByResultId.get(result.id) || firstImage;
            const noteParts = [`${studentName}：${result.score}/${question.maxScore}`];
            if (result.comment?.trim()) noteParts.push(result.comment.trim());
            if (submission.teacherComment?.trim()) noteParts.push(submission.teacherComment.trim());
            const item = await tx.errorItem.create({
                data: {
                    shortId: await generateUniqueShortId(tx),
                    userId,
                    learnerId: learner.id,
                    subjectId: notebook.id,
                    originalImageUrl: itemImageUrl,
                    questionText: question.questionText || `${task.title} 第 ${question.number} 题`,
                    answerText: question.answer || null,
                    wrongAnswerText: result.studentAnswer || null,
                    mistakeAnalysis: result.reason || null,
                    errorType: result.reason ? result.reason.slice(0, 80) : null,
                    mistakeStatus: result.verdict === 'blank' || !result.studentAnswer ? 'not_attempted' : 'wrong_attempt',
                    knowledgePoints: JSON.stringify(question.knowledgePoints || []),
                    source: task.title,
                    userNotes: noteParts.join(' ｜ '),
                    provenanceId: result.provenanceId ?? null,
                    masteryLevel: 0,
                    tags: { connect: tags },
                },
                select: { id: true },
            });
            await tx.sourceImport.create({
                data: {
                    userId,
                    sourceKind: 'grading_submission',
                    sourceId: submissionId,
                    sourceQuestionId: result.id,
                    errorItemId: item.id,
                },
            });
            await tx.gradingResult.update({ where: { id: result.id }, data: { errorItemId: item.id } });
            count += 1;
        }
        await tx.gradingSubmission.update({
            where: { id: submissionId },
            data: { importedCount: count },
        });
        return count;
    });
    if (imported === null) return null;
    return { importedCount: imported };
}
