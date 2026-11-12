/**
 * 从题干中去掉学号、姓名、班级等身份信息，避免把学生个人信息送进出题模型。
 * 只处理带明确标签的字段和卷头式「班级 学号 姓名」，不去掉应用题里的「小明」等角色。
 */

const FIELD = /(?:^|[，。；、,\s])((?:姓\s*名|名字|学\s*号|考\s*号|准考证号|班\s*级|座\s*号|学籍号)\s*[:：是为]?\s*)([^\s，。；、,，]{1,20})/g;
const HEADER = /(?:^|\n)\s*((?:(?:[一二三四五六七八九十年级初高]|\d)[^\n]{0,8}班)?\s*(?:学号[:：]?\s*)?[A-Za-z0-9]{1,12}\s+[\u4e00-\u9fff]{2,4})\s*(?:\n|$)/;
const ID_CARD = /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g;
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;

const REPLACEMENTS: Record<string, string> = {
    姓名: '[姓名]',
    名字: '[姓名]',
    学号: '[学号]',
    考号: '[学号]',
    准考证号: '[学号]',
    班级: '[班级]',
    座号: '[学号]',
    学籍号: '[学号]',
};

function fieldKey(label: string): string {
    const compact = label.replace(/\s+/g, '').replace(/[:：是为]/g, '');
    for (const key of Object.keys(REPLACEMENTS)) {
        if (compact.startsWith(key)) return REPLACEMENTS[key];
    }
    return '[学生]';
}

/** 去掉题干中的身份字段，返回脱敏文本以及是否做了替换 */
export function deidentifyQuestionText(text: string | null | undefined): { text: string; stripped: boolean } {
    let result = (text || '').trim();
    if (!result) return { text: '', stripped: false };
    const original = result;
    result = result.replace(FIELD, (match, label: string) => {
        const prefix = match.startsWith('，') || match.startsWith(',') || match.startsWith('。') || match.startsWith('；') || match.startsWith('、') || match.startsWith(' ') || match.startsWith('\t')
            ? match[0] : '';
        return `${prefix}${fieldKey(label)}`;
    });
    result = result.replace(HEADER, (match, _body, offset) => (offset === 0 || match.startsWith('\n') ? `${match.startsWith('\n') ? '\n' : ''}[卷头]\n` : match));
    result = result.replace(ID_CARD, '[证件号]');
    result = result.replace(PHONE, '[电话]');
    result = result.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return { text: result, stripped: result !== original };
}
