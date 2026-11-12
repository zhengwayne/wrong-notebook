import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized, notFound, badRequest } from "@/lib/api-errors";
import { buildClassWeaknesses, classTopicBrief } from "@/lib/variant/weakness-profile";
import { buildProfileForSubjects, findStudentSubjectIds } from "@/lib/variant/service";

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
        const students = [];
        for (const student of cls.students) {
            const subjectIds = await findStudentSubjectIds(user.id, student.name);
            if (subjectIds.length === 0) continue;
            const { profile } = await buildProfileForSubjects(user.id, subjectIds);
            if (profile.itemCount === 0) continue;
            students.push({ studentId: student.id, name: student.name, studentNo: student.studentNo, profile });
        }
        const classWeaknesses = buildClassWeaknesses(students.map((item) => ({ studentKey: item.studentId, profile: item.profile })));
        return NextResponse.json({ classId: cls.id, className: cls.name, students, classWeaknesses, topicBrief: classTopicBrief(classWeaknesses) });
    }

    const subjectIds: string[] = [];
    let studentName: string | undefined;
    if (subjectId) {
        const subject = await prisma.subject.findFirst({ where: { id: subjectId, userId: user.id }, select: { id: true, name: true } });
        if (!subject) return notFound('Notebook not found');
        subjectIds.push(subject.id);
        studentName = subject.name;
    } else if (studentId) {
        const student = await prisma.gradingStudent.findFirst({ where: { id: studentId, class: { userId: user.id } } });
        if (!student) return notFound('Student not found');
        studentName = student.name;
        subjectIds.push(...await findStudentSubjectIds(user.id, student.name));
    } else {
        return badRequest('studentId, classId or subjectId is required');
    }
    const { profile } = await buildProfileForSubjects(user.id, subjectIds);
    return NextResponse.json({ studentName, subjectIds, profile });
}
