import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownRenderer } from '@/components/markdown-renderer';

describe('旧题缺少答案或解析时的详情渲染', () => {
    it.each([null, undefined, ''])('内容为 %s 时能正常显示空区域', (content) => {
        expect(() => renderToStaticMarkup(<MarkdownRenderer content={content} />)).not.toThrow();
    });
});

/** 渲染结果中 KaTeX 公式的个数 */
function countFormulas(content: string): number {
    return (renderToStaticMarkup(<MarkdownRenderer content={content} />).match(/class="katex"/g) || []).length;
}

/** 公式对应的 LaTeX 源码（KaTeX 保存在 annotation 中） */
function annotations(content: string): string[] {
    const html = renderToStaticMarkup(<MarkdownRenderer content={content} />);
    return [...html.matchAll(/<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/g)].map((m) => m[1]);
}

describe('LaTeX 公式渲染', () => {
    it('渲染 $…$ 和 $$…$$，公式紧贴中文时也能识别', () => {
        expect(countFormulas('求 $\\frac{1}{2}$ 的值')).toBe(1);
        expect(countFormulas('面积为$S=6$平方厘米')).toBe(1);
        expect(countFormulas('答案：\n\n$$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$')).toBe(1);
    });

    it('渲染 \\(…\\) 和 \\[…\\] 定界符', () => {
        expect(annotations('求 \\(\\frac{1}{2}\\) 的值')).toEqual(['\\frac{1}{2}']);
        expect(annotations('解：\\[x = \\frac{1}{2}\\]')).toEqual(['x = \\frac{1}{2}']);
    });

    it('不把 \\neq、\\nabla 中的 \\n 当作换行，公式外字面的 \\n 仍转为换行', () => {
        expect(annotations('因为 $a \\neq b$，且 $\\nabla f$')).toEqual(['a \\neq b', '\\nabla f']);
        expect(renderToStaticMarkup(<MarkdownRenderer content={'第一步。\\n第二步'} />)).toMatch(/第一步。<\/p>\s*<p[^>]*>第二步/);
    });

    it('多行 $$ 块内的标点和换行不被拆成段落', () => {
        const content = '解方程组：\n$$\n\\begin{cases}\nx+y=1;\\\\\nx-y=3.\n\\end{cases}\n$$\n得解。';
        expect(countFormulas(content)).toBe(1);
        expect(annotations(content)[0]).toContain('x+y=1;\\\\\nx-y=3.');
    });

    it('还原公式内被二次转义的命令，保留换行符 \\\\', () => {
        expect(annotations('$\\\\frac{1}{2}$')).toEqual(['\\frac{1}{2}']);
        expect(annotations('$\\begin{cases}a\\\\\\end{cases}$')).toEqual(['\\begin{cases}a\\\\\\end{cases}']);
    });
});

// 原 /latex-test 调试页中的典型答案格式
describe('常见答案格式的公式渲染', () => {
    it.each([
        ['行内公式', '(1) $a = -12$, $b = 8$, $c = 16$ (2) $t = 12$ (3) $M = \\frac{72}{11}$', 5],
        ['独立公式', '答案:\n\n$$M = \\frac{72}{11}$$', 1],
        ['行内与段落混合', '解:\n\n(1) $a = -12, b = 8, c = 16$\n\n(2) 当 $t = 12$ 时\n\n(3) $M = \\frac{72}{11}$', 3],
        ['行内与独立公式混合', '二次函数: $y = ax^2 + bx + c$\n\n求根公式: $$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$', 2],
    ])('%s', (_name, content, count) => {
        expect(countFormulas(content)).toBe(count);
    });
});

describe('代码渲染', () => {
    it('行内代码保持在段落中，不使用代码块样式', () => {
        const html = renderToStaticMarkup(<MarkdownRenderer content={'行内 `x + 1` 代码'} />);
        expect(html).toMatch(/<p[^>]*>行内 <code class="bg-muted px-1.5[^"]*">x \+ 1<\/code> 代码<\/p>/);
        expect(html).not.toContain('<code class="block');
    });

    it('代码块由 pre 提供块级样式', () => {
        const html = renderToStaticMarkup(<MarkdownRenderer content={'```\nblock\n```'} />);
        expect(html).toMatch(/<pre class="bg-muted p-4[^"]*"><code[^>]*>block\n<\/code><\/pre>/);
    });
});



function visibleMarkup(html: string): string {
    return html
        .replace(/<annotation[\s\S]*?<\/annotation>/g, '')
        .replace(/<span class="katex-mathml">[\s\S]*?<\/math><\/span>/g, '');
}

describe('独立成行的 $$ 围栏（aligned / align）', () => {
    const aligned = '$$\\begin{aligned}\n&75 \\times 4 - (136 + 97) \\\\ &= 300 - 233 \\\\ &= 67\n\\end{aligned}$$';

    it('$$\\\\begin{aligned} 与 \\\\end{aligned}$$ 紧贴时也能渲染，不残留源码', () => {
        const html = renderToStaticMarkup(<MarkdownRenderer content={aligned} />);
        const visible = visibleMarkup(html);
        expect(html).toContain('class="katex"');
        expect(html).not.toContain('katex-error');
        expect(visible).not.toContain('\\end{aligned}');
        expect(visible).not.toContain('\\begin{aligned}');
        expect(annotations(aligned)[0]).toContain('\\begin{aligned}');
        expect(annotations(aligned)[0]).toContain('\\end{aligned}');
    });

    it('只有开头或只有结尾紧贴 $$ 时同样能渲染', () => {
        const openingGlued = '$$\\begin{aligned}\n&75 \\times 4 - (136 + 97) \\\\ &= 300 - 233 \\\\ &= 67\n\\end{aligned}\n$$';
        const closingGlued = '$$\n\\begin{aligned}\n&75 \\times 4 - (136 + 97) \\\\ &= 300 - 233 \\\\ &= 67\n\\end{aligned}$$';
        for (const content of [openingGlued, closingGlued]) {
            const html = renderToStaticMarkup(<MarkdownRenderer content={content} />);
            expect(html).toContain('class="katex"');
            expect(html).not.toContain('katex-error');
            expect(visibleMarkup(html)).not.toContain('\\end{aligned}$$');
        }
    });

    it('\\\\begin{align*} 紧贴 $$ 时也能渲染', () => {
        const content = '$$\\begin{align*}\na&=1\\\\\\\\\nb&=2\n\\end{align*}$$';
        const html = renderToStaticMarkup(<MarkdownRenderer content={content} />);
        expect(countFormulas(content)).toBe(1);
        expect(html).not.toContain('katex-error');
    });
});

describe('安全渲染 <u> 下划线', () => {
    it('把 <u>y</u>、l<u>ea</u>ves 渲染成下划线，不显示原始标签', () => {
        const html = renderToStaticMarkup(
            <MarkdownRenderer content={'The birds fl<u>y</u> high. Look at the l<u>ea</u>ves. <u>the nice fruit</u>'} />,
        );
        expect(html).toMatch(/<u>y<\/u>/);
        expect(html).toMatch(/l<u>ea<\/u>ves/);
        expect(html).toMatch(/<u>the nice fruit<\/u>/);
        expect(html).not.toContain('&lt;u&gt;');
        expect(html).not.toContain('<u>y</u>'.replace('y', '') + 'y'); // sanity
    });

    it('丢掉 <u> 上的属性，且不把其它 HTML 当标签渲染', () => {
        const html = renderToStaticMarkup(
            <MarkdownRenderer content={'<u onclick="alert(1)">hi</u> and <script>alert(1)</script>'} />,
        );
        expect(html).toMatch(/<u>hi<\/u>/);
        expect(html).not.toContain('onclick');
        expect(html).not.toContain('<script>');
        expect(html).toContain('script');
    });
});

describe('compact 预览用 CSS 限制行数', () => {
    it('clamp 以样式限制行数，完整公式仍交给渲染器', () => {
        const html = renderToStaticMarkup(
            <MarkdownRenderer content={'计算 $1200 \\div 50 = 24$ 个'} variant="compact" clamp={2} />,
        );
        expect(html).toContain('-webkit-line-clamp:2');
        expect(html).toContain('class="katex"');
        expect(html).not.toContain('24\\te');
        expect(html).not.toContain('$1200');
    });
});
