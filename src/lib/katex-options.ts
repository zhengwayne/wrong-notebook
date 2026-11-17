/**
 * 与页面渲染、打印和语法检查共用的 KaTeX 配置。
 * 导入本模块即加载 mhchem（\ce、\pu）。
 */
import 'katex/contrib/mhchem';

/** 把 KaTeX 不支持的宽弧命令映射为已验证的 \overset{\frown}{...} */
export const KATEX_MACROS: Record<string, string> = {
    '\\wideparen': '\\overset{\\frown}{#1}',
    '\\overparen': '\\overset{\\frown}{#1}',
};

export const KATEX_RENDER_OPTIONS = {
    macros: KATEX_MACROS,
    strict: 'ignore' as const,
};
