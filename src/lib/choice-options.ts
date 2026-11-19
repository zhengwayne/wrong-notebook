/**
 * 打印排版：把题干末尾逐行排列的选择题选项拆出来，按选项长度排成 4 列、2 列或 1 列，
 * 避免短选项每个独占一行浪费纸张。前后端共用（打印页与 Word 讲义），不要引入服务端模块。
 *
 * Ported from margrop/wrong-notebook 346a33c4 (MIT).
 */
import { extractMathSegments, restoreMathSegments } from '@/lib/markdown-math';

// 选择题选项标记：支持行首、空白或句读/括号后的 A. / B．/ C: / D：、(A) / （B），以及行首或双空格/括号后的 A、
const CHOICE_OPTION_GLOBAL = /(?:(?:^|[\s*+\-)）:：。？?；;，,_])([A-D])\s*[.．:：]|(?:^|\s{2,}|[)）:：。？?])([A-D])\s*、|[(（]([A-D])[)）])/gm;

/** 判断文本中是否同时包含 A、B、C 三个选择题选项标记 */
function hasChoiceOptions(text: string): boolean {
    const letters = new Set(Array.from(text.matchAll(CHOICE_OPTION_GLOBAL), (m) => m[1] ?? m[2] ?? m[3]));
    return letters.has('A') && letters.has('B') && letters.has('C');
}

/** 题干与 A 选项在同一行时，在 A 选项前插入换行 */
function separateChoiceOptions(text: string): string {
    if (!hasChoiceOptions(text)) return text;
    return text
        .replace(
            /([^\n\s])[ \t]*((?:A\s*[.．:：]|[(（]A[)）]))(?=[\s\S]*(?:[\s)）:：]B\s*[.．、:：]|[(（]B[)）]))/g,
            '$1\n$2',
        )
        .replace(
            /([^\n\s])(?:\s{2,}|(?<=[)）:：。？?])[ \t]*)(A\s*、)(?=[\s\S]*(?:\sB\s*、|[\s)）]B\s*[.．:：]))/g,
            '$1\n$2',
        );
}

export interface ChoiceOption {
    /** 原样保留的选项标记，如 "A."、"B．"、"（C）" */
    label: string;
    content: string;
}

export type ChoiceColumns = 1 | 2 | 4;

export interface SplitChoiceOptionsConfig {
    /** Word 等纯文本输出不渲染 KaTeX，按原始 LaTeX 字符估算选项宽度 */
    rawLatex?: boolean;
}

export interface ChoiceOptionsLayout {
    /** 选项之前的题干 */
    stem: string;
    options: ChoiceOption[];
    /** 选项之后的其余内容（如「图示：」段落） */
    after: string;
    columns: ChoiceColumns;
}

const LETTERS = ['A', 'B', 'C', 'D'] as const;
type MarkerStyle = 'bracket' | 'punct';

/** 4 列、2 列排版允许的最长选项宽度（中文、全角字符按 2 计，其余按 1 计） */
const FOUR_COLUMN_MAX_WIDTH = 14;
const TWO_COLUMN_MAX_WIDTH = 34;

/** 屏蔽 fenced 代码块与行内代码，避免代码中的 A./B./\n 被误解析 */
function maskCodeSegments(text: string): { masked: string; restore: (input: string) => string } {
    const segments: string[] = [];
    const masked = text.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
        const index = segments.length;
        segments.push(match);
        return `@@CODE_SEG_${index}@@`;
    });
    return {
        masked,
        restore: (input: string) => input.replace(/@@CODE_SEG_(\d+)@@/g, (_, idx) => segments[Number(idx)] ?? ''),
    };
}

/** 行首的某个选项标记：按首项风格区分括号式 (A)/（A） 与标点式 A./A．/A:/A：/A、 */
function leadingMarker(letter: string, style?: MarkerStyle): RegExp {
    if (style === 'bracket') return new RegExp(`^[(（]${letter}[)）]`);
    if (style === 'punct') return new RegExp(`^${letter}\\s*[.．:：、]`);
    return new RegExp(`^(?:${letter}\\s*[.．:：、]|[(（]${letter}[)）])`);
}

/** 行内空白之后的某个选项标记，严格保持与首项一致的风格，避免在 C 行正文误切 (D) */
function innerMarker(letter: string, style: MarkerStyle): RegExp {
    if (style === 'bracket') return new RegExp(`\\s[(（]${letter}[)）]`);
    return new RegExp(`\\s${letter}\\s*[.．:：、]`);
}

function detectMarkerStyle(label: string): MarkerStyle {
    return /^[(（]/.test(label.trim()) ? 'bracket' : 'punct';
}

/** 把一行（已确认以 letters[from] 开头）拆成若干选项，返回选项和下一个待匹配的字母序号 */
function splitOptionLine(line: string, from: number, style: MarkerStyle): { options: ChoiceOption[]; next: number } {
    const options: ChoiceOption[] = [];
    let rest = line;
    let index = from;
    while (index < LETTERS.length) {
        const label = rest.match(leadingMarker(LETTERS[index], style))![0];
        rest = rest.slice(label.length);
        const nextMatch = index + 1 < LETTERS.length ? rest.match(innerMarker(LETTERS[index + 1], style)) : null;
        const end = nextMatch?.index ?? rest.length;
        options.push({ label: label.trim(), content: rest.slice(0, end).trim() });
        index += 1;
        if (!nextMatch) break;
        rest = rest.slice(end).trimStart();
    }
    return { options, next: index };
}

/** 估算选项显示宽度：默认按公式渲染后的字符计，rawLatex 为 true 时按原始文本计；中文/全角按 2 计 */
function displayWidth(text: string, rawLatex = false): number {
    const plain = rawLatex
        ? text
        : text.replace(/\$+/g, '').replace(/\\[a-zA-Z]+/g, '').replace(/[{}^_\\]/g, '');
    let width = 0;
    for (const char of plain) width += char.codePointAt(0)! >= 0x2e80 ? 2 : 1;
    return width;
}

/** 判断选项是否包含图片或真正的 Markdown 表格（排除数学公式中的绝对值 $|x|$） */
function hasBlockContent(maskedContent: string): boolean {
    return /!\[/.test(maskedContent) || /\|[^|\n]+\|/.test(maskedContent);
}

function chooseColumns(options: ChoiceOption[], maskedOptions: ChoiceOption[], rawLatex = false): ChoiceColumns {
    // 图片、表格等块级内容只能整行显示
    if (maskedOptions.some(({ content }) => hasBlockContent(content))) return 1;
    const widest = Math.max(...options.map(({ label, content }) => displayWidth(label, rawLatex) + 1 + displayWidth(content, rawLatex)));
    if (widest <= FOUR_COLUMN_MAX_WIDTH) return 4;
    if (widest <= TWO_COLUMN_MAX_WIDTH) return 2;
    return 1;
}

/**
 * 拆出逐行排列的选择题选项；不是选择题、选项已在同一行或格式无法可靠识别时返回 null，按原文渲染
 */
export function splitChoiceOptions(
    content: string | null | undefined,
    config?: SplitChoiceOptionsConfig,
): ChoiceOptionsLayout | null {
    if (!content) return null;
    // 先屏蔽代码块和 LaTeX 公式，再把非公式区域内的字面 \n 转为换行，避免切碎 \neq / \nabla / \nu / \not
    const codeProtected = maskCodeSegments(content);
    const { masked: mathMasked, segments } = extractMathSegments(codeProtected.masked);
    const normalized = mathMasked.replace(/(?<!\\)\\n/g, '\n');
    // 题干与 A 选项在同一行时先拆开
    const lines = separateChoiceOptions(normalized).split('\n');

    const start = lines.findIndex((line) => leadingMarker('A').test(line.trim()));
    if (start < 0) return null;
    const firstAMatch = lines[start].trim().match(leadingMarker('A'));
    if (!firstAMatch) return null;
    const style = detectMarkerStyle(firstAMatch[0]);

    const options: ChoiceOption[] = [];
    let next = 0;
    let end = start;
    for (let i = start; i < lines.length && next < LETTERS.length; i += 1) {
        const line = lines[i].trim();
        if (!line) continue;
        if (!leadingMarker(LETTERS[next], style).test(line)) break;
        const result = splitOptionLine(line, next, style);
        options.push(...result.options);
        next = result.next;
        end = i + 1;
    }

    // 至少 A、B、C 三项，且全部选项原本就分在多行才需要重排
    if (options.length < 3 || end - start < 2) return null;
    const trailingLines = lines.slice(end);
    const after = trailingLines.join('\n').trim();
    // 未到 D 就中断时，后面的文字可能是多行选项的续行，无法可靠拆分
    if (next < LETTERS.length && after) return null;
    if (after) {
        const firstAfter = after.split('\n')[0].trim();
        // 含 E/F 等 5+ 选项时不强行截断，回退按原文渲染
        if (/^(?:[E-H]\s*[.．:：、]|[(（][E-H][)）])/.test(firstAfter)) return null;
        // 紧贴 D 行且中间没有空行分隔的普通续行视为 D 选项多行内容，回退按原文避免拆散 D
        const immediatelyFollowsD = trailingLines.length > 0 && trailingLines[0].trim().length > 0;
        if (immediatelyFollowsD && !/^(?:图示|注|提示|说明|附注|Note|Figure)\s*[:：]/.test(firstAfter)) {
            return null;
        }
    }

    const restore = (text: string) => codeProtected.restore(restoreMathSegments(text, segments));
    const restored = options.map((option) => ({ label: option.label, content: restore(option.content) }));
    return {
        stem: restore(lines.slice(0, start).join('\n').trim()),
        options: restored,
        after: restore(after),
        columns: chooseColumns(restored, options, config?.rawLatex),
    };
}
