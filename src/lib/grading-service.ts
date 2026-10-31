/**
 * 收卷改卷的数据库与 AI 编排：读卷判分、确认后导入错题本、从已有试卷生成答案。
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAIService } from "@/lib/ai";
import { splitDataUrl } from "@/lib/ai/exam-paper-read";
import { createLogger } from "@/lib/logger";
import { getErrorMessage } from "@/lib/error-message";
import { generateUniqueShortId } from "@/lib/short-id";
import { inferSubjectFromName } from "@/lib/knowledge-tags";
import { isNotebookSubject, stageFromEducationStage } from "@/lib/notebook-scope";
import {
    gradeAnswers, isWrong, matchStudentByName, parseJsonStringArray, totalScore,
    MAX_GRADING_QUESTIONS,
} from "@/lib/grading";
import type { KeyQuestion, KeyQuestionInput } from "@/lib/grading";

const logger = createLogger('grading');

type KeyQuestionRow = {
    id: string; order: number; number: string; type: string; maxScore: number; answer: string;
    acceptedAnswers: string | null; questionText: string | null; knowledgePoints: string | null;
};

export function toKeyQuestion(row: KeyQuestionRow): KeyQuestion {
    return {
        id: row.id,
        order: row.order,
        number: row.number,
        type: row.type === 'subjective' ? 'subjective' : 'objective',
        maxScore: row.maxScore,
        answer: row.answer,
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
        acceptedAnswers: question.acceptedAnswers?.length ? JSON.stringify(question.acceptedAnswers) : null,
        questionText: question.questionText?.trim() || null,
        knowledgePoints: question.knowledgePoints?.length ? JSON.stringify(question.knowledgePoints) : null,
    };
}

/** 拍照识别答案卷，返回可编辑的题目清单 */
export async function readAnswerKeyFromImages(images: string[], language: 'zh' | 'en'): Promise<KeyQuestionInput[]> {
    const result = await getAIService().readExamPaper({
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

/**
 * 读卷判分：AI 转写作答并给主观题建议分，客观题本地比对。
 * 未指定学生时尝试按卷面姓名匹配花名册。失败时记录错误，老师可重试。
 */
export async function gradeSubmission(submissionId: string, language: 'zh' | 'en' = 'zh'): Promise<void> {
    const submission = await prisma.gradingSubmission.findUnique({
        where: { id: submissionId },
        include: { task: { include: { questions: { orderBy: { order: 'asc' } }, class: { include: { students: true } } } } },
    });
    if (!submission) return;
    const questions = submission.task.questions.map(toKeyQuestion);
    await prisma.gradingSubmission.update({ where: { id: submissionId }, data: { status: 'grading', error: null } });

    try {
        const images = parseJsonStringArray(submission.images);
        const read = await getAIService().readExamPaper({
            mode: 'student',
            images: images.map((image) => splitDataUrl(image)),
            questions: questions.map(({ number, type, maxScore, answer, questionText }) => ({ number, type, maxScore, answer, questionText })),
            language,
        });
        const graded = gradeAnswers(questions, read.questions);
        const studentId = submission.studentId || matchStudentByName(read.studentName, submission.task.class.students);

        await prisma.$transaction([
            prisma.gradingResult.deleteMany({ where: { submissionId } }),
            prisma.gradingResult.createMany({ data: graded.map((result) => ({ ...result, submissionId })) }),
            prisma.gradingSubmission.update({
                where: { id: submissionId },
                data: { status: 'graded', totalScore: totalScore(graded), detectedName: read.studentName, studentId, error: null },
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

/** 在后台依次判分，避免一次拍几十张卷时同时占满 AI 并发 */
export function scheduleGrading(submissionIds: string[], language: 'zh' | 'en'): void {
    void (async () => {
        for (const id of submissionIds) {
            await gradeSubmission(id, language);
        }
    })().catch((error) => logger.error({ error }, '后台判分异常'));
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
        const existing = await tx.knowledgeTag.findFirst({ where: { name, OR: [{ isSystem: true }, { userId }] }, select: { id: true } });
        const tag = existing || await tx.knowledgeTag.create({ data: { name, subject: subjectKey, isSystem: false, userId }, select: { id: true } });
        ids.push({ id: tag.id });
    }
    return ids;
}

/**
 * 老师确认答卷：把未得满分的题导入该学生的错题本（老师账户下名为「学生名·学科」的错题本），
 * 复用错题的知识点标签；已导入的题不会重复导入。
 */
export async function confirmSubmission(submissionId: string, userId: string): Promise<{ importedCount: number } | null> {
    const submission = await prisma.gradingSubmission.findFirst({
        where: { id: submissionId, task: { userId } },
        include: { task: true, student: true, results: { include: { keyQuestion: true } } },
    });
    if (!submission) return null;
    if (!submission.student) throw new Error('STUDENT_REQUIRED');

    const studentName = submission.student.name;
    const { task } = submission;
    const firstImage = parseJsonStringArray(submission.images)[0] || '';
    const subjectKey = inferSubjectFromName(task.subjectName) || 'other';

    const imported = await prisma.$transaction(async (tx) => {
        const notebook = await resolveStudentNotebook(tx, userId, `${studentName}·${task.subjectName}`, task.subjectName);
        let count = 0;
        for (const result of submission.results) {
            if (!isWrong(result.verdict) || result.errorItemId) continue;
            const question = toKeyQuestion(result.keyQuestion);
            const tags = await resolveTags(tx, userId, question.knowledgePoints || [], subjectKey);
            const item = await tx.errorItem.create({
                data: {
                    shortId: await generateUniqueShortId(tx),
                    userId,
                    subjectId: notebook.id,
                    originalImageUrl: firstImage,
                    questionText: question.questionText || `${task.title} 第 ${question.number} 题`,
                    answerText: question.answer || null,
                    wrongAnswerText: result.studentAnswer || null,
                    mistakeAnalysis: result.reason || null,
                    mistakeStatus: result.verdict === 'blank' || !result.studentAnswer ? 'not_attempted' : 'wrong_attempt',
                    knowledgePoints: JSON.stringify(question.knowledgePoints || []),
                    source: task.title,
                    userNotes: `${studentName}：${result.score}/${question.maxScore}`,
                    masteryLevel: 0,
                    tags: { connect: tags },
                },
                select: { id: true },
            });
            await tx.gradingResult.update({ where: { id: result.id }, data: { errorItemId: item.id } });
            count += 1;
        }
        await tx.gradingSubmission.update({
            where: { id: submissionId },
            data: { status: 'confirmed', confirmedAt: new Date(), importedCount: { increment: count } },
        });
        return count;
    });
    return { importedCount: imported };
}
