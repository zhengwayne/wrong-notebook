import { describe, expect, it } from 'vitest';
import { prepareMarkdownMath } from '@/lib/markdown-math';

const ANALYSIS = `1.
理解题意并列式：

- “75 的 4 倍”表示为 75 × 4；
- “136 与 97 的和”需要先相加，因此要用小括号括起来，表示为 (136 + 97)；
- 求两者的差，列式为：75 × 4 − (136 + 97)。

2.
**按运算顺序计算：** 先算小括号里面的加法，同时算出乘法，最后再算减法：

$$\\begin{aligned}
&75 \\times 4 - (136 + 97) \\\\ &= 300 - 233 \\\\ &= 67
\\end{aligned}$$

答：差是 67。`;

describe('prepareMarkdownMath 有序列表规范化', () => {
    it('把单独成行的 1. / 2. 与下一行合并，并把嵌套条目缩进到该列表项下', () => {
        const prepared = prepareMarkdownMath(ANALYSIS);
        expect(prepared).toMatch(/^1\. 理解题意并列式：/m);
        expect(prepared).toMatch(/^2\. \*\*按运算顺序计算：\*\*/m);
        expect(prepared).not.toMatch(/^1\.\s*$/m);
        expect(prepared).not.toMatch(/^2\.\s*$/m);
        // 嵌套项目符号缩进到 "1. " 的正文列
        expect(prepared).toMatch(/^ {3}- “75 的 4 倍”/m);
        expect(prepared).toMatch(/^ {3}- “136 与 97 的和”/m);
        // 答：保持在左边，不当作第 2 项的续行
        expect(prepared).toMatch(/^答：差是 67。/m);
        expect(prepared).not.toMatch(/^ {3}答：/m);
    });

    it('已写在同一行的编号项不会被拆开，后续子弹仍缩进', () => {
        const prepared = prepareMarkdownMath('1. 标题\n- 子项\n2. 下一项');
        expect(prepared).toContain('1. 标题');
        expect(prepared).toMatch(/^ {3}- 子项/m);
        expect(prepared).toContain('2. 下一项');
    });

    it('编号后已有空行时仍与下一行合并', () => {
        const prepared = prepareMarkdownMath('1.\n\n理解题意并列式：\n- 子项');
        expect(prepared).toMatch(/^1\. 理解题意并列式：/m);
        expect(prepared).toMatch(/^ {3}- 子项/m);
    });

    it('英文句号后的换行仍拆段，数字后的点不当句号', () => {
        const prepared = prepareMarkdownMath('Hello.\nWorld');
        expect(prepared).toBe('Hello.\n\nWorld');
        expect(prepareMarkdownMath('1.\n标题')).toBe('1. 标题');
    });
});
