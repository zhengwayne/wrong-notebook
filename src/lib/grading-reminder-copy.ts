/**
 * 班级未交作业催交文案生成（纯前端安全模块，不依赖任何 Node 内置模块）。
 */
export function buildMissingReminderCopy(params: {
    taskTitle: string;
    subjectName: string;
    missingNames: string[];
    submitUrl?: string | null;
    language?: 'zh' | 'en';
}): string {
    const { taskTitle, subjectName, missingNames, submitUrl, language = 'zh' } = params;
    const count = missingNames.length;
    if (language === 'en') {
        const namesText = missingNames.join(', ');
        const linkSuffix = submitUrl ? ` Submit online here: ${submitUrl}` : '';
        return `[Homework Reminder] "${taskTitle}" (${subjectName}): ${count} student(s) still pending (${namesText}). Please assist with photo submission.${linkSuffix}`;
    }
    const namesText = missingNames.join('、');
    const linkSuffix = submitUrl ? `，在线扫码/拍照交卷入口：${submitUrl}` : '';
    return `【作业温馨提醒】《${taskTitle}》（${subjectName}）目前还有 ${count} 位同学尚未提交：${namesText}。烦请家长协助核对并提交作业${linkSuffix}，感谢配合！`;
}
