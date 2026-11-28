/**
 * 只把 <u>…</u> 转成下划线：先换成不会被 Markdown 当成 HTML 的占位符，
 * 再在 remark 里变成无属性的 <u>。其它标签保持为普通文字。
 */
import type { Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';

export const UNDERLINE_START = '@@U@@';
export const UNDERLINE_END = '@@/U@@';

const UNDERLINE_HTML = /<u\b[^>]*>([\s\S]*?)<\/u>/gi;
const UNDERLINE_TOKEN = /@@U@@([\s\S]*?)@@\/U@@/g;

function stripTags(value: string): string {
    return value.replace(/<[^>]*>/g, '');
}

/** 把成对的 <u> 换成占位符，属性与内部其它标签一律丢掉 */
export function protectUnderlineTags(text: string): string {
    return text.replace(UNDERLINE_HTML, (_match, inner: string) => (
        `${UNDERLINE_START}${stripTags(inner)}${UNDERLINE_END}`
    ));
}

/** remark 插件：把 @@U@@…@@/U@@ 变成无属性的 u 元素 */
export function remarkSafeUnderline() {
    return (tree: Root) => {
        visit(tree, 'text', (node: Text, index, parent) => {
            if (index == null || !parent) return;

            const value = node.value;
            UNDERLINE_TOKEN.lastIndex = 0;
            if (!UNDERLINE_TOKEN.test(value)) return;
            UNDERLINE_TOKEN.lastIndex = 0;

            const next: Array<Text | { type: 'underline'; data: { hName: 'u' }; children: Text[] }> = [];
            let last = 0;
            let match: RegExpExecArray | null;
            while ((match = UNDERLINE_TOKEN.exec(value)) !== null) {
                if (match.index > last) {
                    next.push({ type: 'text', value: value.slice(last, match.index) });
                }
                const inner = match[1] ?? '';
                next.push({
                    type: 'underline',
                    data: { hName: 'u' },
                    children: inner ? [{ type: 'text', value: inner }] : [],
                });
                last = match.index + match[0].length;
            }
            if (last < value.length) {
                next.push({ type: 'text', value: value.slice(last) });
            }
            parent.children.splice(index, 1, ...(next as typeof parent.children));
            return index + next.length;
        });
    };
}
