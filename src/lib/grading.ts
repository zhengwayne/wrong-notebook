/**
 * 老师收卷改卷的纯逻辑：答案快速录入解析、客观题比对、得分计算、班级汇总。
 * 不访问数据库和 AI，便于单元测试。
 *
 * 设计参考 OMRChecker（MIT）的 evaluation.json：题号区间写法（q1..22）、
 * 每题可接受多种答案、按题设置分值；此处为独立实现，未复制其代码。
 */
import { normalizeAnswer } from "@/lib/answer-match";

export const GRADING_QUESTION_TYPES = ['objective', 'subjective'] as const;
export type GradingQuestionType = typeof GRADING_QUESTION_TYPES[number];
export const GRADING_VERDICTS = ['correct', 'partial', 'wrong', 'blank'] as const;
export type GradingVerdict = typeof GRADING_VERDICTS[number];
export const MAX_GRADING_QUESTIONS = 100;

export interface KeyQuestionInput {
    number: string;
    type: GradingQuestionType;
    maxScore: number;
    answer: string;
    acceptedAnswers?: string[];
    questionText?: string | null;
    knowledgePoints?: string[];
}

/** 判分用的题目（数据库中的 GradingKeyQuestion 解析 JSON 字段后） */
export interface KeyQuestion extends KeyQuestionInput {
    id: string;
    order: number;
}

/** AI 读卷结果中一题的作答 */
export interface ReadAnswer {
    number: string;
    answer: string;
    /** 主观题的 AI 建议分 */
    score?: number | null;
    reason?: string | null;
}

export interface GradedQuestion {
    keyQuestionId: string;
    studentAnswer: string;
    verdict: GradingVerdict;
    score: number;
    aiScore: number | null;
    reason: string | null;
    source: 'auto' | 'ai' | 'teacher';
}

const CHOICE_ONLY = /^[A-Ha-h]{1,8}$/;

/** 把 "1-5"、"1..5"、"1~5" 展开为题号数组；单个题号原样返回 */
export function expandNumberRange(token: string): string[] {
    const match = token.trim().match(/^(\d+)\s*(?:-|\.\.|~|～|—|至)\s*(\d+)$/);
    if (!match) return [token.trim()];
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (end < start || end - start >= MAX_GRADING_QUESTIONS) return [token.trim()];
    return Array.from({ length: end - start + 1 }, (_, i) => String(start + i));
}

/**
 * 解析老师快速录入的答案，每行一条：
 * - `1-5 ABCDA`：连续选择题，每题 1 个字母（多选题用空格分隔：`6-7 AB CD`）
 * - `8 B 3分` / `8 B 3`：单题答案与分值
 * - `9 x=2|x=2.0 4分`：竖线分隔多种可接受答案
 * - `13 主观 10分 答案要点…`：主观题，后面为参考答案
 * 未写分值时默认 defaultScore。无法识别的行返回在 errors 中（行号从 1 开始）。
 */
export function parseQuickAnswerKey(text: string, defaultScore = 1): { questions: KeyQuestionInput[]; errors: number[] } {
    const questions: KeyQuestionInput[] = [];
    const errors: number[] = [];
    const lines = text.split(/\r?\n/);
    lines.forEach((rawLine, index) => {
        const line = rawLine.trim();
        if (!line) return;
        const match = line.match(/^(?:第\s*)?(\d+(?:\s*(?:-|\.\.|~|～|—|至)\s*\d+)?|\d+\(\d+\)|\d+（\d+）)\s*[题.、:：)]?\s*(.*)$/);
        if (!match || !match[2]) {
            errors.push(index + 1);
            return;
        }
        const numbers = expandNumberRange(match[1].replace(/\s+/g, ''));
        let rest = match[2].trim();
        let score = defaultScore;
        let type: GradingQuestionType = 'objective';

        const subjective = rest.match(/^(?:主观|解答|subjective)\s*/i);
        if (subjective) {
            type = 'subjective';
            rest = rest.slice(subjective[0].length);
            const scoreMatch = rest.match(/^(\d+(?:\.\d+)?)\s*(?:分|pts?|points?)?\s*/i);
            if (scoreMatch) {
                score = Number(scoreMatch[1]);
                rest = rest.slice(scoreMatch[0].length);
            }
        } else {
            const scoreMatch = rest.match(/\s+(\d+(?:\.\d+)?)\s*(?:分|pts?|points?)?$/i);
            if (scoreMatch && rest.slice(0, scoreMatch.index).trim()) {
                score = Number(scoreMatch[1]);
                rest = rest.slice(0, scoreMatch.index).trim();
            }
        }

        if (numbers.length > 1) {
            const parts = rest.includes(' ') ? rest.split(/\s+/) : [...rest.replace(/\s+/g, '')];
            if (type !== 'objective' || parts.length !== numbers.length) {
                errors.push(index + 1);
                return;
            }
            numbers.forEach((number, i) => questions.push({ number, type, maxScore: score, answer: parts[i].toUpperCase() }));
            return;
        }

        const [answer, ...alternatives] = rest.split('|').map((part) => part.trim()).filter(Boolean);
        if (type === 'objective' && !answer) {
            errors.push(index + 1);
            return;
        }
        questions.push({
            number: numbers[0],
            type,
            maxScore: score,
            answer: answer ? (CHOICE_ONLY.test(answer) ? answer.toUpperCase() : answer) : '',
            ...(alternatives.length ? { acceptedAnswers: alternatives } : {}),
        });
    });
    return { questions: questions.slice(0, MAX_GRADING_QUESTIONS), errors };
}

function sortedLetters(value: string): string {
    return [...value.toUpperCase()].sort().join('');
}

/** 客观题比对：选择题忽略字母顺序与大小写，其他题按规范化后的文本完全一致判定 */
export function compareObjective(studentAnswer: string, key: Pick<KeyQuestionInput, 'answer' | 'acceptedAnswers'>): 'correct' | 'wrong' | 'blank' {
    const student = normalizeAnswer(studentAnswer || '');
    if (!student) return 'blank';
    const candidates = [key.answer, ...(key.acceptedAnswers || [])].filter((value) => value && value.trim());
    for (const candidate of candidates) {
        const expected = normalizeAnswer(candidate);
        if (!expected) continue;
        if (student === expected) return 'correct';
        const studentLetters = student.replace(/^\((.*)\)$/, '$1');
        if (CHOICE_ONLY.test(expected) && CHOICE_ONLY.test(studentLetters) && sortedLetters(studentLetters) === sortedLetters(expected)) {
            return 'correct';
        }
    }
    return 'wrong';
}

/** 把分数限制在 [0, max]，保留半分精度 */
export function clampScore(score: number, max: number): number {
    if (!Number.isFinite(score)) return 0;
    return Math.round(Math.min(Math.max(score, 0), max) * 2) / 2;
}

/** 根据得分推断判定：满分为对、0 分为错、介于之间为部分得分 */
export function verdictFromScore(score: number, max: number, blank = false): GradingVerdict {
    if (blank && score <= 0) return 'blank';
    if (max > 0 && score >= max) return 'correct';
    if (score <= 0) return 'wrong';
    return 'partial';
}

/** 按题号匹配 AI 读出的作答（忽略空格与全角括号差异） */
function normalizeNumber(value: string): string {
    return value.replace(/[（]/g, '(').replace(/[）]/g, ')').replace(/\s+/g, '').replace(/^第|题$/g, '');
}

/**
 * 对照答案给一份答卷判分：客观题本地比对（不依赖 AI 判断对错），
 * 主观题采用 AI 建议分（缺失时记 0 分并等待老师复核）。
 */
export function gradeAnswers(questions: KeyQuestion[], answers: ReadAnswer[]): GradedQuestion[] {
    const byNumber = new Map(answers.map((answer) => [normalizeNumber(answer.number), answer]));
    return questions.map((question) => {
        const read = byNumber.get(normalizeNumber(question.number));
        const studentAnswer = (read?.answer || '').trim();
        if (question.type === 'objective') {
            const verdict = compareObjective(studentAnswer, question);
            return {
                keyQuestionId: question.id,
                studentAnswer,
                verdict,
                score: verdict === 'correct' ? question.maxScore : 0,
                aiScore: null,
                reason: null,
                source: 'auto',
            };
        }
        const aiScore = typeof read?.score === 'number' ? clampScore(read.score, question.maxScore) : null;
        const score = aiScore ?? 0;
        return {
            keyQuestionId: question.id,
            studentAnswer,
            verdict: verdictFromScore(score, question.maxScore, !studentAnswer),
            score,
            aiScore,
            reason: read?.reason?.trim() || null,
            source: 'ai',
        };
    });
}

/** 老师一键改判：correct 给满分，wrong 给 0 分，指定 score 时按分数推断判定 */
export function applyTeacherOverride(
    maxScore: number,
    override: { verdict?: GradingVerdict; score?: number },
): Pick<GradedQuestion, 'verdict' | 'score' | 'source'> {
    if (typeof override.score === 'number') {
        const score = clampScore(override.score, maxScore);
        return { score, verdict: verdictFromScore(score, maxScore), source: 'teacher' };
    }
    switch (override.verdict) {
        case 'correct': return { verdict: 'correct', score: maxScore, source: 'teacher' };
        case 'partial': return { verdict: 'partial', score: clampScore(maxScore / 2, maxScore), source: 'teacher' };
        case 'blank': return { verdict: 'blank', score: 0, source: 'teacher' };
        default: return { verdict: 'wrong', score: 0, source: 'teacher' };
    }
}

export function totalScore(results: Pick<GradedQuestion, 'score'>[]): number {
    return Math.round(results.reduce((sum, result) => sum + result.score, 0) * 2) / 2;
}

/** 未满分的题需要导入错题本 */
export function isWrong(verdict: string): boolean {
    return verdict !== 'correct';
}

/** 姓名匹配：AI 读出的姓名与花名册比对（忽略空格），唯一匹配时返回学生 ID */
export function matchStudentByName<T extends { id: string; name: string }>(detected: string | null | undefined, roster: T[]): string | null {
    const name = (detected || '').replace(/\s+/g, '');
    if (!name) return null;
    const exact = roster.filter((student) => student.name.replace(/\s+/g, '') === name);
    if (exact.length === 1) return exact[0].id;
    if (exact.length > 1) return null;
    const fuzzy = roster.filter((student) => {
        const candidate = student.name.replace(/\s+/g, '');
        return candidate.length >= 2 && (candidate.includes(name) || name.includes(candidate));
    });
    return fuzzy.length === 1 ? fuzzy[0].id : null;
}

/** 解析花名册：按换行、逗号、顿号分隔，去重 */
export function parseRoster(text: string): string[] {
    const names = text.split(/[\n,，、;；\t]+/).map((name) => name.trim()).filter(Boolean);
    return [...new Set(names)].slice(0, 200);
}

export interface SummaryInput {
    questions: KeyQuestion[];
    submissions: {
        id: string;
        studentName: string | null;
        status: string;
        totalScore: number | null;
        results: { keyQuestionId: string; verdict: string; score: number }[];
    }[];
}

export interface TaskSummary {
    fullScore: number;
    gradedCount: number;
    averageScore: number | null;
    highestScore: number | null;
    lowestScore: number | null;
    questions: { id: string; number: string; maxScore: number; answered: number; wrong: number; errorRate: number; averageScore: number }[];
    students: { submissionId: string; name: string; score: number | null; status: string; wrongNumbers: string[] }[];
    weakPoints: { name: string; wrong: number; total: number; errorRate: number }[];
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** 班级汇总：每题错误率、每位学生得分、共性薄弱知识点（按错误率降序） */
export function summarizeTask({ questions, submissions }: SummaryInput): TaskSummary {
    const graded = submissions.filter((submission) => submission.results.length > 0);
    const scores = graded.map((submission) => submission.totalScore ?? totalScore(submission.results));
    const numberById = new Map(questions.map((question) => [question.id, question.number]));

    const questionStats = questions.map((question) => {
        const results = graded.flatMap((submission) => submission.results.filter((result) => result.keyQuestionId === question.id));
        const wrong = results.filter((result) => isWrong(result.verdict)).length;
        const sum = results.reduce((acc, result) => acc + result.score, 0);
        return {
            id: question.id,
            number: question.number,
            maxScore: question.maxScore,
            answered: results.length,
            wrong,
            errorRate: results.length ? round1((wrong / results.length) * 100) : 0,
            averageScore: results.length ? round1(sum / results.length) : 0,
        };
    });

    const points = new Map<string, { wrong: number; total: number }>();
    questions.forEach((question, index) => {
        const stat = questionStats[index];
        for (const name of question.knowledgePoints || []) {
            const entry = points.get(name) || { wrong: 0, total: 0 };
            entry.wrong += stat.wrong;
            entry.total += stat.answered;
            points.set(name, entry);
        }
    });

    return {
        fullScore: totalScore(questions.map((question) => ({ score: question.maxScore }))),
        gradedCount: graded.length,
        averageScore: scores.length ? round1(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
        highestScore: scores.length ? Math.max(...scores) : null,
        lowestScore: scores.length ? Math.min(...scores) : null,
        questions: questionStats,
        students: submissions
            .map((submission) => ({
                submissionId: submission.id,
                name: submission.studentName || '',
                score: submission.results.length ? (submission.totalScore ?? totalScore(submission.results)) : null,
                status: submission.status,
                wrongNumbers: submission.results.filter((result) => isWrong(result.verdict)).map((result) => numberById.get(result.keyQuestionId) || ''),
            }))
            .sort((a, b) => (b.score ?? -1) - (a.score ?? -1)),
        weakPoints: [...points.entries()]
            .map(([name, entry]) => ({ name, ...entry, errorRate: entry.total ? round1((entry.wrong / entry.total) * 100) : 0 }))
            .filter((entry) => entry.wrong > 0)
            .sort((a, b) => b.errorRate - a.errorRate || b.wrong - a.wrong)
            .slice(0, 10),
    };
}

function csvCell(value: string | number | null): string {
    const text = value === null ? '' : String(value);
    // 以公式字符开头时加单引号，防止表格软件执行公式
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** 导出成绩 CSV：姓名、总分、各题得分 */
export function buildScoresCsv(input: SummaryInput, headers: { name: string; total: string }): string {
    const rows = [[headers.name, headers.total, ...input.questions.map((question) => question.number)]];
    for (const submission of input.submissions) {
        const byQuestion = new Map(submission.results.map((result) => [result.keyQuestionId, result.score]));
        rows.push([
            submission.studentName || '',
            submission.results.length ? String(submission.totalScore ?? totalScore(submission.results)) : '',
            ...input.questions.map((question) => {
                const score = byQuestion.get(question.id);
                return score === undefined ? '' : String(score);
            }),
        ]);
    }
    return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

/** 解析数据库中的 JSON 字符串数组字段 */
export function parseJsonStringArray(value: string | null | undefined): string[] {
    if (!value) return [];
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
        return [];
    }
}
