/**
 * 把题干、解析里的 Markdown 和常见数学符号转成可朗读的中文或英文。
 * 动画讲解稿本身已是口语，一般不必再过一遍；朗读按钮和浏览器回退会使用本函数。
 */
const ZH_SYMBOLS: Record<string, string> = {
    '÷': ' 除以 ',
    '×': ' 乘以 ',
    '⋅': ' 乘以 ',
    '±': ' 正负 ',
    '≤': ' 小于等于 ',
    '≥': ' 大于等于 ',
    '≠': ' 不等于 ',
    '≈': ' 约等于 ',
    'π': ' 圆周率 ',
    '∞': ' 无穷大 ',
    '√': ' 根号 ',
    '°': ' 度 ',
    '∠': ' 角 ',
    '△': ' 三角形 ',
    '□': ' 正方形 ',
    '⊥': ' 垂直 ',
    '∥': ' 平行 ',
    '∵': ' 因为 ',
    '∴': ' 所以 ',
    '%': ' 百分之 ',
};

const EN_SYMBOLS: Record<string, string> = {
    '÷': ' divided by ',
    '×': ' times ',
    '⋅': ' times ',
    '±': ' plus or minus ',
    '≤': ' less than or equal to ',
    '≥': ' greater than or equal to ',
    '≠': ' not equal to ',
    '≈': ' approximately ',
    'π': ' pi ',
    '∞': ' infinity ',
    '√': ' square root of ',
    '°': ' degrees ',
    '∠': ' angle ',
    '△': ' triangle ',
    '□': ' square ',
    '⊥': ' perpendicular to ',
    '∥': ' parallel to ',
    '∵': ' because ',
    '∴': ' therefore ',
    '%': ' percent ',
};

const LATEX_ZH: Record<string, string> = {
    times: ' 乘以 ',
    cdot: ' 乘以 ',
    div: ' 除以 ',
    pm: ' 正负 ',
    leq: ' 小于等于 ',
    le: ' 小于等于 ',
    geq: ' 大于等于 ',
    ge: ' 大于等于 ',
    neq: ' 不等于 ',
    approx: ' 约等于 ',
    pi: ' 圆周率 ',
    infty: ' 无穷大 ',
    circ: ' 度 ',
    degree: ' 度 ',
    angle: ' 角 ',
    triangle: ' 三角形 ',
    perp: ' 垂直 ',
    parallel: ' 平行 ',
    because: ' 因为 ',
    therefore: ' 所以 ',
    plus: ' 加 ',
    minus: ' 减 ',
};

const LATEX_EN: Record<string, string> = {
    times: ' times ',
    cdot: ' times ',
    div: ' divided by ',
    pm: ' plus or minus ',
    leq: ' less than or equal to ',
    le: ' less than or equal to ',
    geq: ' greater than or equal to ',
    ge: ' greater than or equal to ',
    neq: ' not equal to ',
    approx: ' approximately ',
    pi: ' pi ',
    infty: ' infinity ',
    circ: ' degrees ',
    degree: ' degrees ',
    angle: ' angle ',
    triangle: ' triangle ',
    perp: ' perpendicular to ',
    parallel: ' parallel to ',
    because: ' because ',
    therefore: ' therefore ',
    plus: ' plus ',
    minus: ' minus ',
};

/** 英文字母明显多于汉字时按英语朗读，否则按中文 */
export function detectSpeechLanguage(text: string): 'zh' | 'en' {
    const letters = (text.match(/[A-Za-z]/g) ?? []).length;
    const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
    if (letters >= 8 && letters > cjk * 2) return 'en';
    return 'zh';
}

function fraction(num: string, den: string, language: 'zh' | 'en'): string {
    const a = num.trim() || '0';
    const b = den.trim() || '1';
    return language === 'zh' ? ` ${b} 分之 ${a} ` : ` ${a} over ${b} `;
}

function power(exp: string, language: 'zh' | 'en'): string {
    const value = exp.trim();
    if (value === '2') return language === 'zh' ? ' 的平方 ' : ' squared ';
    if (value === '3') return language === 'zh' ? ' 的立方 ' : ' cubed ';
    return language === 'zh' ? ` 的 ${value} 次方 ` : ` to the power of ${value} `;
}

function latexToSpeech(input: string, language: 'zh' | 'en'): string {
    const dict = language === 'zh' ? LATEX_ZH : LATEX_EN;
    let text = input;
    text = text.replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, (_, num, den) => fraction(num, den, language));
    text = text.replace(/\\dfrac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, (_, num, den) => fraction(num, den, language));
    text = text.replace(/\\sqrt\s*\[([^{}\]]+)\]\s*\{([^{}]+)\}/g, (_, n, body) => (
        language === 'zh' ? ` ${n} 次根号 ${body} ` : ` the ${n} root of ${body} `
    ));
    text = text.replace(/\\sqrt\s*\{([^{}]+)\}/g, (_, body) => (
        language === 'zh' ? ` 根号 ${body} ` : ` square root of ${body} `
    ));
    text = text.replace(/\^\{([^{}]+)\}/g, (_, exp) => power(exp, language));
    text = text.replace(/\^(\d)/g, (_, exp) => power(exp, language));
    text = text.replace(/\\left|\\right/g, '');
    text = text.replace(/\\([a-zA-Z]+)/g, (match, name: string) => dict[name] ?? ' ');
    text = text.replace(/\\/g, ' ');
    text = text.replace(/[{}]/g, ' ');
    return text;
}

function replaceSymbols(text: string, language: 'zh' | 'en'): string {
    const dict = language === 'zh' ? ZH_SYMBOLS : EN_SYMBOLS;
    let result = text;
    for (const [symbol, spoken] of Object.entries(dict)) {
        result = result.split(symbol).join(spoken);
    }
    if (language === 'zh') {
        result = result.replace(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g, (_, a, b) => fraction(a, b, 'zh'));
    }
    return result;
}

/** 去掉 Markdown/LaTeX 标记，并把常见运算符号转成可朗读的说法 */
export function toSpeakableText(input: string, language: 'zh' | 'en' = 'zh'): string {
    let text = input.replace(/\r\n/g, '\n');
    text = text.replace(/```[\s\S]*?```/g, ' ');
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    text = text.replace(/^\s*>\s+/gm, '');
    text = text.replace(/(\*\*|__|~~)/g, '');
    text = text.replace(/(^|\s)[\*_`]([^\*_`]+)[\*_`](?=\s|$)/g, '$1$2');
    text = text.replace(/`([^`]+)`/g, '$1');
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, body) => ` ${latexToSpeech(body, language)} `);
    text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, body) => ` ${latexToSpeech(body, language)} `);
    text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, body) => ` ${latexToSpeech(body, language)} `);
    text = text.replace(/\$([^$\n]+)\$/g, (_, body) => ` ${latexToSpeech(body, language)} `);
    text = latexToSpeech(text, language);
    text = replaceSymbols(text, language);
    text = text.replace(/[|*]+/g, ' ');
    return text.replace(/\s+/g, ' ').trim();
}
