/**
 * 结构化答案解析、比对及可计算数学题符号/数值验算。
 * 只解析受限数学表达式，绝不执行模型生成的代码。
 */
import { create, all, type MathNode } from 'mathjs';
import { z } from 'zod';
import type { ComputableSpec } from './schemas';

const math = create(all, { number: 'number', matrix: 'Array' });

const ALLOWED_FUNCTIONS = new Set([
    'sqrt', 'abs', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
    'log', 'log10', 'exp', 'floor', 'ceil', 'round', 'min', 'max', 'pow',
    'sign', 'gcd', 'lcm', 'factorial', 'nthRoot', 'mod', 'hypot', 'cbrt',
]);

/** 数学内置常量，代入未知数或提取自由变量时必须保护（特别是自然常数 e） */
const MATH_CONSTANTS = new Set(['e', 'E', 'pi', 'PI', 'tau', 'phi', 'i', 'Infinity', 'NaN']);

const BUILTIN_EVAL_SCOPE: Record<string, number> = {
    e: Math.E,
    E: Math.E,
    pi: Math.PI,
    PI: Math.PI,
    tau: Math.PI * 2,
    phi: (1 + Math.sqrt(5)) / 2,
};

const SAFE_EXPR = /^[\s0-9a-zA-Z+\-*/^().,_<>=!|]+$/;
const MAX_EXPR_LENGTH = 400;
export const DEFAULT_EPSILON = 1e-8;

const UNIT_ALIASES: Record<string, string> = {
    '平方厘米': 'cm^2', 'cm²': 'cm^2', 'cm^2': 'cm^2',
    '平方米': 'm^2', 'm²': 'm^2', 'm^2': 'm^2',
    '平方千米': 'km^2', 'km²': 'km^2', 'km^2': 'km^2',
    '立方厘米': 'cm^3', 'cm³': 'cm^3', 'cm^3': 'cm^3',
    '立方米': 'm^3', 'm³': 'm^3', 'm^3': 'm^3',
    'm/s^2': 'm/s^2', 'm/s²': 'm/s^2', 'm/s': 'm/s', 'km/h': 'km/h',
    '厘米': 'cm', 'cm': 'cm', '毫米': 'mm', 'mm': 'mm', '分米': 'dm', 'dm': 'dm',
    '千米': 'km', '公里': 'km', 'km': 'km', '米': 'm', 'm': 'm',
    '千克': 'kg', '公斤': 'kg', 'kg': 'kg', '毫克': 'mg', 'mg': 'mg', '克': 'g', 'g': 'g', '吨': 't',
    '小时': 'h', 'h': 'h', '分钟': 'min', 'min': 'min', '毫秒': 'ms', 'ms': 'ms', '秒': 's', 's': 's',
    '°c': '°c', '℃': '°c', '°': '°', '度': '°',
    'mol': 'mol', '毫升': 'ml', 'ml': 'ml', '升': 'l', 'l': 'l',
    '元': '元', '角': '角', '分': '分', '个': '个', '人': '人', '条': '条', '天': '天',
};

// 按长度降序拼接单位正则，优先匹配复合单位
const UNIT_PATTERN = Object.keys(UNIT_ALIASES)
    .sort((a, b) => b.length - a.length)
    .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
const TRAILING_UNIT_RE = new RegExp(`^(.*(?:[0-9)\\]]|pi))\\s*(${UNIT_PATTERN})$`, 'i');

export type ParsedAnswer =
    | { kind: 'scalar'; value: string; unit?: string }
    | { kind: 'tuple'; items: ParsedAnswer[] }
    | { kind: 'set'; items: ParsedAnswer[] }
    | { kind: 'parts'; parts: Array<{ label: string; answer: ParsedAnswer }> }
    | { kind: 'text'; value: string };

export type CheckResult = {
    status: 'passed' | 'failed' | 'unknown';
    reason: string;
};

export interface CheckOptions {
    epsilon?: number;
    /** 仅当在纯计算期望（无单位）与带单位题目答案比对时允许忽略单边单位 */
    ignoreUnitIfOneSided?: boolean;
}

export interface VerifyEvidence {
    method: 'mathjs' | 'compare' | 'none';
    computable: boolean;
    passed: boolean;
    expected?: string;
    actual?: string;
    detail: string;
}

/** 受控隐式乘法预处理：2x -> 2*x，(x+1)(x-1) -> (x+1)*(x-1)，保护科学计数法 */
export function insertImplicitMultiplication(expr: string): string {
    const scientificTokens: string[] = [];
    let masked = expr.replace(/\b\d+(?:\.\d+)?[eE][+-]?\d+\b/g, (match) => {
        const token = `__SCI_${scientificTokens.length}__`;
        scientificTokens.push(match);
        return token;
    });
    masked = masked
        .replace(/(\d)([a-zA-Z(])/g, '$1*$2')
        .replace(/(\))([0-9a-zA-Z(])/g, '$1*$2');
    return masked.replace(/__SCI_(\d+)__/g, (_, idx: string) => scientificTokens[Number(idx)]);
}

function assertSafeExpression(expr: string): string {
    const trimmed = expr.replace(/\s+/g, ' ').trim();
    if (!trimmed || trimmed.length > MAX_EXPR_LENGTH) throw new Error('EXPRESSION_TOO_LONG');
    if (!SAFE_EXPR.test(trimmed)) throw new Error('UNSAFE_EXPRESSION');
    return insertImplicitMultiplication(trimmed);
}

function assertSafeNode(node: MathNode): void {
    node.traverse((item) => {
        const type = item.type;
        if (
            type === 'AssignmentNode'
            || type === 'FunctionAssignmentNode'
            || type === 'BlockNode'
            || type === 'AccessorNode'
            || type === 'ObjectNode'
        ) {
            throw new Error('UNSAFE_EXPRESSION');
        }
        if (type === 'FunctionNode') {
            const name = 'fn' in item && item.fn && typeof (item.fn as { name?: string }).name === 'string'
                ? (item.fn as { name: string }).name
                : '';
            if (!ALLOWED_FUNCTIONS.has(name)) throw new Error('UNSAFE_FUNCTION');
        }
    });
}

function parseSafeNode(expr: string): MathNode {
    const safe = assertSafeExpression(expr);
    const node = math.parse(safe);
    assertSafeNode(node);
    return node;
}

function collectFreeVariables(node: MathNode): Set<string> {
    const vars = new Set<string>();
    node.traverse((item, _path, parent) => {
        if (item.type !== 'SymbolNode') return;
        if (parent && parent.type === 'FunctionNode' && (parent as { fn?: unknown }).fn === item) return;
        const name = (item as { name?: string }).name || '';
        if (!name || ALLOWED_FUNCTIONS.has(name) || MATH_CONSTANTS.has(name)) return;
        vars.add(name);
    });
    return vars;
}

function evaluateExpression(expr: string, extraScope: Record<string, number> = {}): unknown {
    const node = parseSafeNode(expr);
    return node.compile().evaluate({ ...BUILTIN_EVAL_SCOPE, ...extraScope });
}

function asNumber(value: unknown, epsilon: number = DEFAULT_EPSILON): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
    }
    if (value && typeof value === 'object' && 're' in (value as object) && typeof (value as { re: unknown }).re === 'number') {
        const imag = (value as { im?: number }).im ?? 0;
        if (Math.abs(imag) < epsilon) {
            const re = (value as { re: number }).re;
            return Number.isFinite(re) ? re : null;
        }
    }
    return null;
}

function numericEqual(left: number, right: number, epsilon: number = DEFAULT_EPSILON): boolean {
    const scale = Math.max(1, Math.abs(left), Math.abs(right));
    return Math.abs(left - right) <= epsilon * scale;
}

/** 轻量基础归一化：全角、百分号与小写清理 */
export function normalizeAnswer(value: string | null | undefined): string {
    return (value || '')
        .normalize('NFC')
        .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
        .replace(/（/g, '(').replace(/）/g, ')')
        .replace(/[ \t]+/g, '')
        .replace(/[．]/g, '.')
        .replace(/。+$/g, '')
        .replace(/%/g, '/100')
        .trim()
        .toLowerCase();
}

function cleanMathText(raw: string): string {
    let text = (raw || '')
        .normalize('NFC')
        .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/（/g, '(').replace(/）/g, ')')
        .replace(/【/g, '[').replace(/】/g, ']')
        .replace(/｛/g, '{').replace(/｝/g, '}')
        .replace(/，/g, ',').replace(/；/g, ';')
        .replace(/．/g, '.')
        .replace(/。+$/g, '')
        .trim();
    text = text.replace(/^(?:答案是|参考答案|答案|答|解|answer)\s*[:：]?\s*/i, '').trim();
    text = text.replace(/\$\$?/g, '').replace(/\\\[|\\\]|\\\(|\\\)/g, '').trim();
    for (let i = 0; i < 4; i++) {
        const next = text
            .replace(/\\(?:d|t)?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, '(($1)/($2))')
            .replace(/\\sqrt\s*\[([^{}]+)\]\s*\{([^{}]+)\}/g, 'nthRoot($2,$1)')
            .replace(/\\sqrt\s*\{([^{}]+)\}/g, 'sqrt($1)');
        if (next === text) break;
        text = next;
    }
    text = text
        .replace(/\\text\s*\{([^{}]*)\}/g, '$1')
        .replace(/\\mathrm\s*\{([^{}]*)\}/g, '$1')
        .replace(/\\left\s*/g, '').replace(/\\right\s*/g, '')
        .replace(/\\times|\\cdot/g, '*')
        .replace(/\\div/g, '/')
        .replace(/\\pi\b/g, 'pi')
        .replace(/\\pm/g, '±')
        .replace(/π/g, 'pi')
        .replace(/×/g, '*')
        .replace(/÷/g, '/')
        .replace(/−/g, '-')
        .replace(/\s*%\s*/g, '/100');
    return text.trim();
}

function splitTopLevel(input: string, separator: RegExp): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    let i = 0;
    while (i < input.length) {
        const ch = input[i];
        if (ch === '(' || ch === '[' || ch === '{') {
            depth += 1;
            i += 1;
            continue;
        }
        if (ch === ')' || ch === ']' || ch === '}') {
            if (depth > 0) depth -= 1;
            i += 1;
            continue;
        }
        if (depth === 0) {
            const slice = input.slice(i);
            const match = separator.exec(slice);
            if (match && match.index === 0) {
                parts.push(input.slice(start, i).trim());
                i += Math.max(1, match[0].length);
                start = i;
                continue;
            }
        }
        i += 1;
    }
    parts.push(input.slice(start).trim());
    return parts.filter(Boolean);
}

function isWrappedByPair(text: string, open: string, close: string): boolean {
    if (!text.startsWith(open) || !text.endsWith(close)) return false;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === open) depth += 1;
        else if (text[i] === close) {
            depth -= 1;
            if (depth === 0 && i < text.length - 1) return false;
        }
    }
    return depth === 0;
}

const CIRCLED_NUMS = '①②③④⑤⑥⑦⑧⑨⑩';

function extractParts(text: string): Array<{ label: string; raw: string }> | null {
    const markerRe = /(?:^|[\s;；,，])(?:\((\d{1,2})\)|\[(\d{1,2})\]|([①②③④⑤⑥⑦⑧⑨⑩])|(\d{1,2})\)(?!\d))\s*/g;
    const matches: Array<{ index: number; end: number; label: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = markerRe.exec(text)) !== null) {
        const label = m[1] || m[2] || (m[3] ? String(CIRCLED_NUMS.indexOf(m[3]) + 1) : m[4]);
        const leading = m[0].length - m[0].trimStart().length;
        matches.push({ index: m.index + leading, end: markerRe.lastIndex, label });
    }
    if (matches.length < 2) return null;
    // 确保是多个独立小问序号
    const uniqueLabels = new Set(matches.map((item) => item.label));
    if (uniqueLabels.size < 2) return null;

    const extracted: Array<{ label: string; raw: string }> = [];
    for (let i = 0; i < matches.length; i++) {
        const nextStart = i + 1 < matches.length ? matches[i + 1].index : text.length;
        const content = text.slice(matches[i].end, nextStart).replace(/[;；,\s]+$/g, '').trim();
        extracted.push({ label: matches[i].label, raw: content });
    }
    return extracted;
}

function stripSameVarPrefix(items: string[]): { stripped: string[]; namedParts: Array<{ label: string; raw: string }> | null } {
    const parsedAssigns = items.map((item) => {
        const m = /^([a-zA-Z][a-zA-Z0-9_]*)\s*=\s*(.+)$/.exec(item);
        if (!m) return null;
        const full = m[1].trim().toLowerCase();
        if (ALLOWED_FUNCTIONS.has(full) || MATH_CONSTANTS.has(full)) return null;
        const base = full.replace(/_?\d+$/, '');
        return { base, full, rhs: m[2].trim() };
    });
    if (parsedAssigns.some((a) => !a)) return { stripped: items, namedParts: null };
    const nonNull = parsedAssigns as Array<{ base: string; full: string; rhs: string }>;
    const uniqueBases = new Set(nonNull.map((a) => a.base));
    if (uniqueBases.size === 1) {
        return { stripped: nonNull.map((a) => a.rhs), namedParts: null };
    }
    // 多元不同变量，例如 x=1, y=2 或 v0=3, a=2
    const uniqueNames = new Set(nonNull.map((a) => a.full));
    if (uniqueNames.size === nonNull.length) {
        return {
            stripped: items,
            namedParts: nonNull.map((a) => ({ label: a.full, raw: a.rhs })),
        };
    }
    return { stripped: items, namedParts: null };
}

function expandPlusMinus(text: string): string[] | null {
    // 只处理单变量或顶层表达式中的单个 ±
    const m = /^(?:[a-zA-Z](?:_?\d+)?\s*=\s*)?(.*)±(.+)$/.exec(text);
    if (!m) return null;
    const left = m[1].trim();
    const right = m[2].trim();
    if (!right || right.includes('±')) return null;
    if (!left) return [right, `-(${right})`];
    return [`${left}+${right}`, `${left}-${right}`];
}

const scalarMeta = new WeakMap<ParsedAnswer, { rawExpr?: string; asciiUnit?: boolean; assignedVar?: string }>();

function parseSingleScalarOrText(raw: string): ParsedAnswer {
    let text = raw.trim();
    let assignedVar: string | undefined;
    // 剥离单变量常数赋值前缀（如 "x = 3" 或 "v0 = 5"）
    const assignMatch = /^([a-zA-Z][a-zA-Z0-9_]*)\s*=\s*(.+)$/.exec(text);
    if (assignMatch && !ALLOWED_FUNCTIONS.has(assignMatch[1].toLowerCase()) && !MATH_CONSTANTS.has(assignMatch[1])) {
        const rhs = assignMatch[2].trim();
        let isPureConstantRhs = false;
        try {
            const node = parseSafeNode(rhs);
            isPureConstantRhs = collectFreeVariables(node).size === 0;
        } catch {
            // 若右端带有中文单位（如 x = 5 cm），也剥离赋值标签
            isPureConstantRhs = TRAILING_UNIT_RE.test(rhs);
        }
        if (isPureConstantRhs) {
            assignedVar = assignMatch[1].toLowerCase();
            text = rhs;
        }
    }

    const rawBeforeUnit = text;
    let unit: string | undefined;
    let rawUnitToken = '';
    const unitMatch = TRAILING_UNIT_RE.exec(text);
    if (unitMatch) {
        const valuePart = unitMatch[1].trim();
        const rawUnit = unitMatch[2].toLowerCase();
        unit = UNIT_ALIASES[rawUnit] || rawUnit;
        rawUnitToken = rawUnit;
        text = valuePart;
    }

    const compact = text.replace(/\s+/g, '');
    if (/[\u4e00-\u9fff]/.test(compact) && !/[+\-*/^=()<>]/.test(compact)) {
        const zhRes: ParsedAnswer = unit
            ? { kind: 'scalar', value: compact.toLowerCase(), unit }
            : { kind: 'text', value: compact.toLowerCase() };
        if (assignedVar) scalarMeta.set(zhRes, { assignedVar });
        return zhRes;
    }
    const result: ParsedAnswer = {
        kind: 'scalar',
        value: compact.toLowerCase(),
        ...(unit ? { unit } : {}),
    };
    if ((unit && rawUnitToken) || assignedVar) {
        scalarMeta.set(result, {
            ...(unit && rawUnitToken
                ? {
                    rawExpr: rawBeforeUnit.replace(/\s+/g, '').toLowerCase(),
                    asciiUnit: /^[a-z]+$/i.test(rawUnitToken),
                }
                : {}),
            ...(assignedVar ? { assignedVar } : {}),
        });
    }
    return result;
}

/** 将答案文本结构化解析为 scalar | tuple | set | parts | text */
export function parseAnswer(raw: string): ParsedAnswer {
    const cleaned = cleanMathText(raw);
    if (!cleaned) return { kind: 'text', value: '' };

    const multiParts = extractParts(cleaned);
    if (multiParts) {
        return {
            kind: 'parts',
            parts: multiParts.map((part) => ({
                label: part.label,
                answer: parseAnswer(part.raw),
            })),
        };
    }

    // 显式花括号集合：{a, b}
    if (isWrappedByPair(cleaned, '{', '}')) {
        const inner = cleaned.slice(1, -1).trim();
        const rawItems = splitTopLevel(inner, /(?:,|;|或者|或|\bor\b)/i);
        const { stripped } = stripSameVarPrefix(rawItems);
        const expanded = stripped.flatMap((entry) => expandPlusMinus(entry) ?? [entry]);
        return { kind: 'set', items: expanded.map((entry) => parseAnswer(entry)) };
    }

    // 显式 "或" / ";" 分隔多解集
    const orParts = splitTopLevel(cleaned, /(?:;|或者|或|\bor\b)/i);
    if (orParts.length >= 2) {
        const { stripped } = stripSameVarPrefix(orParts);
        const expanded = stripped.flatMap((entry) => expandPlusMinus(entry) ?? [entry]);
        return { kind: 'set', items: expanded.map((entry) => parseAnswer(entry)) };
    }

    // 单项内的正负号 ±
    const pmParts = expandPlusMinus(cleaned);
    if (pmParts) {
        return { kind: 'set', items: pmParts.map((entry) => parseAnswer(entry)) };
    }

    // 有序坐标/元组：(a, b)
    if (isWrappedByPair(cleaned, '(', ')')) {
        const inner = cleaned.slice(1, -1).trim();
        const tupleItems = splitTopLevel(inner, /,/);
        if (tupleItems.length >= 2) {
            return { kind: 'tuple', items: tupleItems.map((entry) => parseAnswer(entry)) };
        }
    }

    // 无括号逗号序列：不无条件视为「或」
    const commaItems = splitTopLevel(cleaned, /,/);
    if (commaItems.length >= 2) {
        const { stripped, namedParts } = stripSameVarPrefix(commaItems);
        if (namedParts) {
            return {
                kind: 'parts',
                parts: namedParts.map((item) => ({
                    label: item.label,
                    answer: parseAnswer(item.raw),
                })),
            };
        }
        // 同变量多根 (如 x1=2, x2=3 或 x=2, x=3) 识别为集合
        if (stripped !== commaItems) {
            return { kind: 'set', items: stripped.map((entry) => parseAnswer(entry)) };
        }
        // 普通逗号列表按有序元组比较（维度和顺序均敏感）
        return { kind: 'tuple', items: commaItems.map((entry) => parseAnswer(entry)) };
    }

    return parseSingleScalarOrText(cleaned);
}

function tryEvaluateNumeric(expr: string, epsilon: number): number | null {
    try {
        const node = parseSafeNode(expr);
        if (collectFreeVariables(node).size > 0) return null;
        return asNumber(node.compile().evaluate({ ...BUILTIN_EVAL_SCOPE }), epsilon);
    } catch {
        const numeric = Number(expr);
        return Number.isFinite(numeric) ? numeric : null;
    }
}

const SAMPLE_SCOPES = [
    { a: 1.7, b: -2.3, c: 3.1, x: 2.5, y: -1.4, z: 0.9, t: 1.3, n: 4, m: 2.1, k: -0.7, r: 1.9 },
    { a: -1.1, b: 2.7, c: -0.6, x: -1.8, y: 3.2, z: 2.4, t: 0.6, n: 3, m: -1.5, k: 2.2, r: 0.8 },
    { a: 2.9, b: 0.4, c: -2.2, x: 0.7, y: 1.1, z: -2.6, t: 2.8, n: 5, m: 0.9, k: 1.4, r: 3.3 },
];

function symbolicCheck(left: string, right: string, epsilon: number): CheckResult {
    let diffNode: MathNode;
    try {
        diffNode = parseSafeNode(`(${left})-(${right})`);
    } catch {
        // 含未支持 LaTeX 宏或复合表达，给出 unknown 而非假阳性
        if (/\\[a-z]+/i.test(left) || /\\[a-z]+/i.test(right)) {
            return { status: 'unknown', reason: '含未支持的公式命令，无法自动判等' };
        }
        if (/[<>=!≠≤≥]/.test(left) || /[<>=!≠≤≥]/.test(right)) {
            return { status: 'unknown', reason: '关系式或区间表达无法确认等价性' };
        }
        return { status: 'failed', reason: '文本答案不一致' };
    }

    const freeVars = collectFreeVariables(diffNode);
    if (freeVars.size === 0) {
        try {
            const val = asNumber(diffNode.compile().evaluate({ ...BUILTIN_EVAL_SCOPE }), epsilon);
            if (val !== null) {
                return numericEqual(val, 0, epsilon)
                    ? { status: 'passed', reason: '数值求值相等' }
                    : { status: 'failed', reason: '数值求值不相等' };
            }
        } catch {
            return { status: 'unknown', reason: '表达式求值失败' };
        }
    }

    // 含自由变量的代数表达式：多点确定性采样验证 + 符号化简
    try {
        let allZero = true;
        let sampled = 0;
        const compiled = diffNode.compile();
        for (let roundIndex = 0; roundIndex < SAMPLE_SCOPES.length; roundIndex += 1) {
            const preset = SAMPLE_SCOPES[roundIndex];
            const scope: Record<string, number> = { ...BUILTIN_EVAL_SCOPE };
            let offset = 1.5 + roundIndex * 1.13;
            for (const name of freeVars) {
                scope[name] = name in preset ? preset[name as keyof typeof preset] : (offset += 0.37);
            }
            const val = asNumber(compiled.evaluate(scope), epsilon);
            if (val === null) continue;
            sampled += 1;
            if (!numericEqual(val, 0, Math.max(epsilon, 1e-6))) {
                allZero = false;
                break;
            }
        }
        if (!allZero) return { status: 'failed', reason: '代数表达式在采样点不等价' };
        const simplified = String(math.simplify(diffNode)).replace(/\s+/g, '');
        if (simplified === '0' || sampled >= 2) {
            return { status: 'passed', reason: '代数表达式符号等价' };
        }
        return { status: 'unknown', reason: '未能完成符号化简校验' };
    } catch {
        return { status: 'unknown', reason: '代数表达式无法可靠对比' };
    }
}

function deduplicateParsed(items: ParsedAnswer[], options: Required<CheckOptions>): ParsedAnswer[] {
    const result: ParsedAnswer[] = [];
    for (const item of items) {
        const dup = result.some((existing) => compareParsed(existing, item, options).status === 'passed');
        if (!dup) result.push(item);
    }
    return result;
}

function compareParsed(left: ParsedAnswer, right: ParsedAnswer, options: Required<CheckOptions>): CheckResult {
    // 1. 多小问
    if (left.kind === 'parts' || right.kind === 'parts') {
        if (left.kind !== 'parts' || right.kind !== 'parts') {
            return { status: 'failed', reason: '小问或多元项结构不匹配' };
        }
        if (left.parts.length !== right.parts.length) {
            return { status: 'failed', reason: `小问数量不一致（期望 ${left.parts.length}，实际 ${right.parts.length}）` };
        }
        const rightMap = new Map(right.parts.map((part) => [part.label.toLowerCase(), part.answer]));
        let hasUnknown = false;
        for (const lPart of left.parts) {
            const rAnswer = rightMap.get(lPart.label.toLowerCase());
            if (!rAnswer) {
                return { status: 'failed', reason: `缺少第 (${lPart.label}) 问或变量 ${lPart.label}` };
            }
            const res = compareParsed(lPart.answer, rAnswer, options);
            if (res.status === 'failed') return res;
            if (res.status === 'unknown') hasUnknown = true;
        }
        return hasUnknown
            ? { status: 'unknown', reason: '部分小问无法可靠判定等价性' }
            : { status: 'passed', reason: '全部小问逐一匹配' };
    }

    // 2. 集合（无序，必须双向完整匹配，缺根/多根均失败）
    if (left.kind === 'set' || right.kind === 'set') {
        if (left.kind !== 'set' || right.kind !== 'set') {
            return { status: 'failed', reason: '集合解数量不匹配（缺少或多出解）' };
        }
        const uniqueLeft = deduplicateParsed(left.items, options);
        const uniqueRight = deduplicateParsed(right.items, options);
        if (uniqueLeft.length !== uniqueRight.length) {
            return { status: 'failed', reason: `解集元素个数不匹配（${uniqueLeft.length} vs ${uniqueRight.length}）` };
        }
        const allLeftMatched = uniqueLeft.every((l) => uniqueRight.some((r) => compareParsed(l, r, options).status === 'passed'));
        const allRightMatched = uniqueRight.every((r) => uniqueLeft.some((l) => compareParsed(l, r, options).status === 'passed'));
        if (allLeftMatched && allRightMatched) {
            return { status: 'passed', reason: '集合双向完整匹配' };
        }
        return { status: 'failed', reason: '集合元素不完全一致' };
    }

    // 3. 元组（有序、定维）
    if (left.kind === 'tuple' || right.kind === 'tuple') {
        if (left.kind !== 'tuple' || right.kind !== 'tuple') {
            return { status: 'failed', reason: '元组维度不匹配' };
        }
        if (left.items.length !== right.items.length) {
            return { status: 'failed', reason: `元组长度不一致（${left.items.length} vs ${right.items.length}）` };
        }
        let hasUnknown = false;
        for (let i = 0; i < left.items.length; i++) {
            const res = compareParsed(left.items[i], right.items[i], options);
            if (res.status === 'failed') {
                return { status: 'failed', reason: `第 ${i + 1} 个分量不一致` };
            }
            if (res.status === 'unknown') hasUnknown = true;
        }
        return hasUnknown
            ? { status: 'unknown', reason: '部分分量无法可靠判定等价性' }
            : { status: 'passed', reason: '有序元组逐位匹配' };
    }

    // 4. 自由文本
    if (left.kind === 'text' || right.kind === 'text') {
        if (left.value === right.value && left.value.length > 0) {
            return { status: 'passed', reason: '文本精确一致' };
        }
        return { status: 'failed', reason: '文本内容不一致' };
    }

    // 5. 标量（含变量赋值校验、单位与数值/符号比较）
    const leftAssignVar = scalarMeta.get(left)?.assignedVar;
    const rightAssignVar = scalarMeta.get(right)?.assignedVar;
    if (leftAssignVar && rightAssignVar && leftAssignVar !== rightAssignVar) {
        return { status: 'failed', reason: `赋值变量名称不一致（${leftAssignVar} vs ${rightAssignVar}）` };
    }
    if (left.unit || right.unit) {
        if (left.unit && right.unit) {
            if (left.unit !== right.unit) {
                return { status: 'failed', reason: `单位不一致（${left.unit} vs ${right.unit}）` };
            }
        } else if (!options.ignoreUnitIfOneSided) {
            const withUnit = left.unit ? left : right;
            const withoutUnit = left.unit ? right : left;
            const meta = scalarMeta.get(withUnit);
            // 当单边尾部仅是 ASCII 字母（如 2m）而另一侧含自由变量（如 m+m）时，按纯代数式回退比对
            if (meta?.asciiUnit) {
                const leftExpr = left.unit ? (scalarMeta.get(left)?.rawExpr ?? `${left.value}${left.unit}`) : left.value;
                const rightExpr = right.unit ? (scalarMeta.get(right)?.rawExpr ?? `${right.value}${right.unit}`) : right.value;
                try {
                    if (collectFreeVariables(parseSafeNode(withoutUnit.value)).size > 0) {
                        return symbolicCheck(leftExpr, rightExpr, options.epsilon);
                    }
                } catch {
                    // 非法代数表达式则维持缺失单位判定
                }
            }
            return { status: 'failed', reason: '一方缺失单位' };
        }
    }

    if (left.value === right.value && left.value.length > 0) {
        return { status: 'passed', reason: '规范化值精确一致' };
    }

    const leftNum = tryEvaluateNumeric(left.value, options.epsilon);
    const rightNum = tryEvaluateNumeric(right.value, options.epsilon);
    if (leftNum !== null && rightNum !== null) {
        return numericEqual(leftNum, rightNum, options.epsilon)
            ? { status: 'passed', reason: '数值等价' }
            : { status: 'failed', reason: `数值不等（${leftNum} vs ${rightNum}）` };
    }

    return symbolicCheck(left.value, right.value, options.epsilon);
}

/** 结构化比对两个答案，返回 passed / failed / unknown 与明确原因 */
export function checkAnswers(expected: string, actual: string, options: CheckOptions = {}): CheckResult {
    const resolved: Required<CheckOptions> = {
        epsilon: options.epsilon ?? DEFAULT_EPSILON,
        ignoreUnitIfOneSided: options.ignoreUnitIfOneSided ?? false,
    };
    const left = parseAnswer(expected);
    const right = parseAnswer(actual);
    return compareParsed(left, right, resolved);
}

/** 比较两个答案是否一致（仅在结构化比对明确通过时返回 true） */
export function answersEquivalent(expected: string, actual: string, epsilon: number = DEFAULT_EPSILON): boolean {
    return checkAnswers(expected, actual, { epsilon }).status === 'passed';
}

/** 判断表达式（剔除单位后）是否不含任何未绑定自由变量，用于单边方程变量前缀剥离保护 */
export function isConstantScalarExpression(raw: string): boolean {
    const parsed = parseAnswer(raw);
    if (parsed.kind !== 'scalar') return false;
    try {
        return collectFreeVariables(parseSafeNode(parsed.value)).size === 0;
    } catch {
        return false;
    }
}

function extractCandidateRoots(target: string, freeVars: Set<string>, epsilon: number): Array<Record<string, number>> | null {
    const parsed = parseAnswer(target);
    const varList = Array.from(freeVars);

    if (varList.length === 1) {
        const varName = varList[0];
        const scalarItems: ParsedAnswer[] = parsed.kind === 'set' ? parsed.items : [parsed];
        const bindings: Array<Record<string, number>> = [];
        for (const item of scalarItems) {
            if (item.kind !== 'scalar') return null;
            const num = tryEvaluateNumeric(item.value, epsilon);
            if (num === null) return null;
            bindings.push({ [varName]: num });
        }
        return bindings.length > 0 ? bindings : null;
    }

    // 多自由变量需明确按变量名绑定（如 x=1, y=2）
    if (parsed.kind === 'parts') {
        const binding: Record<string, number> = {};
        const partMap = new Map(parsed.parts.map((p) => [p.label.toLowerCase(), p.answer]));
        for (const name of varList) {
            const ans = partMap.get(name.toLowerCase());
            if (!ans || ans.kind !== 'scalar') return null;
            const num = tryEvaluateNumeric(ans.value, epsilon);
            if (num === null) return null;
            binding[name] = num;
        }
        return [binding];
    }

    return null;
}

function equationHolds(expression: string, expected: string): { passed: boolean; actual?: string; detail: string } {
    const sides = expression.split('=').map((part) => part.trim());
    if (sides.length !== 2 || !sides[0] || !sides[1]) throw new Error('INVALID_EQUATION');

    const leftNode = parseSafeNode(sides[0]);
    const rightNode = parseSafeNode(sides[1]);
    const freeVars = new Set([...collectFreeVariables(leftNode), ...collectFreeVariables(rightNode)]);

    // 强制包含至少一个自由未知变量，拒绝 1=1 等无未知数恒等式
    if (freeVars.size === 0) {
        throw new Error('NO_FREE_VARIABLE');
    }

    if (!expected) {
        throw new Error('MISSING_EXPECTED_ROOT');
    }

    const bindings = extractCandidateRoots(expected, freeVars, DEFAULT_EPSILON);
    if (!bindings) {
        throw new Error('UNVERIFIABLE_EQUATION');
    }

    const leftCompiled = leftNode.compile();
    const rightCompiled = rightNode.compile();
    const summaries: string[] = [];
    for (const binding of bindings) {
        const scope = { ...BUILTIN_EVAL_SCOPE, ...binding };
        const leftVal = asNumber(leftCompiled.evaluate(scope));
        const rightVal = asNumber(rightCompiled.evaluate(scope));
        if (leftVal === null || rightVal === null) {
            throw new Error('NON_FINITE_SUBSTITUTION');
        }
        if (!numericEqual(leftVal, rightVal)) {
            return {
                passed: false,
                actual: String(leftVal),
                detail: `代入 ${JSON.stringify(binding)} 后左端=${leftVal} 与右端=${rightVal} 不相等`,
            };
        }
        summaries.push(`${leftVal}=${rightVal}`);
    }

    return {
        passed: true,
        actual: expected,
        detail: `代入全部变量值验算成立（${summaries.join('；')}）`,
    };
}

const specSchema = z.object({
    type: z.enum(['expression', 'equation', 'numeric']),
    expression: z.string(),
    expected: z.string().optional(),
});

/**
 * 用 mathjs 验算可计算题。表达式不合法、缺根冲突或无法计算时 passed=false，交给人工审核。
 */
export function verifyComputable(spec: ComputableSpec | null | undefined, answerText: string): VerifyEvidence {
    if (!spec) {
        return { method: 'none', computable: false, passed: false, detail: '没有可计算表达式，不能自动通过' };
    }
    const parsed = specSchema.safeParse(spec);
    if (!parsed.success) {
        return { method: 'none', computable: false, passed: false, detail: '可计算字段格式无效' };
    }
    const { type, expression, expected } = parsed.data;
    const trimmedAnswer = (answerText || '').trim();
    const trimmedExpected = (expected || '').trim();

    // 若同时提供 spec.expected 与 answerText，必须先证明两者一致
    if (trimmedExpected && trimmedAnswer) {
        const consistency = checkAnswers(trimmedExpected, trimmedAnswer, { ignoreUnitIfOneSided: true });
        if (consistency.status !== 'passed') {
            return {
                method: 'compare',
                computable: consistency.status === 'failed',
                passed: false,
                expected: trimmedExpected,
                actual: trimmedAnswer,
                detail: `spec.expected 与 answerText 不一致：${consistency.reason}`,
            };
        }
    }

    const target = trimmedExpected || trimmedAnswer;
    try {
        if (type === 'equation') {
            const result = equationHolds(expression, target);
            return { method: 'mathjs', computable: true, passed: result.passed, expected: target, actual: result.actual, detail: result.detail };
        }

        if (type === 'numeric') {
            const node = parseSafeNode(expression);
            // numeric 分支严格禁止出现未绑定变量，必须产出有限数值
            if (collectFreeVariables(node).size > 0) {
                throw new Error('NUMERIC_WITH_VARIABLES');
            }
            const actual = asNumber(node.compile().evaluate({ ...BUILTIN_EVAL_SCOPE }));
            if (actual === null) {
                return { method: 'mathjs', computable: false, passed: false, expected: target, detail: '数值分支结果不是有限实数' };
            }
            if (!target) {
                return { method: 'mathjs', computable: true, passed: false, expected: target, actual: String(actual), detail: '缺少待比对的答案' };
            }
            const targetParsed = parseAnswer(target);
            if (targetParsed.kind !== 'scalar') {
                return { method: 'mathjs', computable: true, passed: false, expected: target, actual: String(actual), detail: 'numeric 题型期望单一数值而非复合结构' };
            }
            const targetNum = tryEvaluateNumeric(targetParsed.value, DEFAULT_EPSILON);
            if (targetNum === null) {
                return { method: 'mathjs', computable: true, passed: false, expected: target, actual: String(actual), detail: '答案无法解析为有限数值' };
            }
            const passed = numericEqual(actual, targetNum);
            return {
                method: 'mathjs',
                computable: true,
                passed,
                expected: target,
                actual: String(actual),
                detail: passed ? '纯数值验算一致' : `纯数值验算不一致（${actual} vs ${targetNum}）`,
            };
        }

        // type === 'expression'
        const exprNode = parseSafeNode(expression);
        if (collectFreeVariables(exprNode).size > 0) {
            if (!target) {
                return { method: 'mathjs', computable: false, passed: false, expected: target, detail: '含变量表达式缺少目标答案' };
            }
            const targetParsed = parseAnswer(target);
            if (targetParsed.kind !== 'scalar') {
                return { method: 'mathjs', computable: true, passed: false, expected: target, detail: '表达式答案结构不匹配' };
            }
            const sym = symbolicCheck(assertSafeExpression(expression), targetParsed.value, DEFAULT_EPSILON);
            return {
                method: 'mathjs',
                computable: sym.status !== 'unknown',
                passed: sym.status === 'passed',
                expected: target,
                actual: expression,
                detail: sym.reason,
            };
        }

        const value = evaluateExpression(expression);
        const actual = asNumber(value);
        if (actual === null) {
            return { method: 'mathjs', computable: false, passed: false, expected: target, actual: String(value), detail: '表达式结果不是有限数值' };
        }
        const formatted = math.format(actual, { precision: 14 });
        const checkRaw = target ? checkAnswers(target, String(actual), { ignoreUnitIfOneSided: true }) : null;
        const checkFmt = target ? checkAnswers(target, formatted, { ignoreUnitIfOneSided: true }) : null;
        const passed = Boolean(checkRaw?.status === 'passed' || checkFmt?.status === 'passed');
        return {
            method: 'mathjs',
            computable: true,
            passed,
            expected: target,
            actual: String(actual),
            detail: passed ? '数值/符号验算一致' : '验算结果与给定答案不一致',
        };
    } catch (error) {
        const code = error instanceof Error ? error.message : 'UNVERIFIABLE';
        return { method: 'mathjs', computable: false, passed: false, expected: target, detail: `无法验算：${code}` };
    }
}
