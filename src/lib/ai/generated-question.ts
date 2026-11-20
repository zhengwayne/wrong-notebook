/** 只清理生成题目的排版标记，原题识别保持原文。 */
export function normalizeGeneratedQuestion<T extends { questionText: string }>(question: T): T {
    const questionText = question.questionText
        .replace(/[（(【\[]\s*(?:(?:本题|共|满分)\s*)?\d+(?:\.\d+)?\s*(?:分|points?|marks?|pts?\.?)\s*[）)】\]]/giu, '')
        .replace(/^\s*(?:#{1,6}\s*)?(?:第\s*\d+\s*题\s*[:：.、]?|(?:Question|Problem)\s*\d+\s*[:：.、]?|\d+\s*(?:[、．]|\.(?!\d)))\s*/iu, '')
        .trim();

    // 不能靠删除选项把选择题变成填空题；不合规输出交给现有的生成失败/重试流程处理。
    const hasOptionLine = /^\s*(?:[-*]\s*)?(?:[A-DＡ-Ｄ][.．、:：)）]|[（(][A-DＡ-Ｄ][）)])\s*\S/imu.test(questionText);
    const inlineOptions = questionText.match(/(?:^|\s)(?:[A-DＡ-Ｄ][.．、:：)）]|[（(][A-DＡ-Ｄ][）)])/giu) || [];
    const circledOptions = questionText.match(/[①②③④⑤⑥⑦⑧⑨⑩]/gu) || [];
    if (!questionText || hasOptionLine || inlineOptions.length >= 2 || circledOptions.length >= 2) {
        throw new Error('AI_RESPONSE_ERROR: 生成题目必须为不含选项的填空题或解答题');
    }

    return { ...question, questionText };
}
