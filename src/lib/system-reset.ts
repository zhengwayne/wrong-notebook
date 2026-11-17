import type { PrismaClient } from '@prisma/client';
import { clearAllBackgroundTasks } from '@/lib/background-tasks';
import { createLogger } from '@/lib/logger';
import { clearRecoverableResponses } from '@/lib/recoverable-response';
import { clearSpeechCache } from '@/lib/tts/speech-cache';

const logger = createLogger('system-reset');

export interface ResetAdminIdentity {
    id?: string | null;
    email?: string | null;
}

/**
 * 系统彻底重置（保留当前管理员账户和 isSystem = true 系统知识点树）：
 * 按外键依赖反序删除所有业务与审计表数据，并清理磁盘 TTS / 后台任务 / 断线恢复缓存。
 */
export async function performSystemReset(
    db: PrismaClient,
    currentAdmin: ResetAdminIdentity,
): Promise<{ preservedAdminId: string }> {
    let admin = currentAdmin.id
        ? await db.user.findUnique({ where: { id: currentAdmin.id }, select: { id: true } })
        : null;
    if (!admin && currentAdmin.email) {
        admin = await db.user.findUnique({ where: { email: currentAdmin.email }, select: { id: true } });
    }
    if (!admin) {
        throw new Error('ADMIN_USER_NOT_FOUND');
    }

    await db.$transaction(async (tx) => {
        // 1. 学习路径与掌握度
        await tx.learningPathStep.deleteMany({});
        await tx.learningPath.deleteMany({});
        await tx.knowledgeMastery.deleteMany({});

        // 2. 家长试卷
        await tx.parentPaperQuestion.deleteMany({});
        await tx.parentPaperPage.deleteMany({});
        await tx.parentPaper.deleteMany({});

        // 3. 教师拍照改卷与花名册
        await tx.gradingResult.deleteMany({});
        await tx.gradingSubmission.deleteMany({});
        await tx.gradingKeyQuestion.deleteMany({});
        await tx.gradingTask.deleteMany({});
        await tx.gradingStudent.deleteMany({});
        await tx.gradingClass.deleteMany({});

        // 4. 举一反三流水线记录
        await tx.variantStageLog.deleteMany({});
        await tx.variantItem.deleteMany({});
        await tx.variantRun.deleteMany({});

        // 5. 练习记录、复习计划、逐题记忆、随机试卷与错题
        await tx.practiceRecord.deleteMany({});
        await tx.reviewSchedule.deleteMany({});
        await tx.itemMemory.deleteMany({});
        await tx.examQuestion.deleteMany({});
        await tx.examPaper.deleteMany({});
        await tx.errorItem.deleteMany({});

        // 6. 学习者档案、回填审计、错题本、AI 用量与溯源
        await tx.learnerBackfillAudit.deleteMany({});
        await tx.learner.deleteMany({});
        await tx.subject.deleteMany({});
        await tx.aiUsage.deleteMany({});
        await tx.aiProvenance.deleteMany({});

        // 7. 清理非系统知识点标签，保留 isSystem = true 的系统知识点树
        await tx.knowledgeTag.updateMany({
            where: { isSystem: false },
            data: { parentId: null },
        });
        await tx.knowledgeTag.deleteMany({
            where: { isSystem: false },
        });

        // 8. 移除除当前管理员外的其余账户
        await tx.user.deleteMany({
            where: { id: { not: admin.id } },
        });
    }, { timeout: 60000 });

    clearAllBackgroundTasks();
    clearRecoverableResponses();
    try {
        await clearSpeechCache();
    } catch (error) {
        logger.warn({ error }, 'Failed to clear TTS cache directory during system reset');
    }

    return { preservedAdminId: admin.id };
}
