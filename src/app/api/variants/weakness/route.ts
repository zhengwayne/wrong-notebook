import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized, notFound, badRequest } from "@/lib/api-errors";
import { buildClassWeaknesses, classTopicBrief } from "@/lib/variant/weakness-profile";
import { LEARNER_KIND } from "@/lib/learners";
import { buildProfileForLearners, buildProfileForSubjects, findStudentLearnerId } from "@/lib/variant/service";

/** GET /api/variants/weakness?studentId=|&classId=|&subjectId= 学情弱点画像 */
export async function GET(req: Request) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const url = new URL(req.url);
    const studentId = url.searchParams.get('studentId');
    const classId = url.searchParams.get('classId');
    const subjectId = url.searchParams.get('subjectId');

    if (classId) {
        const cls = await prisma.gradingClass.findFirst({
            where: { id: classId, userId: user.id },
            include: { students: { orderBy: { order: 'asc' } } },
        });
        if (!cls) return notFound('Class not found');
        const studentLearners = await prisma.learner.findMany({
            where: { userId: user.id, kind: LEARNER_KIND.student, gradingStudentId: { in: cls.students.map((s) => s.id) } },
            select: { id: true, gradingStudentId: true },
        });
        const learnerByStudentId = new Map(studentLearners.map((l) => [l.gradingStudentId!, l.id]));
        const students = [];
        for (const student of cls.students) {
            const learnerId = learnerByStudentId.get(student.id);
            if (!learnerId) continue;
            const { profile } = await buildProfileForLearners(user.id, [learnerId]);
            if (profile.itemCount === 0) continue;
            students.push({ studentId: student.id, name: student.name, studentNo: student.studentNo, profile });
        }
        const classWeaknesses = buildClassWeaknesses(students.map((item) => ({ studentKey: item.studentId, profile: item.profile })));
        return NextResponse.json({ classId: cls.id, className: cls.name, students, classWeaknesses, topicBrief: classTopicBrief(classWeaknesses) });
    }

    if (subjectId) {
        const subject = await prisma.subject.findFirst({ where: { id: subjectId, userId: user.id }, select: { id: true, name: true } });
        if (!subject) return notFound('Notebook not found');
        const { profile } = await buildProfileForSubjects(user.id, [subject.id]);
        return NextResponse.json({ studentName: subject.name, subjectIds: [subject.id], profile });
    }

    if (studentId) {
        const student = await prisma.gradingStudent.findFirst({ where: { id: studentId, class: { userId: user.id } } });
        if (!student) return notFound('Student not found');
        const learnerId = await findStudentLearnerId(user.id, student.id);
        const { profile, items } = await buildProfileForLearners(user.id, learnerId ? [learnerId] : []);
        const subjectIds = [...new Set(items.map((item) => item.subjectId).filter((id): id is string => typeof id === 'string'))];
        return NextResponse.json({ studentName: student.name, subjectIds, profile });
    }

    return badRequest('studentId, classId or subjectId is required');
}
