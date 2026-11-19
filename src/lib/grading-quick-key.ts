import type { Prisma, PrismaClient } from "@prisma/client";
import { getAIService } from "@/lib/ai";
import { splitDataUrl } from "@/lib/ai/exam-paper-read";
import { MAX_GRADING_QUESTIONS, type KeyQuestionInput } from "@/lib/grading";
import { ensureLearnerForGradingStudent } from "@/lib/learners";
import { createLogger } from "@/lib/logger";

type Db = PrismaClient | Prisma.TransactionClient;

const logger = createLogger("grading-quick-key");

export const DEFAULT_QUICK_CLASS_NAME = "随堂速批班";

/**
 * 免花名册开箱即用：当老师尚未创建任何班级便直接发起「随堂速批」时，自动创建或复用默认随堂班级。
 */
export async function ensureDefaultQuickClass(db: Db, userId: string): Promise<{ id: string; name: string }> {
    const existing = await db.gradingClass.findFirst({
        where: { userId, name: DEFAULT_QUICK_CLASS_NAME },
        select: { id: true, name: true },
    });
    if (existing) return existing;
    return db.gradingClass.create({
        data: { userId, name: DEFAULT_QUICK_CLASS_NAME },
        select: { id: true, name: true },
    });
}

/**
 * 随堂速批免名册自动建档：当卷头识别出清晰姓名但在任务班级花名册中不存在时，自动补建该生与 Learner。
 */
export async function ensureQuickStudentInClass(
    db: Db,
    options: { userId: string; classId: string; studentName: string; studentNo?: string | null },
): Promise<{ id: string; name: string }> {
    const cleanName = options.studentName.trim().slice(0, 50);
    const cleanNo = options.studentNo?.trim().slice(0, 30) || null;
    const existing = await db.gradingStudent.findFirst({
        where: {
            classId: options.classId,
            ...(cleanNo ? { OR: [{ studentNo: cleanNo }, { name: cleanName }] } : { name: cleanName }),
        },
        select: { id: true, name: true },
    });
    if (existing) return existing;

    const count = await db.gradingStudent.count({ where: { classId: options.classId } });
    const created = await db.gradingStudent.create({
        data: {
            classId: options.classId,
            name: cleanName,
            studentNo: cleanNo,
            order: count,
        },
        select: { id: true, name: true },
    });
    await ensureLearnerForGradingStudent(db, {
        userId: options.userId,
        gradingStudentId: created.id,
        name: created.name,
    });
    return created;
}

/**
 * 随堂无答案速批「三段解耦防幻觉流水线」：
 * 1) Vision 仅提取样本卷上的题号、题干文本、题型与分值（忽略页面上可能错误的学生手写作答）；
 * 2) Text 模型基于纯题干独立推演正确答案；
 * 3) 生成带 answerSource: 'ai_inferred' 标记的题目清单供并发判分与老师一键固化。
 */
export async function inferAnswerKeyFromSampleImages(
    images: string[],
    subjectName: string,
    language: "zh" | "en" = "zh",
): Promise<Array<KeyQuestionInput & { answerSource: "ai_inferred" }>> {
    const visionRead = await getAIService("vision").readExamPaper({
        mode: "answer_key",
        images: images.slice(0, 4).map((img) => splitDataUrl(img)),
        language,
    });

    const rawQuestions = visionRead.questions.slice(0, MAX_GRADING_QUESTIONS);
    const inferred: Array<KeyQuestionInput & { answerSource: "ai_inferred" }> = [];

    for (const q of rawQuestions) {
        const stem = q.questionText?.trim() || "";
        let reliableAnswer = q.answer?.trim() || "";
        if (stem) {
            try {
                const solved = await getAIService("text").reanswerQuestion(stem, language, subjectName);
                if (solved.answerText.trim()) {
                    reliableAnswer = solved.answerText.trim();
                }
            } catch (error) {
                logger.warn({ number: q.number, error }, "Text model independent solving failed, falling back to vision draft");
            }
        }
        inferred.push({
            number: q.number,
            type: q.type === "subjective" ? "subjective" : "objective",
            maxScore: q.maxScore && q.maxScore > 0 ? q.maxScore : (q.type === "subjective" ? 5 : 2),
            answer: reliableAnswer,
            answerSource: "ai_inferred",
            questionText: stem || null,
            knowledgePoints: (q.knowledgePoints || []).map((p) => p.trim()).filter(Boolean).slice(0, 5),
        });
    }

    return inferred;
}
