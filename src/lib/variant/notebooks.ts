/** 改卷确认后，学生错题本命名为「学生名·学科」 */
export function studentNotebookPrefix(studentName: string): string {
    return `${studentName.trim()}·`;
}

export function isStudentNotebook(notebookName: string, studentName: string): boolean {
    const prefix = studentNotebookPrefix(studentName);
    return notebookName === studentName.trim() || notebookName.startsWith(prefix);
}
