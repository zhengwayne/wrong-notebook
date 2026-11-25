/**
 * 把后端的 Markdown + LaTeX（KaTeX 子集，含 mhchem 的 \ce / \pu）转成小程序 <text> 能直接显示的 Unicode 文本。
 * 小程序没有 DOM，不内置 KaTeX：这里用一个小解析器把常见写法尽量还原成原样的符号，
 * 覆盖数学、物理（单位、矢量、上下标、希腊字母）、化学（化学式、离子电荷、反应箭头与条件）、
 * 生物、英语、语文等文字题；矩阵、多行推导等复杂排版会退化成按行显示，完整排版请在网页端查看。
 * 不依赖 wx，可以在 Node 里单测。
 */

const SUP: Record<string, string> = {
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
  '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ',
  n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
  T: 'ᵀ', '°': '°', '′': '′', '″': '″', '*': '*',
};

const SUB: Record<string, string> = {
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
  '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', o: 'ₒ', x: 'ₓ', h: 'ₕ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', p: 'ₚ', s: 'ₛ', t: 'ₜ',
  i: 'ᵢ', j: 'ⱼ', r: 'ᵣ', u: 'ᵤ', v: 'ᵥ', 'β': 'ᵦ', 'γ': 'ᵧ', 'ρ': 'ᵨ', 'φ': 'ᵩ', 'χ': 'ᵪ',
};

const SYMBOLS: Record<string, string> = {
  // 希腊字母
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο',
  pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // 运算与关系
  times: '×', div: '÷', cdot: '·', ast: '∗', star: '⋆', pm: '±', mp: '∓', circ: '∘', bullet: '•',
  le: '≤', leq: '≤', leqslant: '≤', ge: '≥', geq: '≥', geqslant: '≥', ne: '≠', neq: '≠', approx: '≈',
  equiv: '≡', cong: '≅', sim: '∼', simeq: '≃', propto: '∝', ll: '≪', gg: '≫', doteq: '≐',
  lt: '<', gt: '>',
  // 集合与逻辑
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', subsetneqq: '⫋', supset: '⊃', supseteq: '⊇',
  cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅', forall: '∀', exists: '∃', neg: '¬', lnot: '¬',
  land: '∧', wedge: '∧', lor: '∨', vee: '∨', setminus: '∖', complement: '∁',
  mathbb: '', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', R: 'ℝ', C: 'ℂ',
  // 箭头
  to: '→', rightarrow: '→', longrightarrow: '⟶', leftarrow: '←', longleftarrow: '⟵', gets: '←',
  leftrightarrow: '↔', longleftrightarrow: '⟷', Rightarrow: '⇒', Longrightarrow: '⟹', implies: '⟹',
  Leftarrow: '⇐', Leftrightarrow: '⇔', iff: '⟺', uparrow: '↑', downarrow: '↓', mapsto: '↦',
  rightleftharpoons: '⇌', leftrightharpoons: '⇋', rightharpoonup: '⇀',
  // 几何
  angle: '∠', measuredangle: '∡', triangle: '△', bigtriangleup: '△', square: '□', Box: '□', odot: '⊙',
  perp: '⊥', parallel: '∥', nparallel: '∦', because: '∵', therefore: '∴', frown: '⌒', degree: '°',
  // 微积分与其他
  infty: '∞', partial: '∂', nabla: '∇', sum: 'Σ', prod: 'Π', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
  prime: '′', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', wp: '℘',
  ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮', ddots: '⋱',
  langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋', vert: '|', Vert: '‖',
  mid: '|', backslash: '\\', S: '§', P: '¶', dagger: '†', checkmark: '✓', yen: '¥', euro: '€',
  quad: ' ', qquad: '  ', enspace: ' ', thinspace: '', space: ' ', displaystyle: '', textstyle: '',
  limits: '', nolimits: '', middle: '', big: '', Big: '', bigg: '', Bigg: '', bigl: '', bigr: '',
  Bigl: '', Bigr: '', centerdot: '·', colon: ':', AA: 'Å', textdegree: '°', textcelsius: '℃',
};

/** 原样输出名称的函数：sin、log、lim 等 */
const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
  'ln', 'log', 'lg', 'exp', 'lim', 'max', 'min', 'sup', 'inf', 'det', 'deg', 'gcd', 'arg', 'dim', 'ker', 'Pr', 'mod', 'bmod',
]);

/** 只取内容的样式命令 */
const STYLE_COMMANDS = new Set([
  'text', 'textrm', 'textbf', 'textit', 'textsf', 'texttt', 'textnormal', 'mathrm', 'mathbf', 'mathit', 'mathsf',
  'mathtt', 'mathcal', 'mathscr', 'mathfrak', 'boldsymbol', 'bm', 'mbox', 'hbox', 'emph', 'operatorname',
  'boxed', 'fbox', 'small', 'large', 'Large', 'tiny', 'huge', 'unit',
]);

/** 像字母一样紧贴后文的符号：TeX 会吞掉命令后的空格（\Delta t → Δt、\angle ABC → ∠ABC） */
const ORDINARY = /^[α-ωΑ-Ωϑϖϱςφ∠∡△□⊙∂∇ℏℓ¬]$/;

const DOUBLE_STRUCK: Record<string, string> = { N: 'ℕ', Z: 'ℤ', Q: 'ℚ', R: 'ℝ', C: 'ℂ', P: 'ℙ' };

/** 每个字符后加组合符号（上划线、矢量箭头等） */
function combineEach(text: string, mark: string): string {
  return Array.from(text).map((ch) => (/\s/.test(ch) ? ch : ch + mark)).join('');
}

function combineLast(text: string, mark: string): string {
  const chars = Array.from(text);
  if (!chars.length) return mark;
  chars[chars.length - 1] += mark;
  return chars.join('');
}

const HAS_CJK = /[\u3400-\u9fff]/;

export function toSuperscript(text: string): string {
  const value = text.trim();
  if (!value) return '';
  if (value === '∘' || value === '○') return '°';
  const chars = Array.from(value);
  if (chars.every((ch) => SUP[ch] !== undefined)) return chars.map((ch) => SUP[ch]).join('');
  return chars.length === 1 ? `^${value}` : `^(${value})`;
}

export function toSubscript(text: string): string {
  const value = text.trim();
  if (!value) return '';
  const chars = Array.from(value);
  if (chars.every((ch) => SUB[ch] !== undefined)) return chars.map((ch) => SUB[ch]).join('');
  // F_{合}、m_{总} 这类中文下标直接跟在后面更好读
  if (HAS_CJK.test(value)) return value;
  return chars.length === 1 ? `_${value}` : `_(${value})`;
}

/** 分式两边需要括号时才加：1/2、a/b 不加，(x+1)/(x−1) 加 */
function wrapFraction(text: string): string {
  const value = text.trim();
  if (Array.from(value).length <= 1) return value;
  if (/^[A-Za-z0-9.′°²³⁰-⁹₀-₉πα-ωΑ-Ω\u3400-\u9fff]+$/.test(value)) return value;
  // √12 这类根式单独做分子分母时加括号，免得 √12/2 被读成 √(12/2)
  if (/^√[A-Za-z0-9.]+$/.test(value)) return `(${value})`;
  if (/^\(.*\)$/.test(value) && !/\).*\(/.test(value)) return value;
  return `(${value})`;
}

interface ConvertOptions {
  /** 公式外的正文：不处理 ^ _（英语填空的下划线等），只换命令 */
  textMode?: boolean;
}

class Parser {
  private pos = 0;

  constructor(private readonly src: string, private readonly options: ConvertOptions) {}

  private peek(): string {
    return this.src[this.pos] ?? '';
  }

  private skipSpaces(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos += 1;
  }

  /** 符号后紧跟字母、数字时去掉中间空格；后面是运算符时保留（\alpha + 1） */
  private skipSpacesBeforeOperand(): void {
    let end = this.pos;
    while (end < this.src.length && /[ \t]/.test(this.src[end])) end += 1;
    if (end > this.pos && /[A-Za-z0-9]/.test(this.src[end] ?? '')) this.pos = end;
  }

  /** 读一个参数：{...}、\命令 或单个字符，返回原始源码 */
  private readRawArg(): string {
    this.skipSpaces();
    const ch = this.peek();
    if (!ch) return '';
    if (ch === '{') return this.readBalanced('{', '}');
    if (ch === '\\') {
      const start = this.pos;
      this.pos += 1;
      if (/[a-zA-Z]/.test(this.peek())) {
        while (/[a-zA-Z]/.test(this.peek())) this.pos += 1;
      } else {
        this.pos += 1;
      }
      return this.src.slice(start, this.pos);
    }
    const cp = this.src.codePointAt(this.pos) ?? 0;
    const char = String.fromCodePoint(cp);
    this.pos += char.length;
    return char;
  }

  private readBalanced(open: string, close: string): string {
    // 当前位置是 open
    let depth = 0;
    const start = this.pos + 1;
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === '\\') {
        this.pos += 2;
        continue;
      }
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          const inner = this.src.slice(start, this.pos);
          this.pos += 1;
          return inner;
        }
      }
      this.pos += 1;
    }
    // 括号没闭合：剩下的都当内容
    return this.src.slice(start);
  }

  private readOptional(): string | null {
    const save = this.pos;
    this.skipSpaces();
    if (this.peek() !== '[') {
      this.pos = save;
      return null;
    }
    return this.readBalanced('[', ']');
  }

  private arg(): string {
    return convertLatex(this.readRawArg(), this.options);
  }

  private readEnvironment(name: string): string {
    const begin = `\\begin{${name}}`;
    const end = `\\end{${name}}`;
    let depth = 1;
    let index = this.pos;
    while (index < this.src.length) {
      const nextBegin = this.src.indexOf(begin, index);
      const nextEnd = this.src.indexOf(end, index);
      if (nextEnd < 0) break;
      if (nextBegin >= 0 && nextBegin < nextEnd) {
        depth += 1;
        index = nextBegin + begin.length;
        continue;
      }
      depth -= 1;
      if (depth === 0) {
        const inner = this.src.slice(this.pos, nextEnd);
        this.pos = nextEnd + end.length;
        return inner;
      }
      index = nextEnd + end.length;
    }
    const inner = this.src.slice(this.pos);
    this.pos = this.src.length;
    return inner;
  }

  private environment(): string {
    const name = this.readRawArg().replace(/^\{|\}$/g, '').trim();
    // array / tabular 的列格式参数
    if (/^(array|tabular)$/.test(name)) this.readRawArg();
    const body = this.readEnvironment(name);
    const rows = body
      .split(/\\\\(?:\[[^\]]*\])?/)
      .map((row) => convertLatex(row.replace(/\\hline/g, ''), this.options).replace(/\s*&\s*/g, ' ').trim())
      .filter(Boolean);
    const base = name.replace(/\*$/, '');
    if (base === 'cases' || base === 'dcases') return `{ ${rows.join('；')} }`;
    if (base === 'rcases') return `${rows.join('；')} }`;
    if (/^(pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|matrix|smallmatrix)$/.test(base)) {
      const [open, close] = base === 'pmatrix' ? ['(', ')'] : base === 'vmatrix' ? ['|', '|'] : base === 'Vmatrix' ? ['‖', '‖'] : base === 'Bmatrix' ? ['{', '}'] : ['[', ']'];
      return `${open}${rows.join('; ')}${close}`;
    }
    // aligned、gathered、array、split 等：按行显示
    return rows.join('\n');
  }

  private command(name: string): string {
    if (SYMBOLS[name] !== undefined && name !== 'mathbb' && !(name in DOUBLE_STRUCK)) return SYMBOLS[name];
    if (FUNCTIONS.has(name)) return name === 'bmod' ? ' mod ' : name;
    if (STYLE_COMMANDS.has(name)) return this.arg();
    switch (name) {
      case 'frac': case 'dfrac': case 'tfrac': case 'cfrac': {
        const top = this.arg();
        const bottom = this.arg();
        return `${wrapFraction(top)}/${wrapFraction(bottom)}`;
      }
      case 'binom': case 'dbinom': case 'tbinom': {
        const n = this.arg();
        const k = this.arg();
        return `C(${n},${k})`;
      }
      case 'sqrt': {
        const index = this.readOptional();
        const body = this.arg();
        const root = index ? toSuperscript(convertLatex(index, this.options)) : '';
        return `${root}√${wrapFraction(body)}`;
      }
      case 'mathbb': {
        const body = this.arg();
        return Array.from(body).map((ch) => DOUBLE_STRUCK[ch] ?? ch).join('');
      }
      case 'vec': return combineLast(this.arg(), '\u20D7');
      case 'overrightarrow': case 'overleftrightarrow': return combineLast(this.arg(), '\u20D7');
      case 'overleftarrow': return combineLast(this.arg(), '\u20D6');
      case 'overline': case 'bar': {
        const body = this.arg();
        return Array.from(body).length === 1 ? combineEach(body, '\u0304') : combineEach(body, '\u0305');
      }
      case 'underline': return combineEach(this.arg(), '\u0332');
      case 'hat': case 'widehat': return combineLast(this.arg(), '\u0302');
      case 'tilde': case 'widetilde': return combineLast(this.arg(), '\u0303');
      case 'dot': return combineLast(this.arg(), '\u0307');
      case 'ddot': return combineLast(this.arg(), '\u0308');
      case 'overset': case 'stackrel': {
        const over = this.arg();
        const base = this.arg();
        if (over === '⌒') return `⌒${base}`;
        if (over === '△' && base === '=') return '≜';
        if (base === '=' || base === '→' || base === '⟶') return `─${over}→`.replace('─→', '→');
        return `${base}${toSuperscript(over)}`;
      }
      case 'underset': {
        this.arg();
        return this.arg();
      }
      case 'xrightarrow': case 'xlongequal': case 'xleftarrow': {
        const below = this.readOptional();
        const above = this.arg();
        const cond = [above, below ? convertLatex(below, this.options) : ''].filter(Boolean).join('，');
        const arrow = name === 'xleftarrow' ? '←' : name === 'xlongequal' ? '═' : '→';
        return cond ? `─${cond}${arrow}` : arrow;
      }
      case 'ce': return convertChem(this.readRawArg(), this.options);
      case 'pu': return convertLatex(this.readRawArg(), this.options).replace(/\s+/g, ' ');
      case 'color': this.readRawArg(); return '';
      case 'textcolor': case 'colorbox': this.readRawArg(); return this.arg();
      case 'phantom': case 'hphantom': case 'vphantom': case 'label': case 'tag': this.readRawArg(); return '';
      case 'hspace': case 'vspace': case 'kern': case 'mkern': case 'hskip': this.readRawArg(); return ' ';
      case 'not': {
        const next = this.arg();
        if (next === '=') return '≠';
        if (next === '∈') return '∉';
        return combineLast(next, '\u0338');
      }
      case 'left': case 'right': {
        this.skipSpaces();
        const delim = this.readRawArg();
        if (delim === '.') return '';
        if (delim === '\\{') return '{';
        if (delim === '\\}') return '}';
        if (delim === '\\|') return '‖';
        return delim.startsWith('\\') ? convertLatex(delim, this.options) : delim;
      }
      case 'begin': return this.environment();
      case 'end': this.readRawArg(); return '';
      case 'newline': case 'cr': return '\n';
      case 'hline': return '';
      default:
        return name;
    }
  }

  run(): string {
    let out = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === '\\') {
        const next = this.src[this.pos + 1] ?? '';
        if (/[a-zA-Z]/.test(next)) {
          let end = this.pos + 1;
          while (end < this.src.length && /[a-zA-Z]/.test(this.src[end])) end += 1;
          const name = this.src.slice(this.pos + 1, end);
          this.pos = end;
          const piece = this.command(name);
          out += piece;
          if (!this.options.textMode && ORDINARY.test(piece)) this.skipSpacesBeforeOperand();
          continue;
        }
        this.pos += 2;
        if (next === '\\') out += '\n';
        else if (next === ',' || next === ':' || next === ';' || next === ' ' || next === '>') out += ' ';
        else if (next === '!') out += '';
        else if (next === '|') out += '‖';
        else out += next; // \{ \} \% \$ \& \_ \#
        continue;
      }
      if (!this.options.textMode && (ch === '^' || ch === '_')) {
        this.pos += 1;
        const value = this.arg();
        out += ch === '^' ? toSuperscript(value) : toSubscript(value);
        continue;
      }
      if (!this.options.textMode && (ch === '{' || ch === '}')) {
        this.pos += 1;
        continue;
      }
      if (!this.options.textMode && ch === '~') {
        out += ' ';
        this.pos += 1;
        continue;
      }
      if (!this.options.textMode && ch === "'") {
        out += '′';
        this.pos += 1;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
    return out;
  }
}

export function convertLatex(src: string, options: ConvertOptions = {}): string {
  if (!src) return '';
  return new Parser(src, options).run();
}

/**
 * mhchem \ce{...}：数字跟在元素或括号后是下标，打头或空格后的数字是系数；
 * 结尾的 + / - 与 ^{2-} 是电荷；->、<=> 等是反应箭头，->[条件] 写成 ─条件→；空格包围的 ^ 是气体 ↑，v 是沉淀 ↓。
 */
export function convertChem(src: string, options: ConvertOptions = {}): string {
  let text = src.trim();
  if (text.startsWith('{') && text.endsWith('}')) text = text.slice(1, -1);
  const ARROWS: Record<string, string> = { '->': '→', '<-': '←', '<=>': '⇌', '<->': '↔', '<=>>': '⇌', '<<=>': '⇌', '=': '=' };
  text = text.replace(/(<<=>|<=>>|<=>|<->|->|<-)(?:\[([^\]]*)\])?(?:\[([^\]]*)\])?/g, (_m, arrow: string, above?: string, below?: string) => {
    const cond = [above, below].filter((part) => part && part.trim()).map((part) => convertChem(part as string, options)).join('，');
    const symbol = ARROWS[arrow] ?? '→';
    return cond ? ` ─${cond}${symbol} ` : ` ${symbol} `;
  });
  let out = '';
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const prev = out.slice(-1);
    const next = chars[i + 1] ?? '';
    if (ch === '\\') {
      // 内嵌的 LaTeX 命令（\Delta、\triangle、\frac 等）交给通用转换
      let end = i + 1;
      if (/[a-zA-Z]/.test(chars[end] ?? '')) {
        while (/[a-zA-Z]/.test(chars[end] ?? '')) end += 1;
        let cmd = chars.slice(i, end).join('');
        // 带参数的命令连同 {...} 一起交出去
        while (chars[end] === '{') {
          let depth = 0;
          let j = end;
          for (; j < chars.length; j += 1) {
            if (chars[j] === '{') depth += 1;
            else if (chars[j] === '}') { depth -= 1; if (depth === 0) break; }
          }
          cmd += chars.slice(end, j + 1).join('');
          end = j + 1;
        }
        out += convertLatex(cmd, options);
        i = end - 1;
      } else {
        out += chars[i + 1] ?? '';
        i += 1;
      }
      continue;
    }
    if (ch === '$') continue;
    if (/[0-9]/.test(ch)) {
      // 前面是元素符号、括号或已有下标 → 下标；否则（开头、空格、+、·后）是系数
      const isSub = /[A-Za-z)\]₀-₉]/.test(prev);
      out += isSub ? SUB[ch] : ch;
      continue;
    }
    if (ch === '^') {
      if ((prev === '' || prev === ' ') && (next === ' ' || next === '')) {
        out += '↑';
        continue;
      }
      let charge = '';
      if (next === '{') {
        let j = i + 2;
        for (; j < chars.length && chars[j] !== '}'; j += 1) charge += chars[j];
        i = j;
      } else {
        let j = i + 1;
        while (j < chars.length && /[0-9+\-IVX]/.test(chars[j])) { charge += chars[j]; j += 1; }
        i = j - 1;
      }
      out += toSuperscript(convertLatex(charge, options).replace(/−/g, '-'));
      continue;
    }
    if (ch === '_') {
      let sub = '';
      if (next === '{') {
        let j = i + 2;
        for (; j < chars.length && chars[j] !== '}'; j += 1) sub += chars[j];
        i = j;
      } else {
        sub = next;
        i += 1;
      }
      out += toSubscript(convertLatex(sub, options));
      continue;
    }
    if ((ch === '+' || ch === '-') && /[A-Za-z0-9)\]₀-₉⁰-⁹⁺⁻]/.test(prev) && (next === '' || next === ' ' || next === ')' || next === ']' || next === '+' || next === '-' || next === ',' || next === '，')) {
      // 离子电荷：Na+、Cl-、NH4+（推荐写法 Fe^{3+} 走上面的 ^ 分支）
      out += ch === '+' ? '⁺' : '⁻';
      continue;
    }
    if (ch === 'v' && prev === ' ' && (next === ' ' || next === '')) {
      out += '↓';
      continue;
    }
    if (ch === '*' && /[A-Za-z0-9₀-₉)]/.test(prev)) {
      out += '·';
      continue;
    }
    if (ch === '~') {
      out += ' ';
      continue;
    }
    if (ch === '{' || ch === '}') continue;
    out += ch;
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

/** 公式片段：$$...$$、$...$、\[...\]、\(...\)。\$ 是普通美元符号，先换成占位符（不用后行断言，兼容旧版 iOS） */
const MATH_PATTERN = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$]+?)\$/g;
const DOLLAR = '\u0000';

function convertText(text: string): string {
  let value = text;
  // 常见 HTML：<sub> <sup> <br>
  value = value.replace(/<br\s*\/?>/gi, '\n');
  value = value.replace(/<sub>([\s\S]*?)<\/sub>/gi, (_m, inner: string) => toSubscript(inner));
  value = value.replace(/<sup>([\s\S]*?)<\/sup>/gi, (_m, inner: string) => toSuperscript(inner));
  value = value.replace(/<\/?(?:p|div|span|b|i|u|strong|em|font|center)(?:\s+[a-zA-Z-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>/gi, '');
  if (value.includes('\\')) value = convertLatex(value, { textMode: true });
  return value;
}

/** Markdown 代码块：smiles 结构式在小程序里画不出来，标注后保留 SMILES；其他代码块保留内容 */
function convertFences(input: string): string {
  return input.replace(/```([a-zA-Z0-9_-]*)[^\n]*\n([\s\S]*?)```/g, (_m, lang: string, body: string) => {
    const content = body.trim();
    if (lang.toLowerCase() === 'smiles') return `〔结构式：${content}〕`;
    return content;
  });
}

/** 题目、答案、解析的显示文本 */
export function latexToPlainText(input: string | null | undefined): string {
  if (!input) return '';
  let text = convertFences(String(input).replace(/\r\n?/g, '\n')).replace(/\\\$/g, DOLLAR);
  let out = '';
  let last = 0;
  MATH_PATTERN.lastIndex = 0;
  for (let match = MATH_PATTERN.exec(text); match; match = MATH_PATTERN.exec(text)) {
    out += convertText(text.slice(last, match.index));
    const math = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
    out += convertLatex(math).replace(/[ \t]{2,}/g, ' ').trim();
    last = match.index + match[0].length;
  }
  out += convertText(text.slice(last));
  text = out.split(DOLLAR).join('$');
  // Markdown：粗体、标题、引用、列表符号；不动单个或成对的下划线（英语填空 ____、__1__）
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  text = text.replace(/^#{1,6}\s*/gm, '').replace(/^>\s?/gm, '');
  text = text.replace(/^\s*[-*]\s+/gm, '• ');
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
