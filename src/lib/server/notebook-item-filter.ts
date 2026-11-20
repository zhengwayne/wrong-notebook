import { notFound } from '@/lib/api-errors';
import { LearnerNotFoundError } from '@/lib/learners';
import { resolveLearningScope } from '@/lib/learning-scope';
import { prisma } from '@/lib/prisma';
import { getKidModeLearnerId } from '@/lib/server/request-context';

/** 错题本计数、题目列表和打印共用同一范围。专注锁优先于请求中的班级和学习者。 */
export async function resolveNotebookItemFilter(userId: string, params: URLSearchParams) {
    const lockedLearnerId = getKidModeLearnerId();
    const learnerId = lockedLearnerId ?? params.get('learnerId')?.trim();
    const classId = lockedLearnerId ? null : params.get('classId')?.trim();
    if (classId) {
        const roster = await prisma.gradingClass.findFirst({
            where: { id: classId, userId },
            select: { students: { select: { learner: { select: { id: true } } } } },
        });
        if (!roster) return notFound('Class not found');
        const ids = roster.students.flatMap(({ learner }) => learner ? [learner.id] : []);
        if (!learnerId) return { learnerId: { in: ids } };
        if (!ids.includes(learnerId)) return notFound('Learner not found');
    }
    if (!learnerId) return {};
    try {
        const scope = await resolveLearningScope(prisma, userId, learnerId);
        return { learnerId: scope.learnerId };
    } catch (error) {
        if (error instanceof LearnerNotFoundError) return notFound('Learner not found');
        throw error;
    }
}
