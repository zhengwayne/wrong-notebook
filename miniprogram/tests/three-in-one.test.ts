/**
 * 三合一小程序（学英语 / 学数学 / 错题本）的纯逻辑：跳转、拼写与复习、判题与选题、收进错题本的请求体。
 */
import { describe, expect, it } from 'vitest';
import { planTabSwitch, XJ_TAB_ROUTES } from '../src/utils/nav';
import { englishDueCount, mathStarCount, moduleKey } from '../src/utils/module-store';
import { buildErrorItemBody } from '../src/utils/to-notebook';
import {
    artStem, artUrl, BOOKS, dictUrl, dueWords, isCorrectSpelling, letterMarks, levelCount, levelWords, scheduleWord, starsFor, toWords, wordToNotebook,
} from '../src/pkg-english/lib/words';
import {
    campChapters, campKey, checkAnswer, computeBadges, listCamps, numberValue, pickQuestions, questionToNotebook,
} from '../src/pkg-math/lib/course';
import type { Course, Question } from '../src/pkg-math/lib/course';

describe('错题本底栏跳转', () => {
    it('底栏只含错题本三页，「我的」单独打开', () => {
        expect(XJ_TAB_ROUTES).toEqual(['pkg-xueji/home/home', 'pkg-xueji/notebook/notebook', 'pkg-xueji/review/review']);
    });
    it('当前就在目标页时不动；在底栏页之间直接重定向', () => {
        expect(planTabSwitch(['pages/hub/hub', 'pkg-xueji/home/home'], '/pkg-xueji/home/home')).toEqual({ kind: 'none' });
        expect(planTabSwitch(['pages/hub/hub', 'pkg-xueji/notebook/notebook'], '/pkg-xueji/review/review?x=1')).toEqual({ kind: 'redirect' });
    });
    it('从详情 / 拍照页回底栏页：先返回到栈里的底栏页，不同页再重定向', () => {
        expect(planTabSwitch(['pages/hub/hub', 'pkg-xueji/home/home', 'pkg-xueji/capture/capture'], '/pkg-xueji/notebook/notebook'))
            .toEqual({ kind: 'back', delta: 1, thenRedirect: true });
        expect(planTabSwitch(['pages/hub/hub', 'pkg-xueji/review/review', 'pkg-xueji/item/item', 'pkg-xueji/item/item'], '/pkg-xueji/review/review'))
            .toEqual({ kind: 'back', delta: 2, thenRedirect: false });
    });
    it('栈里没有底栏页时普通打开', () => {
        expect(planTabSwitch(['pages/hub/hub', 'pages/me/me', 'pkg-xueji/parent/parent'], '/pkg-xueji/home/home')).toEqual({ kind: 'navigate' });
    });
});

describe('学英语', () => {
    it('词书：小学 12 册 + 中考，地址按 UTF-8 编码', () => {
        expect(BOOKS).toHaveLength(13);
        expect(dictUrl(BOOKS[0])).toBe('https://lingo.jjool.com/dicts/grades/grade_1%E4%B8%8A.json');
    });
    it('插图文件名与站点一致，只给有图的词出地址', () => {
        expect(artStem("jack-o'-lantern")).toBe('jack-o_-lantern');
        expect(artStem('bicycle/bike')).toBe('bicycle_bike');
        expect(artUrl('above', true)).toBe('https://lingo.jjool.com/word-art/still/above.webp');
        expect(artUrl('zzzz-not-a-word', true)).toBe('');
    });
    it('拼写忽略大小写、多余空格、弯引号；逐字母标对错', () => {
        expect(isCorrectSpelling('O’Clock', "o'clock")).toBe(true);
        expect(isCorrectSpelling('aple', 'apple')).toBe(false);
        expect(letterMarks('Ab', 'a c').map((m) => m.mark)).toEqual(['ok', 'bad', 'empty']);
        expect(letterMarks('a x', 'a c').map((m) => m.mark)).toEqual(['ok', 'space', 'bad']);
        expect(letterMarks('', 'hi').map((m) => m.mark)).toEqual(['empty', 'empty']);
    });
    it('词表转换与分关', () => {
        const words = toWords([{ name: ' hello ', trans: ['你好', '喂'], usphone: 'həˈloʊ' }, { name: '' }]);
        expect(words).toEqual([{ name: 'hello', trans: '你好；喂', phone: 'həˈloʊ', sentence: '', sentenceTrans: '', art: expect.any(String) }]);
        expect(levelCount(55)).toBe(6);
        expect(levelWords(Array.from({ length: 25 }, (_, i) => i), 2)).toEqual([20, 21, 22, 23, 24]);
    });
    it('间隔复习：对了升盒、错了回 0 盒当天复习，记下拼错的写法', () => {
        const word = { name: 'apple', trans: '苹果', phone: 'ˈæpl', sentence: '', sentenceTrans: '', art: '' };
        const now = 1_000_000;
        const first = scheduleWord(undefined, true, word, 'grade_3上', now);
        expect(first).toMatchObject({ b: 1, d: now + 86_400_000, w: 0, k: 'grade_3上' });
        const wrong = scheduleWord(first, false, word, 'grade_3上', now, 'aple');
        expect(wrong).toMatchObject({ b: 0, d: now, w: 1, x: 'aple' });
        expect(englishDueCount({ book: '', mode: 'spell', levels: {}, words: { apple: wrong, cat: first } }, now)).toBe(1);
        expect(dueWords({ apple: wrong, cat: first }, now).map((w) => w.name)).toEqual(['apple']);
        expect(wordToNotebook('apple', wrong)).toEqual({ questionText: '写出单词：苹果（/ˈæpl/）', answerText: 'apple', wrongAnswerText: 'aple' });
    });
    it('星数', () => {
        expect([0, 1, 2, 3, 9].map(starsFor)).toEqual([3, 2, 2, 1, 1]);
    });
});

const COURSE: Course = {
    nodes: [
        { id: 'n1', name: '正数和负数', lessons: ['sys-01'] },
        { id: 'n2', name: '数轴', lessons: ['sys-02'] },
        { id: 'p1', name: '100以内的数', lessons: ['kg-01'] },
    ],
    lessons: [
        { id: 'kg-01', book: '知识图谱拓展', bookSlug: 'kg', no: 1, title: '认识数', nodes: ['p1'] },
        { id: 'sys-01', book: '数与式', bookSlug: 'sys', no: 1, title: '温度计上的正负数', nodes: ['n1'], prereqNodes: ['p1'] },
        { id: 'sys-02', book: '数与式', bookSlug: 'sys', no: 2, title: '数轴', nodes: ['n2'] },
    ],
    path: ['kg-01', 'sys-01', 'sys-02'],
    pathMeta: { 'kg-01': { g: 2, s: '下', ch: '数的认识' }, 'sys-01': { g: 7, s: '上', ch: '有理数' }, 'sys-02': { g: 7, s: '上', ch: '有理数' } },
};

describe('学数学', () => {
    it('分站：小学一站，初中按年级上下册；章节按路线顺序分组', () => {
        expect(campKey({ g: 7, s: '' })).toBe('7上');
        expect(listCamps(COURSE)).toEqual([{ key: 'p', label: '小学' }, { key: '7上', label: '七上' }]);
        expect(campChapters(COURSE, '7上')).toEqual([{ chapter: '有理数', stations: [
            { id: 'sys-01', title: '温度计上的正负数', chapter: '有理数', book: '数与式' },
            { id: 'sys-02', title: '数轴', chapter: '有理数', book: '数与式' },
        ] }]);
    });
    it('判题：数值等价、单位、全角、逗号列表（有序 / 无序）、选择题', () => {
        const q = (answer: string, extra: Partial<Question> = {}): Question => ({ id: 'q', topicId: 't', type: 'numeric', prompt: '', answer, ...extra });
        expect(numberValue('-3/4')).toBe(-0.75);
        expect(numberValue('50%')).toBe(0.5);
        expect(checkAnswer(q('0.75'), '3/4')).toBe(true);
        expect(checkAnswer(q('-80'), '－８０')).toBe(true);
        expect(checkAnswer(q('28'), '28 平方厘米')).toBe(true);
        expect(checkAnswer(q('28'), '29')).toBe(false);
        expect(checkAnswer(q('2，3'), '3,2')).toBe(false);
        expect(checkAnswer(q('2，3', { unordered: true }), '3,2')).toBe(true);
        expect(checkAnswer(q('a+b=b+a', { type: 'short', accept: ['b+a=a+b'] }), 'b + a = a + b')).toBe(true);
        expect(checkAnswer(q('C', { type: 'choice' }), 'c')).toBe(true);
        expect(checkAnswer(q('5'), '')).toBe(false);
    });
    it('选题：先用按课编写的题，再从知识点题库补，不选自评题，最多 limit 道', () => {
        const mk = (id: string, topicId: string, type: Question['type'] = 'numeric'): Question => ({ id, topicId, type, prompt: id, answer: '1' });
        const lesson = COURSE.lessons[1];
        const picked = pickQuestions(lesson, { 'sys-01': [mk('k1', 'n1'), mk('k2', 'n1')] }, [mk('b1', 'n1'), mk('b2', 'n2'), mk('b3', 'n1', 'self'), mk('k1', 'n1')], 3, () => 0);
        expect(picked.map((x) => x.id).slice(0, 2).sort()).toEqual(['k1', 'k2']);
        expect(picked.map((x) => x.id)).toHaveLength(3);
        expect(picked.map((x) => x.id)[2]).toBe('b1');
    });
    it('收进错题本：选择题带上选项和答案文字', () => {
        const q: Question = { id: 'q', topicId: 't', type: 'choice', prompt: '哪个最大？', answer: 'B', choices: [{ key: 'A', text: '0.8' }, { key: 'B', text: '0.9' }] };
        expect(questionToNotebook(q)).toEqual({ questionText: '哪个最大？\nA. 0.8\nB. 0.9', answerText: 'B. 0.9' });
    });
    it('徽章与点亮计数', () => {
        const best = { 'sys-01': 90, 'sys-02': 80, 'kg-01': 60 };
        expect(mathStarCount({ best, perfect: 0 })).toBe(2);
        const badges = computeBadges(COURSE, best, 0);
        expect(badges.find((b) => b.id === 'first-star')?.got).toBe(true);
        expect(badges.find((b) => b.id === 'rational')?.got).toBe(true);
        expect(badges.find((b) => b.id === 'all')?.got).toBe(false);
        expect(badges.find((b) => b.id === 'quiz-perfect')?.got).toBe(false);
    });
});

describe('收进错题本的请求体', () => {
    it('走现有导入接口：学科名定错题本，gradeSemester 为 null 不触发 AI 年级识别', () => {
        expect(buildErrorItemBody({ subjectName: '英语', questionText: 'Q', answerText: 'A', knowledgePoints: ['1', '2', '3', '4', '5', '6'] }, 'kid-1')).toEqual({
            subjectName: '英语', questionText: 'Q', answerText: 'A', analysis: '', wrongAnswerText: '',
            knowledgePoints: ['1', '2', '3', '4', '5'], originalImageUrl: '', gradeSemester: null, learnerId: 'kid-1',
        });
    });
    it('进度按账号 + 学习者分开存', () => {
        expect(moduleKey('math', 'u1', null)).toBe('xueji.mp.math:u1:self');
        expect(moduleKey('english', 'u1', 'kid')).toBe('xueji.mp.english:u1:kid');
    });
});
