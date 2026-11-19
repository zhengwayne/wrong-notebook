import { UNLABELED_POINT } from '@/lib/home-aggregates';

export interface ClassMasteryMatrixRow {
    studentId: string;
    name: string;
    studentNo?: string | null;
    cells: Array<number | null>;
    handwritingLevel: string | null;
    attitudeLevel: string | null;
}

export interface ClassMasteryMatrix {
    knowledgePoints: string[];
    rows: ClassMasteryMatrixRow[];
}

export function buildClassMasteryMatrix(params: {
    students: Array<{ studentId: string; name: string; studentNo?: string | null }>;
    masteryByStudent: Map<string, Map<string, number>>;
    habitsByStudent?: Map<string, { handwritingLevel?: string | null; attitudeLevel?: string | null }>;
    maxColumns?: number;
}): ClassMasteryMatrix {
    const { students, masteryByStudent, habitsByStudent, maxColumns = 8 } = params;

    const pointAgg = new Map<string, { count: number; totalScore: number }>();
    for (const student of students) {
        const stuMap = masteryByStudent.get(student.studentId);
        if (!stuMap) continue;
        for (const [kp, score] of stuMap.entries()) {
            const trimmed = kp.trim();
            if (!trimmed || trimmed === UNLABELED_POINT) continue;
            const prev = pointAgg.get(trimmed) ?? { count: 0, totalScore: 0 };
            prev.count += 1;
            prev.totalScore += score;
            pointAgg.set(trimmed, prev);
        }
    }

    const knowledgePoints = [...pointAgg.entries()]
        .sort((a, b) => {
            if (b[1].count !== a[1].count) return b[1].count - a[1].count;
            const avgA = a[1].totalScore / a[1].count;
            const avgB = b[1].totalScore / b[1].count;
            if (avgA !== avgB) return avgA - avgB;
            return a[0].localeCompare(b[0]);
        })
        .slice(0, Math.max(1, maxColumns))
        .map(([kp]) => kp);

    const rows: ClassMasteryMatrixRow[] = students.map((student) => {
        const stuMap = masteryByStudent.get(student.studentId);
        const habits = habitsByStudent?.get(student.studentId);
        return {
            studentId: student.studentId,
            name: student.name,
            studentNo: student.studentNo ?? null,
            cells: knowledgePoints.map((kp) => {
                const val = stuMap?.get(kp);
                return typeof val === 'number' ? Math.round(val * 100) / 100 : null;
            }),
            handwritingLevel: habits?.handwritingLevel ?? null,
            attitudeLevel: habits?.attitudeLevel ?? null,
        };
    });

    return { knowledgePoints, rows };
}
