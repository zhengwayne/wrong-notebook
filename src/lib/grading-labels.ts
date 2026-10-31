/**
 * 改卷界面里学生与卷面身份的显示文字
 */
import type { GradingStudentInfo, PaperIdentity } from "@/types/grading";

/** "七年级1班 · 01 · 张三"；只有一个班时省略班级 */
export function studentLabel(student: GradingStudentInfo, showClass = true): string {
    return [showClass ? student.className : null, student.studentNo, student.name].filter(Boolean).join(" · ");
}

export function identityLabel(identity: PaperIdentity | null | undefined): string {
    if (!identity) return "";
    return [identity.className, identity.studentNo, identity.name].map((value) => value?.trim()).filter(Boolean).join(" · ");
}
