/**
 * AI Schema 单元测试
 *
 * 测试 Zod 验证 schema，特别是新增的错因分析字段
 */
import { describe, it, expect } from 'vitest';
import { ParsedQuestionSchema, safeParseParsedQuestion, parseMasteryEvaluation, extractJsonObject, normalizeSubject, parseTagSuggestion, parseDifficultyStars } from '@/lib/ai/schema';

describe('ParsedQuestionSchema 验证', () => {
    const validBaseQuestion = {
        questionText: '求解方程 2x + 3 = 7',
        answerText: 'x = 2',
        analysis: '移项后计算得出 x = 2',
        subject: '数学',
        knowledgePoints: ['一元一次方程'],
        requiresImage: false,
    };

    describe('基础字段验证', () => {
        it('应该接受有效的基础题目数据', () => {
            const result = ParsedQuestionSchema.safeParse(validBaseQuestion);
            expect(result.success).toBe(true);
        });

        it('questionText 不能为空', () => {
            const result = ParsedQuestionSchema.safeParse({
                ...validBaseQuestion,
                questionText: '',
            });
            expect(result.success).toBe(false);
        });

        it('answerText 不能为空', () => {
            const result = ParsedQuestionSchema.safeParse({
                ...validBaseQuestion,
                answerText: '',
            });
            expect(result.success).toBe(false);
        });

        it('analysis 不能为空', () => {
            const result = ParsedQuestionSchema.safeParse({
                ...validBaseQuestion,
                analysis: '',
            });
            expect(result.success).toBe(false);
        });
    });

    describe('错因分析字段验证', () => {
        it('应该接受包含完整错因分析的数据', () => {
            const result = ParsedQuestionSchema.safeParse({
                ...validBaseQuestion,
                wrongAnswerText: 'x = 4',
                mistakeAnalysis: '计算错误',
                mistakeStatus: 'wrong_attempt',
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.wrongAnswerText).toBe('x = 4');
                expect(result.data.mistakeAnalysis).toBe('计算错误');
                expect(result.data.mistakeStatus).toBe('wrong_attempt');
            }
        });

        it('错因字段缺失时应该使用默认值', () => {
            const result = ParsedQuestionSchema.safeParse(validBaseQuestion);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.wrongAnswerText).toBe('');
                expect(result.data.mistakeAnalysis).toBe('');
                expect(result.data.mistakeStatus).toBe('unknown');
            }
        });

        it('mistakeStatus 只接受合法值', () => {
            const validStatuses = ['not_attempted', 'wrong_attempt', 'unknown'];

            validStatuses.forEach(status => {
                const result = ParsedQuestionSchema.safeParse({
                    ...validBaseQuestion,
                    mistakeStatus: status,
                });
                expect(result.success).toBe(true);
            });
        });

        it('mistakeStatus 拒绝非法值', () => {
            const result = ParsedQuestionSchema.safeParse({
                ...validBaseQuestion,
                mistakeStatus: 'invalid_status',
            });
            expect(result.success).toBe(false);
        });

        it('wrongAnswerText 可以为空字符串', () => {
            const result = ParsedQuestionSchema.safeParse({
                ...validBaseQuestion,
                wrongAnswerText: '',
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.wrongAnswerText).toBe('');
            }
        });

        it('mistakeAnalysis 可以为空字符串', () => {
            const result = ParsedQuestionSchema.safeParse({
                ...validBaseQuestion,
                mistakeAnalysis: '',
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.mistakeAnalysis).toBe('');
            }
        });
    });

    describe('safeParseParsedQuestion', () => {
        it('应该安全解析有效数据', () => {
            const result = safeParseParsedQuestion(validBaseQuestion);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.questionText).toBe(validBaseQuestion.questionText);
            }
        });

        it('应该安全解析包含错因的数据', () => {
            const dataWithMistake = {
                ...validBaseQuestion,
                wrongAnswerText: 'x = 4',
                mistakeStatus: 'wrong_attempt',
            };
            const result = safeParseParsedQuestion(dataWithMistake);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.wrongAnswerText).toBe('x = 4');
                expect(result.data.mistakeStatus).toBe('wrong_attempt');
            }
        });

        it('无效数据应该返回失败结果', () => {
            const result = safeParseParsedQuestion({
                ...validBaseQuestion,
                questionText: '',
            });
            expect(result.success).toBe(false);
        });
    });
});

describe('掌握概率解析与学科规范化', () => {
    it('兼容代码块和前后多余文字', () => {
        expect(extractJsonObject('结果：```json\n{"a": 1}\n```')).toEqual({ a: 1 });
        expect(parseMasteryEvaluation('好的 {"probability": "64", "reason": "一般"} 以上')).toEqual({ probability: 0.64, reason: '一般' });
    });

    it('缺少理由或概率越界时报错', () => {
        expect(() => parseMasteryEvaluation('{"probability": 50}')).toThrow();
        expect(() => parseMasteryEvaluation('{"probability": -1, "reason": "x"}')).toThrow();
    });

    it('只接受预设学科', () => {
        expect(normalizeSubject(' 物理 ')).toBe('物理');
        expect(normalizeSubject('天文')).toBeUndefined();
        expect(normalizeSubject(null)).toBeUndefined();
    });
});

describe('知识点选取结果解析', () => {
    const allowed = ['植树问题', '鸡兔同笼', '相遇问题', '追及问题', '年龄问题', '周期问题初步'];

    it('只保留清单内的标签，去重并限制 5 个', () => {
        const text = '{"tags": [" 植树问题", "自创知识点", "植树问题", "鸡兔同笼", "相遇问题", "追及问题", "年龄问题", "周期问题初步"]}';
        expect(parseTagSuggestion(text, allowed).tags).toEqual(['植树问题', '鸡兔同笼', '相遇问题', '追及问题', '年龄问题']);
    });

    it('格式不正确时报错', () => {
        expect(() => parseTagSuggestion('{"tag": "植树问题"}', allowed)).toThrow();
    });
});

describe('parseDifficultyStars', () => {
    it.each([
        [3, 3], ['4', 4], [' 2 星 ', 2], ['★★★', 3], ['⭐⭐⭐⭐⭐', 5], ['3.4', 3], [4.6, 5],
    ])('识别 %j 为 %i 星', (input, expected) => {
        expect(parseDifficultyStars(input)).toBe(expected);
    });

    it.each([[0], [6], ['七星'], [''], [null], [undefined], [Number.NaN], [{}]])('无法识别或越界的 %j 返回 null', (input) => {
        expect(parseDifficultyStars(input)).toBeNull();
    });

    it('知识点建议同时解析难度星级，缺失时为 null', () => {
        expect(parseTagSuggestion('{"tags": ["植树问题"], "difficultyStars": 4}', ['植树问题'])).toEqual({ tags: ['植树问题'], difficultyStars: 4 });
        expect(parseTagSuggestion('{"tags": ["植树问题"]}', ['植树问题']).difficultyStars).toBeNull();
    });

    it('题目结构允许 1~5 的整数或空，不允许越界', () => {
        const base = { questionText: 'q', answerText: 'a', analysis: 'x', subject: '数学', knowledgePoints: [] };
        expect(ParsedQuestionSchema.safeParse({ ...base, difficultyStars: 3 }).success).toBe(true);
        expect(ParsedQuestionSchema.safeParse({ ...base, difficultyStars: null }).success).toBe(true);
        expect(ParsedQuestionSchema.safeParse({ ...base, difficultyStars: 6 }).success).toBe(false);
    });
});

describe('extractJsonObject LaTeX 转义与容错解析', () => {
    it('无损解析含单反斜杠 LaTeX 命令的 JSON（不产生控制字符也不报错）', () => {
        const raw = String.raw`{"answer": "$\frac{1}{2} \times 2 \neq 0$", "unit": "3 \text{cm}", "env": "\begin{aligned}\binom{4}{2} = \sqrt{36}\end{aligned}", "bracket": "\left( \frac{a}{b} \right)"}`;
        const parsed = extractJsonObject(raw) as Record<string, string>;
        expect(parsed.answer).toBe(String.raw`$\frac{1}{2} \times 2 \neq 0$`);
        expect(parsed.unit).toBe(String.raw`3 \text{cm}`);
        expect(parsed.env).toBe(String.raw`\begin{aligned}\binom{4}{2} = \sqrt{36}\end{aligned}`);
        expect(parsed.bracket).toBe(String.raw`\left( \frac{a}{b} \right)`);
    });

    it('已正确双写的 \\frac 不被二次破坏，真实换行 \n 与制表符 \t 不被误改', () => {
        const raw = '{"latex": "$\\\\frac{1}{2}$", "zh": "解：\\n第一步", "en": "Step 1\\nnext", "tsv": "a\\tto b", "unicode": "\\u4e2d\\u6587", "underline": "\\underline{x}"}';
        const parsed = extractJsonObject(raw) as Record<string, string>;
        expect(parsed.latex).toBe(String.raw`$\frac{1}{2}$`);
        expect(parsed.zh).toBe('解：\n第一步');
        expect(parsed.en).toBe('Step 1\nnext');
        expect(parsed.tsv).toBe('a\tto b');
        expect(parsed.unicode).toBe('中文');
        expect(parsed.underline).toBe(String.raw`\underline{x}`);
    });

    it('首次解析失败时走第二遍：清理尾逗号并转义字符串内裸换行', () => {
        const raw = '{\n"questionText": "第一行\n第二行",\n"answerText": "$\\frac{3}{4}$",\n}';
        const parsed = extractJsonObject(raw) as Record<string, string>;
        expect(parsed.questionText).toBe('第一行\n第二行');
        expect(parsed.answerText).toBe(String.raw`$\frac{3}{4}$`);
    });
});
