/**
 * 家长首页：按当前孩子查看薄弱点、今日任务、掌握情况与练习趋势。
 * 只使用该孩子 learnerId 下的错题和练习，不混入家长本人或其他孩子的数据。
 */
import { prisma } from '@/lib/prisma';
import { getAppTimeZone } from '@/lib/config';
import { LEARNER_KIND } from '@/lib/learners';
import { collectEvidence, getOrReplanPath } from '@/lib/learning-path/service';
import { buildWeaknessProfile } from '@/lib/variant/weakness-profile';
import { practiceTrendFromRecords, type PracticeTrendDay } from '@/lib/home-aggregates';
import { listParentPapers, type ParentPaperSummary } from '@/lib/parent-papers';

export interface ParentChildSummary {
    id: string;
    name: string;
    itemCount: number;
}

export interface ParentHomePayload {
    children: ParentChildSummary[];
    selectedLearnerId: string | null;
    child: {
        id: string;
        name: string;
        weakPoints: ReturnType<typeof buildWeaknessProfile>['weaknesses'];
        mastery: Array<{ knowledgePoint: string; score: number; evidenceCount: number; dueAt: string | null }>;
        today: NonNullable<Awaited<ReturnType<typeof getOrReplanPath>>>['path']['today'];
        pathId: string | null;
        practiceTrend: PracticeTrendDay[];
        practiceSummary: { attempted: number; correct: number };
        latestPaper: ParentPaperSummary | null;
    } | null;
}

export async function getParentHome(
    userId: string,
    learnerId: string | null | undefined,
    language: 'zh' | 'en',
): Promise<ParentHomePayload> {
    const children = await prisma.learner.findMany({
        where: { userId, kind: LEARNER_KIND.child, archivedAt: null },
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
        select: {
            id: true,
            name: true,
            _count: { select: { errorItems: true } },
        },
    });
    const summaries = children.map((child) => ({
        id: child.id,
        name: child.name,
        itemCount: child._count.errorItems,
    }));
    const selected = learnerId
        ? children.find((child) => child.id === learnerId) ?? null
        : (children[0] ?? null);
    if (!selected) {
        return { children: summaries, selectedLearnerId: learnerId && children.length ? null : (children[0]?.id ?? null), child: null };
    }

    const planned = await getOrReplanPath(userId, { studentKey: selected.id, language });
    const resolved = planned?.student ?? null;
    const profileItems = resolved ? (await collectEvidence(userId, resolved)).profileItems : [];
    const profile = buildWeaknessProfile(profileItems);

    const since = new Date();
    since.setDate(since.getDate() - 14);
    const records = await prisma.practiceRecord.findMany({
        where: { userId, learnerId: selected.id, createdAt: { gte: since } },
        select: { createdAt: true, result: true, isCorrect: true },
        orderBy: { createdAt: 'asc' },
    });
    const practiceTrend = practiceTrendFromRecords(records, { days: 14, timeZone: getAppTimeZone() });
    const attempted = practiceTrend.reduce((sum, day) => sum + day.attempted, 0);
    const correct = practiceTrend.reduce((sum, day) => sum + day.correct, 0);
    const papers = await listParentPapers(prisma, userId, selected.id);

    return {
        children: summaries,
        selectedLearnerId: selected.id,
        child: {
            id: selected.id,
            name: selected.name,
            weakPoints: profile.weaknesses,
            mastery: planned?.path.mastery ?? [],
            today: planned?.path.today ?? [],
            pathId: planned?.path.id ?? null,
            practiceTrend,
            practiceSummary: { attempted, correct },
            latestPaper: papers[0] ?? null,
        },
    };
}
