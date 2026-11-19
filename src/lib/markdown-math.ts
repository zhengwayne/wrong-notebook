/**
 * Markdown 显示前的预处理：先把数学公式片段保护起来，只对公式以外的文字做换行整理，
 * 避免把 \neq、\nabla 中的 "\n" 当作换行，或在 $$…$$ 块内插入空行导致公式无法渲染。
 * 前后端共用，不要引入服务端模块。
 */

// 公式片段：$$…$$、\[…\]、\(…\)、$…$（行内公式不跨行，"\\$" 视为转义的美元符号）
const MATH_SEGMENT = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?:\\.|[^$\\\n])+?\$/g;

// AI 偶尔把命令的反斜杠转义成两个（如 \\\\frac），在公式内还原；只处理常见命令，避免误伤换行符 "\\\\"
const DOUBLE_ESCAPED_COMMAND = /(?<!\\)\\\\(?=(?:frac|dfrac|tfrac|sqrt|times|div|cdot|pm|mp|leq?|geq?|neq?|approx|equiv|sim|cong|propto|infty|pi|alpha|beta|gamma|delta|theta|lambda|mu|sigma|omega|angle|triangle|perp|parallel|because|therefore|circ|degree|ce|pu|overset|frown|wideparen|overparen|left|right|sum|prod|int|lim|log|ln|sin|cos|tan|text|mathrm|mathbf|overline|underline|vec|overrightarrow|hat|bar|begin|end|quad|qquad|in|notin|subset|subseteq|cup|cap|emptyset|forall|exists|to|rightarrow|Rightarrow|leftrightarrow|Leftrightarrow|ldots|cdots|dots)(?![a-zA-Z]))/g;

const PLACEHOLDER = (index: number) => `@@MATH${index}@@`;
const PLACEHOLDER_PATTERN = /@@MATH(\d+)@@/g;

/**
 * remark-math 把行首的 $$ 当成代码围栏：同一行紧跟的 \\begin{aligned} 会被当成 info string 丢掉，
 * 同一行结尾的 \\end{aligned}$$ 也不会被识别为结束围栏。把 $$ 单独放到一行即可正确渲染。
 */
function isolateDisplayMathFences(source: string): string {
    let inner = source.slice(2, -2);
    // 只在 \\begin / \\end 与 $$ 贴在同一行时拆开，避免把段中的 $$x$$、\\[x\\] 拆坏
    const beginGlued = /^[ \t]*\\begin\{/.test(inner);
    const endGlued = /\\end\{[a-zA-Z*]+\}[ \t]*$/.test(inner);
    if (!beginGlued && !endGlued) return source;
    if (beginGlued && !inner.startsWith('\n')) {
        inner = '\n' + inner.replace(/^[ \t]+/, '');
    }
    if (endGlued && !inner.endsWith('\n')) {
        inner = inner.replace(/[ \t]+$/, '') + '\n';
    }
    return `$$${inner}$$`;
}

/** 统一公式定界符：\\[…\\] → $$…$$，\\(…\\) → $…$，并还原被二次转义的命令 */
function normalizeMathSegment(segment: string): string {
    let math = segment;
    if (math.startsWith('\\[')) {
        math = `$$${math.slice(2, -2)}$$`;
    } else if (math.startsWith('\\(')) {
        math = `$${math.slice(2, -2).trim()}$`;
    }
    math = math.replace(DOUBLE_ESCAPED_COMMAND, '\\');
    if (math.startsWith('$$') && math.endsWith('$$') && math.length >= 4) {
        math = isolateDisplayMathFences(math);
    }
    return math;
}

/** 公式以外文字的整理：字面 "\\n" 转为换行，句末换行转为分段 */
function normalizeText(text: string): string {
    return text
        // AI 回复中字面的 \\n 转为真正的换行
        .replace(/\\n/g, '\n')
        // 保留已有的空行
        .replace(/\n\n/g, '\n\n###PRESERVE_BREAK###\n\n')
        // 句末标点后的单个换行转为分段；"1." 列表标记由 normalizeOrderedLists 处理
        .replace(/([。！？；])\n(?!\n)/g, '$1\n\n')
        // 数字后的点是 "1." 列表标记，不能当成句号拆段
        .replace(/(?<!\d)([.!?;])\s*\n(?!\n)/g, '$1\n\n')
        // 编号 (1)、①② 后的换行转为分段
        .replace(/(\d+\))\s*\n(?!\n)/g, '$1\n\n')
        .replace(/([①-⑳])\s*\n(?!\n)/g, '$1\n\n')
        // 去掉编号行前的缩进，避免被当作代码块
        .replace(/\n\s+([①-⑳])/g, '\n$1')
        .replace(/\n\s+(\d+\))/g, '\n$1')
        .replace(/\s*###PRESERVE_BREAK###\s*/g, '\n\n');
}


const LONE_ORDERED_MARKER = /^(\s*)(\d+)\.\s*$/;
const ORDERED_ITEM_START = /^(\s*)(\d+)\.\s+\S/;
const ANSWER_LINE = /^答[:：]/;

function isLoneOrderedMarker(line: string): RegExpExecArray | null {
    return LONE_ORDERED_MARKER.exec(line);
}

function isOrderedItemStart(line: string): RegExpExecArray | null {
    return ORDERED_ITEM_START.exec(line);
}

function isAnswerLine(line: string): boolean {
    return ANSWER_LINE.test(line.trim());
}

/**
 * 把单独成行的 "1." / "2." 与下一行标题合并，并把后续条目缩进到该列表项下。
 * 否则 CommonMark 会把无缩进的正文当成列表外的段落，编号就会孤零零占一行。
 */
function normalizeOrderedLists(text: string): string {
    const lines = text.split('\n');
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
        const lone = isLoneOrderedMarker(lines[i]);
        if (lone) {
            let j = i + 1;
            while (j < lines.length && lines[j].trim() === '') j++;
            if (j < lines.length && !isLoneOrderedMarker(lines[j]) && !isOrderedItemStart(lines[j]) && !isAnswerLine(lines[j])) {
                const indent = lone[1];
                const marker = `${indent}${lone[2]}. `;
                out.push(`${marker}${lines[j].replace(/^\s+/, '')}`);
                i = takeListContinuations(lines, j + 1, marker.length, out);
                continue;
            }
        }
        const start = isOrderedItemStart(lines[i]);
        if (start) {
            out.push(lines[i]);
            const indent = start[1];
            i = takeListContinuations(lines, i + 1, indent.length + start[2].length + 2, out);
            continue;
        }
        out.push(lines[i]);
        i++;
    }
    return out.join('\n');
}

function takeListContinuations(lines: string[], start: number, contentColumn: number, out: string[]): number {
    const itemIndent = ' '.repeat(contentColumn);
    let i = start;
    while (i < lines.length) {
        const line = lines[i];
        if (isLoneOrderedMarker(line) || isOrderedItemStart(line) || isAnswerLine(line)) break;
        if (line.trim() === '') {
            out.push('');
            i++;
            continue;
        }
        out.push(line.startsWith(itemIndent) ? line : `${itemIndent}${line.replace(/^\s+/, '')}`);
        i++;
    }
    return i;
}

/** 还原公式占位符；若占位符所在行已缩进，把公式块的后续行对齐到同一缩进 */
export function restoreMathSegments(text: string, segments: MathSegment[]): string {
    return text.replace(PLACEHOLDER_PATTERN, (_match, index: string, offset: number) => {
        const source = segments[Number(index)].source;
        if (!source.includes('\n')) return source;
        const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
        const indent = text.slice(lineStart, offset).match(/^[ \t]*/)?.[0] ?? '';
        if (!indent) return source;
        return source.split('\n').map((line, lineIndex) => (lineIndex === 0 ? line : `${indent}${line}`)).join('\n');
    });
}

/** 一个公式片段：source 为统一定界符后的源码（$…$ 或 $$…$$） */
export interface MathSegment {
    source: string;
    tex: string;
    displayMode: boolean;
}

/**
 * 取出内容中的公式片段，masked 为把公式换成占位符后的其余文字
 */
export function extractMathSegments(content: string | null | undefined): { masked: string; segments: MathSegment[] } {
    const segments: MathSegment[] = [];
    const masked = (content ?? '').replace(MATH_SEGMENT, (raw) => {
        const source = normalizeMathSegment(raw);
        const displayMode = source.startsWith('$$');
        segments.push({ source, tex: source.slice(displayMode ? 2 : 1, displayMode ? -2 : -1), displayMode });
        return PLACEHOLDER(segments.length - 1);
    });
    return { masked, segments };
}

/**
 * 预处理要交给 react-markdown + remark-math 渲染的内容
 */
export function prepareMarkdownMath(
    content: string | null | undefined,
    transformMasked: (text: string) => string = (text) => text,
): string {
    const { masked, segments } = extractMathSegments(content);
    const prepared = normalizeOrderedLists(normalizeText(transformMasked(masked)));
    return restoreMathSegments(prepared, segments);
}
