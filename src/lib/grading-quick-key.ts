import type { Prisma, PrismaClient } from "@prisma/client";
import { getAIService } from "@/lib/ai";
import { splitDataUrl } from "@/lib/ai/exam-paper-read";
import { MAX_GRADING_QUESTIONS, type KeyQuestionInput } from "@/lib/grading";
import { runBoundedConcurrency } from "@/lib/grading-bbox-and-pool";
import { withBridgeMutex } from "@/lib/grading-share-tokens";
import { ensureLearnerForGradingStudent } from "@/lib/learners";
import { createLogger } from "@/lib/logger";

type Db = PrismaClient | Prisma.TransactionClient;

const logger = createLogger("grading-quick-key");

export const DEFAULT_QUICK_CLASS_NAME = "随堂速批班";

function hasTransactionSupport(db: Db): boolean {
    return "$transaction" in db && typeof (db as PrismaClient).$transaction === "function";
}

function isUniqueConstraintError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002";
}

/**
 * 免花名册开箱即用：当老师尚未创建任何班级便直接发起「随堂速批」时，自动创建或复用默认随堂班级。
 */
export async function ensureDefaultQuickClass(db: Db, userId: string): Promise<{ id: string; name: string }> {
    const run = async () => {
        const existing = await db.gradingClass.findFirst({
            where: { userId, name: DEFAULT_QUICK_CLASS_NAME },
            select: { id: true, name: true },
        });
        if (existing) return existing;
        try {
            return await db.gradingClass.create({
                data: { userId, name: DEFAULT_QUICK_CLASS_NAME },
                select: { id: true, name: true },
            });
        } catch (error) {
            if (isUniqueConstraintError(error)) {
                const retry = await db.gradingClass.findFirst({
                    where: { userId, name: DEFAULT_QUICK_CLASS_NAME },
                    select: { id: true, name: true },
                });
                if (retry) return retry;
            }
            throw error;
        }
    };
    return hasTransactionSupport(db) ? withBridgeMutex(`quick-class:${userId}`, run) : run();
}

/**
 * 随堂速批免名册自动建档：当卷头识别出清晰姓名但在任务班级花名册中不存在时，自动补建该生与 Learner。
 * 严格按姓名+学号隔离查找，严禁用跨人 OR 把不同学生误合并。
 */
export async function ensureQuickStudentInClass(
    db: Db,
    options: { userId: string; classId: string; studentName: string; studentNo?: string | null },
): Promise<{ id: string; name: string }> {
    const cleanName = options.studentName.trim().slice(0, 50);
    let cleanNo = options.studentNo?.trim().slice(0, 30) || null;

    const run = async () => {
        const existingExact = await db.gradingStudent.findFirst({
            where: {
                classId: options.classId,
                name: cleanName,
                ...(cleanNo ? { studentNo: cleanNo } : {}),
            },
            select: { id: true, name: true },
        });
        if (existingExact) return existingExact;

        if (cleanNo) {
            // 若该学号已被同班另一姓名学生占用，则剥离冲突学号独立建档以免触发 P2002 或错并档案
            const noTakenByOther = await db.gradingStudent.findFirst({
                where: { classId: options.classId, studentNo: cleanNo },
                select: { id: true },
            });
            if (noTakenByOther) {
                cleanNo = null;
            }
        }

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
    };

    return hasTransactionSupport(db) ? withBridgeMutex(`quick-student:${options.classId}`, run) : run();
}

const CHOICE_ANSWER_PREFIX_RE = /^(?:选择|选|正确答案(?:是|为)?|答案(?:是|为)?|故选|choose|answer\s*(?:is|:)?)\s*[\[(（]?([A-Ha-h]{1,6})[\])）]?[.。!！\s]*$/i;

function normalizeInferredAnswer(rawAnswer: string, isLikelyChoice: boolean): string {
    const trimmed = rawAnswer.trim();
    if (!trimmed) return "";
    const prefixMatch = trimmed.match(CHOICE_ANSWER_PREFIX_RE);
    if (prefixMatch && (isLikelyChoice || prefixMatch[0].length > prefixMatch[1].length)) {
        return prefixMatch[1].toUpperCase();
    }
    if (/^[A-Ha-h]$/.test(trimmed)) {
        return trimmed.toUpperCase();
    }
    if (isLikelyChoice && /^[A-Ha-h]{1,6}$/.test(trimmed)) {
        return trimmed.toUpperCase();
    }
    return trimmed;
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
        images: images.slice(0, 8).map((img) => splitDataUrl(img)),
        language,
    });

    const rawQuestions = visionRead.questions.slice(0, MAX_GRADING_QUESTIONS);
    const inferred: Array<KeyQuestionInput & { answerSource: "ai_inferred" }> = new Array(rawQuestions.length);

    await runBoundedConcurrency(rawQuestions, 3, async (q, index) => {
        const stem = q.questionText?.trim() || "";
        const isLikelyChoice = q.type !== "subjective"
            && (/^[A-Ha-h]{1,6}$/.test(q.answer?.trim() || "") || /[A-D][.、．)\s]/.test(stem));
        let reliableAnswer = normalizeInferredAnswer(q.answer || "", isLikelyChoice);
        if (stem) {
            try {
                const promptText = isLikelyChoice
                    ? (language === "en"
                        ? `${stem}\n(For multiple-choice, reply with option letters only, e.g. B or AC.)`
                        : `${stem}\n（若为选择题请只输出大写选项字母，例如 B 或 AC，不要附带解释文字）`)
                    : stem;
                const solved = await getAIService("text").reanswerQuestion(promptText, language, subjectName);
                const normalized = normalizeInferredAnswer(solved.answerText || "", isLikelyChoice);
                if (normalized) {
                    reliableAnswer = normalized;
                }
            } catch (error) {
                logger.warn({ number: q.number, error }, "Text model independent solving failed, falling back to vision draft");
            }
        }
        inferred[index] = {
            number: q.number,
            type: q.type === "subjective" ? "subjective" : "objective",
            maxScore: q.maxScore && q.maxScore > 0 ? q.maxScore : (q.type === "subjective" ? 5 : 2),
            answer: reliableAnswer,
            answerSource: "ai_inferred",
            questionText: stem || null,
            knowledgePoints: (q.knowledgePoints || []).map((p) => p.trim()).filter(Boolean).slice(0, 5),
        };
    });

    return inferred;
}
