import type { NotebookSubject } from "@/lib/notebook-scope";

/**
 * 按题目文字粗略判断学科（只区分小学常见的语文 / 数学 / 英语）。
 * 用于卷子没选学科、识别结果也没给学科时，避免题目都落进「其他」错题本。判断不出时返回 null。
 */
const PINYIN_TONE = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/;
const CHINESE_CUES = /拼音|读音|注音|加点字|批注|阅读|课文|短文|段落|文章|作者|词语|组词|造句|近义词|反义词|成语|修辞|比喻|拟人|古诗|诗句|仿写|仿照例句|标点|偏旁|部首|笔画|笔顺|生字|汉字|形近字|句子|主人公|人物|心情|体会|感受|描写|朗读|默写|作文|习作|看图写话|“我”|﹏/g;
const MATH_CUES = /计算|列式|口算|竖式|脱式|简便|应用题|解方程|方程|倍|和是|差是|积是|商是|余数|分数|小数|百分|面积|周长|体积|厘米|毫米|千米|平方|千克|克|吨|角|三角形|长方形|正方形|圆|直线|线段|单位|元|角钱|时|分|秒|多少|几/g;
const MATH_EXPR = /\d\s*[+\-×÷*/=<>]\s*\d|\$[^$]*\d[^$]*\$|\\frac|\\times|\\div/g;

export function inferSubjectFromContent(text: string | null | undefined): NotebookSubject | null {
    const raw = (text || "").trim();
    if (!raw) return null;
    const latinWords = (raw.replace(/\$[^$]*\$/g, " ").match(/[A-Za-z]{2,}/g) || []).filter((word) => !PINYIN_TONE.test(word));
    const hanChars = (raw.match(/[\u4e00-\u9fa5]/g) || []).length;
    let chinese = (raw.match(CHINESE_CUES) || []).length * 2 + (PINYIN_TONE.test(raw) ? 3 : 0);
    const math = (raw.match(MATH_EXPR) || []).length * 3 + (raw.match(MATH_CUES) || []).length;
    const english = latinWords.length >= 3 && latinWords.join("").length > hanChars ? latinWords.length : 0;
    // 纯汉字长句、没有数字时偏向语文
    if (hanChars >= 12 && !/\d/.test(raw)) chinese += 1;
    const best = Math.max(chinese, math, english);
    if (best < 2) return null;
    if (english === best && english > chinese && english > math) return "english";
    if (chinese > math) return "chinese";
    if (math > chinese) return "math";
    return null;
}

/** 一份卷子的主学科：逐题判断后取出现最多的 */
export function dominantSubject(subjects: Array<NotebookSubject | null | undefined>): NotebookSubject | null {
    const counts = new Map<NotebookSubject, number>();
    for (const subject of subjects) if (subject) counts.set(subject, (counts.get(subject) ?? 0) + 1);
    let best: NotebookSubject | null = null;
    let bestCount = 0;
    for (const [subject, count] of counts) {
        if (count > bestCount) {
            best = subject;
            bestCount = count;
        }
    }
    return best;
}
