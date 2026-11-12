/**
 * 对可计算数学题做符号/数值验算。只解析受限的数学表达式，绝不执行模型生成的代码。
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

const SAFE_EXPR = /^[\s0-9a-zA-Z+\-*/^().,_<>=!|]+$/;
const MAX_EXPR_LENGTH = 400;
const EPSILON = 1e-8;

export interface VerifyEvidence {
    method: 'mathjs' | 'compare' | 'none';
    computable: boolean;
    passed: boolean;
    expected?: string;
    actual?: string;
    detail: string;
}

function assertSafeExpression(expr: string): string {
    const trimmed = expr.replace(/\s+/g, ' ').trim();
    if (!trimmed || trimmed.length > MAX_EXPR_LENGTH) throw new Error('EXPRESSION_TOO_LONG');
    if (!SAFE_EXPR.test(trimmed)) throw new Error('UNSAFE_EXPRESSION');
    return trimmed;
}

function assertSafeNode(node: MathNode): void {
    node.traverse((item) => {
        const type = item.type;
        if (type === 'AssignmentNode' || type === 'FunctionAssignmentNode' || type === 'BlockNode' || type === 'AccessorNode') {
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

function evaluateExpression(expr: string): unknown {
    const safe = assertSafeExpression(expr);
    const node = math.parse(safe);
    assertSafeNode(node);
    return node.compile().evaluate({});
}

function asNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
    }
    if (value && typeof value === 'object' && 're' in (value as object) && typeof (value as { re: unknown }).re === 'number') {
        const imag = (value as { im?: number }).im ?? 0;
        if (Math.abs(imag) < EPSILON) return (value as { re: number }).re;
    }
    return null;
}

/** 规范化答案文本：全角、空格、百分号、常见分数写法 */
export function normalizeAnswer(value: string | null | undefined): string {
    return (value || '')
        .normalize('NFC')
        .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
        .replace(/（/g, '(').replace(/）/g, ')')
        .replace(/[ \t]+/g, '')
        .replace(/[。．]/g, '.')
        .replace(/%/g, '/100')
        .replace(/或|或者|,|，|;|；/g, '|')
        .trim()
        .toLowerCase();
}

function splitAlternatives(value: string): string[] {
    return normalizeAnswer(value).split('|').map((part) => part.trim()).filter(Boolean);
}

function numericEqual(left: number, right: number): boolean {
    const scale = Math.max(1, Math.abs(left), Math.abs(right));
    return Math.abs(left - right) <= EPSILON * scale;
}

function symbolicEqual(left: string, right: string): boolean {
    try {
        const diff = evaluateExpression(`(${left})-(${right})`);
        const number = asNumber(diff);
        if (number !== null) return numericEqual(number, 0);
        const text = String(math.simplify(`(${left})-(${right})`));
        return text === '0';
    } catch {
        return false;
    }
}

/** 比较两个答案是否一致（数值、符号或规范化文本，支持「或」连接的多种答案） */
export function answersEquivalent(expected: string, actual: string): boolean {
    const lefts = splitAlternatives(expected);
    const rights = splitAlternatives(actual);
    if (lefts.length === 0 || rights.length === 0) return false;
    return lefts.some((left) => rights.some((right) => {
        if (left === right) return true;
        const leftNumber = asNumber(tryEvaluate(left));
        const rightNumber = asNumber(tryEvaluate(right));
        if (leftNumber !== null && rightNumber !== null) return numericEqual(leftNumber, rightNumber);
        return symbolicEqual(left, right);
    }));
}

function tryEvaluate(expr: string): unknown {
    try {
        return evaluateExpression(expr);
    } catch {
        const numeric = Number(expr);
        return Number.isFinite(numeric) ? numeric : null;
    }
}

function equationHolds(expression: string, expected?: string): { passed: boolean; actual?: string; detail: string } {
    const sides = expression.split('=').map((part) => part.trim());
    if (sides.length !== 2) throw new Error('INVALID_EQUATION');
    if (expected) {
        // 把答案代入含未知数的一端，或直接比较两端与期望值
        const substituted = sides.map((side) => side.replace(/\b([a-zA-Z])\b/g, (letter) => {
            if (ALLOWED_FUNCTIONS.has(letter)) return letter;
            return `(${expected})`;
        }));
        try {
            const left = asNumber(evaluateExpression(substituted[0]));
            const right = asNumber(evaluateExpression(substituted[1]));
            if (left !== null && right !== null) {
                return { passed: numericEqual(left, right), actual: String(left), detail: `代入后 ${left} 与 ${right}` };
            }
        } catch {
            // 再尝试比较两端表达式
        }
    }
    try {
        const left = asNumber(evaluateExpression(sides[0]));
        const right = asNumber(evaluateExpression(sides[1]));
        if (left !== null && right !== null) {
            return { passed: numericEqual(left, right), actual: String(left), detail: `方程两端 ${left} 与 ${right}` };
        }
    } catch {
        // 无法求值则视为不可验证
    }
    throw new Error('UNVERIFIABLE_EQUATION');
}

const specSchema = z.object({
    type: z.enum(['expression', 'equation', 'numeric']),
    expression: z.string(),
    expected: z.string().optional(),
});

/**
 * 用 mathjs 验算可计算题。表达式不合法或无法计算时 passed=false、computable=false，交给人工审核。
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
    const target = (expected || answerText || '').trim();
    try {
        if (type === 'equation') {
            const result = equationHolds(expression, target);
            return { method: 'mathjs', computable: true, passed: result.passed, expected: target, actual: result.actual, detail: result.detail };
        }
        const value = evaluateExpression(type === 'numeric' && !/[+\-*/^()]/.test(expression) ? expression : expression);
        const actual = asNumber(value);
        if (actual === null) {
            return { method: 'mathjs', computable: false, passed: false, expected: target, actual: String(value), detail: '表达式结果不是有限数值' };
        }
        const passed = target ? answersEquivalent(target, String(actual)) || answersEquivalent(target, math.format(actual, { precision: 14 })) : false;
        return { method: 'mathjs', computable: true, passed, expected: target, actual: String(actual), detail: passed ? '数值/符号验算一致' : '验算结果与给定答案不一致' };
    } catch (error) {
        const code = error instanceof Error ? error.message : 'UNVERIFIABLE';
        return { method: 'mathjs', computable: false, passed: false, expected: target, detail: `无法验算：${code}` };
    }
}
