/**
 * 需要纯文本截断时使用：去掉 ** 等标记，且不会把 $…$ 公式从中间切断。
 * 界面预览应优先用 MarkdownRenderer 的 CSS line-clamp，而不是本函数。
 */
import { extractMathSegments } from './markdown-math';
import { cleanMarkdown } from './markdown-utils';

const PLACEHOLDER_SPLIT = /@@MATH(\d+)@@/;

/** 去掉加粗标记，保留公式占位符，再按安全边界截断 */
export function truncatePlainPreview(text: string, maxLength: number): string {
    if (!text || maxLength <= 0) return '';

    const { masked, segments } = extractMathSegments(text);
    const withoutEmphasis = masked.replace(/\*\*/g, '').replace(/__([^_]+)__/g, '$1');
    const pieces = withoutEmphasis.split(PLACEHOLDER_SPLIT);

    let result = '';
    let used = 0;

    for (let i = 0; i < pieces.length; i++) {
        if (i % 2 === 0) {
            const raw = pieces[i];
            if (!raw) continue;
            const textPart = raw.replace(/\s+/g, ' ');
            const remaining = maxLength - used;
            if (textPart.length <= remaining) {
                result += textPart;
                used += textPart.length;
                continue;
            }
            // 尽量在空白处截断，绝不退回到公式内部（公式已拆出）
            let cut = textPart.slice(0, remaining);
            const space = cut.lastIndexOf(' ');
            if (space > remaining * 0.5) cut = cut.slice(0, space);
            result += cut.trimEnd();
            return `${result}…`;
        }

        const segment = segments[Number(pieces[i])];
        if (!segment) continue;
        const readable = cleanMarkdown(segment.source);
        if (used + readable.length > maxLength && used > 0) {
            return `${result.trimEnd()}…`;
        }
        result += readable;
        used += readable.length;
    }

    return result.replace(/\s+/g, ' ').trim();
}
