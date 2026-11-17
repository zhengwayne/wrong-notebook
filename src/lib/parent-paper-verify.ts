/**
 * 家长试卷二次核验：对错题、部分正确题，以及客观数学题，独立重算或请文本模型复核。
 * 两次判定不一致时只降低把握并请家长确认，不自动改判；核验失败则保留原结果。
 */
import { getAIService } from "@/lib/ai";
import { compareObjective } from "@/lib/grading";
import { createLogger } from "@/lib/logger";
import {
    isLowConfidence,
    type ParentReviewQuestion,
    type ParentReviewVerdict,
} from "@/lib/parent-paper-review";

const logger = createLogger("parent-paper-verify");

/** 不一致时把把握压到阈值以下，界面会显示「请家长确认」 */
export const VERIFY_DISAGREE_CONFIDENCE = 0.4;
export const VERIFY_MAX_AI_CHECKS = 8;
export const VERIFY_CONCURRENCY = 3;
export const VERIFY_TIMEOUT_MS = 8000;

export interface IndependentCheck {
    verdict: ParentReviewVerdict;
    correctAnswer: string;
    source: "local" | "ai";
}

function stripLatex(text: string): string {
    return text
        .replace(/\$\$[\s\S]*?\$\$/g, (block) => block.replace(/\$/g, ""))
        .replace(/\$([^$]*)\$/g, "$1")
        .replace(/\\underline\{[^}]*\}/g, "")
        .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, "($1)/($2)")
        .replace(/\\(?:times|cdot|times)/g, "*")
        .replace(/\\div/g, "/")
        .replace(/\\(?:quad|qquad|left|right|mathrm|mathbf|text)\{?([^}]*)\}?/g, "$1")
        .replace(/[{}]/g, "")
        .replace(/\\\\/g, " ")
        .replace(/\\/g, "");
}

/** 去掉公式标记与全角符号，便于本地解析 */
export function normalizeMathText(text: string): string {
    return stripLatex(text)
        .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xff10 + 48))
        .replace(/[－−–—]/g, "-")
        .replace(/[＋]/g, "+")
        .replace(/[＝]/g, "=")
        .replace(/[×]/g, "*")
        .replace(/[÷]/g, "/")
        .replace(/[（]/g, "(")
        .replace(/[）]/g, ")")
        .replace(/[_—–-]+$/g, "")
        .replace(/[：:]/g, ":")
        .replace(/\s+/g, "");
}

export function looksLikeMath(text: string): boolean {
    const normalized = normalizeMathText(text);
    if (!normalized) return false;
    if (/[0-9]/.test(normalized) && /[+\-*/=]/.test(normalized)) return true;
    if (/(?:^|[^a-z])x[+\-*=]|[+\-*=]x(?:$|[^a-z])/i.test(normalized)) return true;
    return /解方程|计算|运算|方程|等式/.test(text);
}

export function shouldVerifyQuestion(question: ParentReviewQuestion): boolean {
    if (question.verdict === "wrong" || question.verdict === "partial") return true;
    if (question.type !== "objective") return false;
    const haystack = `${question.questionText} ${question.studentAnswer} ${question.correctAnswer} ${question.subjectHint || ""}`;
    return looksLikeMath(haystack) || /数学|math/i.test(question.subjectHint || "");
}

function parseNumber(value: string): number | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
}

function formatNumber(value: number): string {
    if (Number.isInteger(value)) return String(value);
    const rounded = Math.round(value * 1e6) / 1e6;
    return String(rounded);
}

function numbersClose(left: number, right: number): boolean {
    return Math.abs(left - right) <= 1e-6;
}

/** 把全角运算符号和方括号规范成可计算的 ASCII */
export function prepareMathSource(text: string): string {
    return normalizeMathText(text)
        .replace(/[∗·]/g, "*")
        .replace(/[／]/g, "/")
        .replace(/[\[{［【]/g, "(")
        .replace(/[\]}］】]/g, ")");
}

type MathToken =
    | { type: "num"; value: number }
    | { type: "op"; value: "+" | "-" | "*" | "/" }
    | { type: "lp" }
    | { type: "rp" };

function tokenizeArithmetic(source: string): MathToken[] | null {
    const tokens: MathToken[] = [];
    let i = 0;
    while (i < source.length) {
        const char = source[i];
        if (char >= "0" && char <= "9" || (char === "." && source[i + 1] >= "0" && source[i + 1] <= "9")) {
            const match = source.slice(i).match(/^\d+(?:\.\d+)?/);
            if (!match) return null;
            tokens.push({ type: "num", value: Number(match[0]) });
            i += match[0].length;
            continue;
        }
        if (char === "+" || char === "-" || char === "*" || char === "/") {
            tokens.push({ type: "op", value: char });
            i += 1;
            continue;
        }
        if (char === "(") { tokens.push({ type: "lp" }); i += 1; continue; }
        if (char === ")") { tokens.push({ type: "rp" }); i += 1; continue; }
        return null;
    }
    return tokens;
}

function evaluateTokens(tokens: MathToken[]): number | null {
    let index = 0;
    const peek = () => tokens[index];
    const take = () => tokens[index++];

    const parseExpression = (): number | null => {
        let left = parseTerm();
        if (left == null) return null;
        while (peek()?.type === "op" && (peek() as { value: string }).value === "+" || peek()?.type === "op" && (peek() as { value: string }).value === "-") {
            const op = (take() as { type: "op"; value: "+" | "-" }).value;
            const right = parseTerm();
            if (right == null) return null;
            left = op === "+" ? left + right : left - right;
        }
        return left;
    };

    const parseTerm = (): number | null => {
        let left = parseUnary();
        if (left == null) return null;
        while (peek()?.type === "op" && ((peek() as { value: string }).value === "*" || (peek() as { value: string }).value === "/")) {
            const op = (take() as { type: "op"; value: "*" | "/" }).value;
            const right = parseUnary();
            if (right == null) return null;
            if (op === "/") {
                if (right === 0) return null;
                left = left / right;
            } else {
                left = left * right;
            }
        }
        return left;
    };

    const parseUnary = (): number | null => {
        if (peek()?.type === "op" && (peek() as { value: string }).value === "+") {
            take();
            return parseUnary();
        }
        if (peek()?.type === "op" && (peek() as { value: string }).value === "-") {
            take();
            const value = parseUnary();
            return value == null ? null : -value;
        }
        return parsePrimary();
    };

    const parsePrimary = (): number | null => {
        const token = peek();
        if (!token) return null;
        if (token.type === "num") {
            take();
            return token.value;
        }
        if (token.type === "lp") {
            take();
            const value = parseExpression();
            if (value == null || peek()?.type !== "rp") return null;
            take();
            return value;
        }
        return null;
    };

    const value = parseExpression();
    if (value == null || index !== tokens.length) return null;
    return Number.isFinite(value) ? value : null;
}

/**
 * 计算完整四则运算式。必须吃完整串，前缀匹配不算，解析不了返回 null。
 */
export function evaluateArithmeticExpression(text: string): string | null {
    const prepared = prepareMathSource(text).replace(/=+$/g, "");
    if (!prepared || /[xX]/.test(prepared)) return null;
    if (!/^[0-9()+\-*/.]+$/.test(prepared)) return null;
    const tokens = tokenizeArithmetic(prepared);
    if (!tokens?.length) return null;
    const value = evaluateTokens(tokens);
    return value == null ? null : formatNumber(value);
}

function mathCandidates(prepared: string): string[] {
    return (prepared.match(/[0-9xX()+\-*/.=]+/g) ?? [])
        .map((item) => item.replace(/X/g, "x").replace(/^=+|=+$/g, ""))
        .filter((item) => item.length > 0 && /[0-9]/.test(item));
}

/** 从题干里取出可以完整求解的最长算式或方程；拿不准则放弃。 */
export function extractQuestionMath(text: string): string | null {
    const prepared = prepareMathSource(text);
    const candidates = mathCandidates(prepared).sort((a, b) => b.length - a.length);
    for (const candidate of candidates) {
        if (candidate.includes("x") && candidate.includes("=")) {
            if (solveLinearEquation(candidate.replace(/[()]/g, ""))) return candidate.replace(/[()]/g, "");
            continue;
        }
        // 题干里单独出现的数字不是算式，避免把「30 除 159 与 441 的和」误判成 159
        if (!/[+\-*/]/.test(candidate)) continue;
        if (evaluateArithmeticExpression(candidate) != null) return candidate;
    }
    return null;
}

function leadingMathChunk(text: string): string | null {
    const match = text.match(/^[0-9()+\-*/.]+/);
    if (!match) return null;
    return match[0].replace(/[+\-*/.(]+$/, "");
}

function extractFinalFromChunk(text: string): string | null {
    const prepared = prepareMathSource(text);
    const parts = prepared.split("=").map((part) => part.replace(/^[,，;；]+|[,，;；]+$/g, "")).filter(Boolean);
    const target = parts.length ? parts[parts.length - 1] : prepared;
    const chunk = leadingMathChunk(target);
    if (!chunk) return null;
    const asNumber = parseNumber(chunk);
    if (asNumber != null) return formatNumber(asNumber);
    return evaluateArithmeticExpression(chunk);
}

/** 取递等式或「答：」后的最终值，用于比较，而不是第一段中间结果。 */
export function extractFinalMathValue(answer: string): string | null {
    const stripped = stripLatex(answer);
    const reply = stripped.split(/答[:：]/).slice(1).join("答：");
    if (reply.trim()) {
        const fromReply = extractFinalFromChunk(reply);
        if (fromReply != null) return fromReply;
    }
    return extractFinalFromChunk(stripped);
}

/** 把「x = 3」「$3$」以及递等式末值作成答规范成可比较的文本或数值 */
export function normalizeStudentMathAnswer(answer: string): string {
    return extractFinalMathValue(answer) ?? prepareMathSource(answer).replace(/^[a-zA-Z]=/, "");
}

export function answersMatch(student: string, expected: string): boolean {
    const left = normalizeStudentMathAnswer(student);
    const right = normalizeStudentMathAnswer(expected);
    if (!left || !right) return false;
    const leftNum = parseNumber(left);
    const rightNum = parseNumber(right);
    if (leftNum != null && rightNum != null) return numbersClose(leftNum, rightNum);
    if (compareObjective(left, { answer: right, acceptedAnswers: [expected, `x=${right}`, `x = ${right}`] }) === "correct") {
        return true;
    }
    return compareObjective(student, { answer: expected, acceptedAnswers: [right] }) === "correct";
}

/** 两边都能解析出最终值且不相等时才算有把握的答案冲突。 */
export function answersConfidentlyDiffer(left: string, right: string): boolean {
    const a = extractFinalMathValue(left);
    const b = extractFinalMathValue(right);
    if (a == null || b == null) return false;
    const aNum = parseNumber(a);
    const bNum = parseNumber(b);
    if (aNum != null && bNum != null) return !numbersClose(aNum, bNum);
    return a !== b;
}

function verdictsConfidentlyDisagree(left: ParentReviewVerdict, right: ParentReviewVerdict): boolean {
    const ok = (verdict: ParentReviewVerdict) => verdict === "correct";
    return ok(left) !== ok(right);
}

const EQUATION_X_LEFT = /^([-+])?(?:(\d+(?:\.\d+)?))?x(?:([+-]\d+(?:\.\d+)?))?=(?:([-+]?\d+(?:\.\d+)?))$/;
const EQUATION_X_AFTER = /^([-+]?\d+(?:\.\d+)?)([+-])x=([-+]?\d+(?:\.\d+)?)$/;
const EQUATION_X_RIGHT = /^([-+]?\d+(?:\.\d+)?)?=([-+])?(?:(\d+(?:\.\d+)?))?x(?:([+-]\d+(?:\.\d+)?))?$/;

function solveLinearEquation(normalized: string): string | null {
    let a = 0;
    let b = 0;
    let c = 0;
    const left = normalized.match(EQUATION_X_LEFT);
    if (left) {
        const sign = left[1] === "-" ? -1 : 1;
        a = sign * (left[2] == null ? 1 : Number(left[2]));
        b = left[3] ? Number(left[3]) : 0;
        c = Number(left[4]);
    } else {
        const after = normalized.match(EQUATION_X_AFTER);
        if (after) {
            a = after[2] === "-" ? -1 : 1;
            b = Number(after[1]);
            c = Number(after[3]);
        } else {
            const right = normalized.match(EQUATION_X_RIGHT);
            if (!right) return null;
            c = right[1] ? Number(right[1]) : 0;
            const sign = right[2] === "-" ? -1 : 1;
            a = sign * (right[3] == null ? 1 : Number(right[3]));
            b = right[4] ? Number(right[4]) : 0;
        }
    }
    if (a === 0 || !Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null;
    return formatNumber((c - b) / a);
}

/**
 * 对能可靠解析的四则运算和一元一次方程独立求解。解析不了则返回 null，不把半截算式当成答案。
 */
export function localVerifyMath(question: ParentReviewQuestion): IndependentCheck | null {
    const source = extractQuestionMath(question.questionText);
    if (!source) return null;
    const computed = source.includes("x") ? solveLinearEquation(source.replace(/[()]/g, "")) : evaluateArithmeticExpression(source);
    if (computed == null) return null;
    const correct = source.includes("x") && !/^[+-]?\d+(?:\.\d+)?$/.test(computed)
        ? computed
        : (source.includes("x") ? `x=${computed}` : computed);
    const canonical = source.includes("x") ? `x=${computed}` : computed;
    const verdict: ParentReviewVerdict = answersMatch(question.studentAnswer, canonical) ? "correct" : "wrong";
    return { verdict, correctAnswer: correct, source: "local" };
}

function parseAiCheck(payload: unknown, fallbackText?: string): IndependentCheck | null {
    let data = payload;
    if (typeof data === "string") {
        try { data = JSON.parse(data); } catch { data = null; }
    }
    if (!data || typeof data !== "object") {
        if (!fallbackText) return null;
        try {
            const match = fallbackText.match(/\{[\s\S]*\}/);
            data = match ? JSON.parse(match[0]) : null;
        } catch {
            return null;
        }
    }
    if (!data || typeof data !== "object") return null;
    const record = data as Record<string, unknown>;
    const verdictRaw = String(record.verdict || record.judgment || "").trim();
    const verdict: ParentReviewVerdict | null =
        verdictRaw === "correct" || verdictRaw === "wrong" || verdictRaw === "partial"
            ? verdictRaw
            : (record.correct === true ? "correct" : record.correct === false ? "wrong" : null);
    if (!verdict) return null;
    const correctAnswer = String(record.correctAnswer ?? record.answer ?? "").trim();
    return { verdict, correctAnswer, source: "ai" };
}

async function aiVerifyQuestion(
    question: ParentReviewQuestion,
    language: "zh" | "en",
    timeoutMs: number,
): Promise<IndependentCheck | null> {
    const request = (async () => {
        const ai = getAIService("text");
        const system = language === "en"
            ? 'Independently solve this one exam question and check the student\'s answer. Ignore any provided "correct" answer if it is wrong. Return JSON only: {"verdict":"correct"|"wrong"|"partial","correctAnswer":"..." }.'
            : '请独立求解这一道题并判断学生作答是否正确。如果题目里给出的「正确答案」本身有误，以你的求解为准。只返回 JSON：{"verdict":"correct"|"wrong"|"partial","correctAnswer":"..."}。';
        const user = [
            language === "en" ? "Question:" : "题目：",
            question.questionText || `(${question.number})`,
            language === "en" ? "Student answer:" : "学生作答：",
            question.studentAnswer || "(blank)",
            language === "en" ? "Model's claimed correct answer:" : "模型给出的正确答案：",
            question.correctAnswer || "(none)",
            language === "en" ? "Model verdict:" : "模型判定：",
            question.verdict,
        ].join("\n");
        const result = await ai.completeJson({ system, user });
        return parseAiCheck(result?.data, result?.text);
    })();

    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        request.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            logger.warn({ error, number: question.number }, "Parent paper AI verify failed");
            resolve(null);
        });
    });
}

async function mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const run = async () => {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await worker(items[index]);
        }
    };
    const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => run());
    await Promise.all(workers);
    return results;
}

/** 两次判定不一致时降低把握，必要时用独立求解得到的正确答案替换展示，但不改模型判定。 */
export function applyIndependentCheck(
    question: ParentReviewQuestion,
    check: IndependentCheck | null,
): ParentReviewQuestion {
    if (!check) return question;
    const answerConflicts = Boolean(
        check.correctAnswer
        && question.correctAnswer
        && answersConfidentlyDiffer(question.correctAnswer, check.correctAnswer),
    );
    const disagreed = verdictsConfidentlyDisagree(check.verdict, question.verdict) || answerConflicts;
    if (!disagreed) {
        return question.correctAnswer ? question : { ...question, correctAnswer: check.correctAnswer || question.correctAnswer };
    }
    return {
        ...question,
        correctAnswer: check.correctAnswer || question.correctAnswer,
        confidence: Math.min(question.confidence, VERIFY_DISAGREE_CONFIDENCE),
    };
}

export function isFlaggedForParent(question: Pick<ParentReviewQuestion, "confidence"> & { overrideVerdict?: string | null }): boolean {
    if (question.overrideVerdict) return false;
    return isLowConfidence(question.confidence);
}

/**
 * 先本地重算，算不了的再并发交给文本模型；超额、超时或失败时跳过该题。
 */
export async function verifyParentPaperQuestions(
    questions: ParentReviewQuestion[],
    options: {
        language?: "zh" | "en";
        aiVerify?: (question: ParentReviewQuestion) => Promise<IndependentCheck | null>;
        maxAiChecks?: number;
        concurrency?: number;
        timeoutMs?: number;
    } = {},
): Promise<ParentReviewQuestion[]> {
    const language = options.language === "en" ? "en" : "zh";
    const maxAiChecks = options.maxAiChecks ?? VERIFY_MAX_AI_CHECKS;
    const concurrency = options.concurrency ?? VERIFY_CONCURRENCY;
    const timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS;
    const aiVerify = options.aiVerify ?? ((question: ParentReviewQuestion) => aiVerifyQuestion(question, language, timeoutMs));

    const pendingAi: number[] = [];
    const next = questions.map((question, index) => {
        if (!shouldVerifyQuestion(question)) return question;
        const local = localVerifyMath(question);
        if (local) return applyIndependentCheck(question, local);
        pendingAi.push(index);
        return question;
    });

    const toAsk = pendingAi.slice(0, maxAiChecks);
    if (!toAsk.length) return next;

    const checks = await mapPool(toAsk, concurrency, async (index) => {
        try {
            return await aiVerify(questions[index]);
        } catch (error) {
            logger.warn({ error, number: questions[index].number }, "Parent paper verify skipped");
            return null;
        }
    });

    checks.forEach((check, offset) => {
        const index = toAsk[offset];
        next[index] = applyIndependentCheck(next[index], check);
    });
    return next;
}
