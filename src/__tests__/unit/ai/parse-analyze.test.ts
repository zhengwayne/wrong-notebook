import { describe, expect, it } from 'vitest';
import {
    defaultSelectedAnalyzeItems,
    normalizeQuestionText,
    parseAnalyzeResponse,
    splitAnalyzeItems,
    toAnalyzeImageResult,
} from '@/lib/ai/parse-analyze';

const item = (n: number, extras = '') => `
<item>
<question_text>题目${n}：540\\div 90</question_text>
<answer_text>6</answer_text>
<analysis>竖式计算得到 6。</analysis>
<wrong_answer_text>5</wrong_answer_text>
<mistake_analysis>把商写成了 5。</mistake_analysis>
<mistake_status>wrong_attempt</mistake_status>
<subject>数学</subject>
<knowledge_points>简单除法竖式,有余数的除法</knowledge_points>
<requires_image>false</requires_image>
${extras}
</item>`;

describe('parseAnalyzeResponse', () => {
    it('没有 item 包裹时按单题解析，保持旧行为', () => {
        const items = parseAnalyzeResponse(`
<question_text>1+1</question_text>
<answer_text>2</answer_text>
<analysis>加法。</analysis>
<wrong_answer_text>3</wrong_answer_text>
<mistake_analysis>加错了</mistake_analysis>
<mistake_status>wrong_attempt</mistake_status>
<subject>数学</subject>
<knowledge_points>加法</knowledge_points>
`);
        expect(items).toHaveLength(1);
        expect(items[0].questionText).toBe('1+1');
        expect(items[0].wrongAnswerText).toBe('3');
        expect(toAnalyzeImageResult(items).items).toHaveLength(1);
    });

    it('把一页中的多道错题拆成多条，字段互不串题', () => {
        const xml = `${item(1)}
<item>
<question_text>题目2：求商和余数</question_text>
<answer_text>商 4，余 40</answer_text>
<analysis>应先确定余数小于除数。</analysis>
<wrong_answer_text>商 40，余 4</wrong_answer_text>
<mistake_analysis>把商和余数写反了。</mistake_analysis>
<mistake_status>wrong_attempt</mistake_status>
<subject>数学</subject>
<knowledge_points>有余数的除法</knowledge_points>
</item>`;
        const items = parseAnalyzeResponse(xml);
        expect(splitAnalyzeItems(xml)).toHaveLength(2);
        expect(items).toHaveLength(2);
        expect(items[0].questionText).toContain('540');
        expect(items[0].wrongAnswerText).toBe('5');
        expect(items[1].questionText).toContain('商和余数');
        expect(items[1].wrongAnswerText).toBe('商 40，余 4');
        expect(items[1].knowledgePoints).toEqual(['有余数的除法']);
    });

    it('默认只勾选看得出错的题目', () => {
        const items = parseAnalyzeResponse(`${item(1)}
<item>
<question_text>空白题</question_text>
<answer_text>1</answer_text>
<analysis>解析</analysis>
<wrong_answer_text></wrong_answer_text>
<mistake_analysis></mistake_analysis>
<mistake_status>not_attempted</mistake_status>
<subject>数学</subject>
<knowledge_points>加法</knowledge_points>
</item>`);
        expect(defaultSelectedAnalyzeItems(items)).toEqual([true, false]);
    });
});


describe('normalizeQuestionText', () => {
    it('收拢跨行的填空括号，并让大题标题单独成行、后面再跟题号', () => {
        const raw = 'I.Sounds A 级：Read and judge (判断句中画线部分的发音是否相同，相同的写“T”，不同的写“F”) ( ____\n)2.The birds fl<u>y</u> high in the sk<u>y</u>.';
        const normalized = normalizeQuestionText(raw);
        expect(normalized).toContain('( ____ )');
        expect(normalized).not.toMatch(/\( ____\n\)/);
        expect(normalized).toMatch(/\)\n+2\.The birds/);
        expect(normalized).toContain('<u>y</u>');
        const heading = normalized.split('\n')[0];
        expect(heading).toContain('I.Sounds A');
        expect(heading).not.toContain('2.The birds');
    });

    it('改写题的大题标题与题号拆到两行，保留划线标签', () => {
        const raw = 'IV.Rewrite the sentences (按要求改写下列句子) 4.He smells <u>the nice fruit</u> in autumn.';
        const normalized = normalizeQuestionText(raw);
        expect(normalized).toBe('IV.Rewrite the sentences (按要求改写下列句子)\n\n4.He smells <u>the nice fruit</u> in autumn.');
    });

    it('经 XML 解析后的题干也会做同样的整理', () => {
        const items = parseAnalyzeResponse(`
<item>
<question_text>I.Sounds A 级：Read and judge (判断) ( ____
)2.The birds l<u>ea</u>ves.</question_text>
<answer_text>F</answer_text>
<analysis>发音不同。</analysis>
<wrong_answer_text>T</wrong_answer_text>
<mistake_analysis>判断错误</mistake_analysis>
<mistake_status>wrong_attempt</mistake_status>
<subject>英语</subject>
<knowledge_points>字母发音</knowledge_points>
</item>`);
        expect(items[0].questionText).toContain('( ____ )');
        expect(items[0].questionText).toMatch(/\)\n+2\.The birds/);
        expect(items[0].questionText).toContain('<u>ea</u>');
    });
});
