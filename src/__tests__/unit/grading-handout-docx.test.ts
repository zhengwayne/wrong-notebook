import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildGradingHandoutDocx, escapeOoXmlText } from '@/lib/docx/grading-handout-docx';

describe('Task 2.4: 零依赖 OOXML Word (.docx) 错题讲评讲义生成与防注入转义', () => {
    it('escapeOoXmlText 严格转义 XML 特殊字符并剥离非法控制字符与非合法 Unicode 代理项', () => {
        const malicious = '标题\x00\x07\uFFFE\uFFFF\uD800 <script>&"bad\'</script>';
        expect(escapeOoXmlText(malicious)).toBe('标题 &lt;script&gt;&amp;&quot;bad&apos;&lt;/script&gt;');
    });

    it('buildGradingHandoutDocx 输出标准 OOXML ZIP 结构并按错误率排序高频错题', () => {
        const bytes = buildGradingHandoutDocx({
            taskTitle: '初二3班 <分式与全等> 随堂测',
            className: '初二(3)班',
            subjectName: '数学',
            gradedCount: 40,
            averageScore: 81.5,
            weakPoints: [{ name: '分式方程增根', errorRate: 65 }],
            questions: [
                {
                    number: '5',
                    questionText: '化简 $\\frac{1}{x}$',
                    answer: '1/x',
                    errorRate: 20,
                    wrongCount: 8,
                    answeredCount: 40,
                    sampleMistakes: ['漏写定义域'],
                },
                {
                    number: '12',
                    questionText: '若方程有增根，求 m 的值 & 讨论 <边界>',
                    answer: 'm = 3',
                    errorRate: 65,
                    wrongCount: 26,
                    answeredCount: 40,
                    sampleMistakes: ['忘记检验最简公分母为0'],
                },
                {
                    number: '99',
                    questionText: '全对题不应进入讲评',
                    answer: 'A',
                    errorRate: 0,
                    wrongCount: 0,
                    answeredCount: 40,
                    sampleMistakes: [],
                },
            ],
            topN: 5,
        });

        // PK\x03\x04 ZIP 魔数校验
        expect(bytes[0]).toBe(0x50);
        expect(bytes[1]).toBe(0x4b);

        const archive = unzipSync(bytes);
        expect(archive['[Content_Types].xml']).toBeDefined();
        expect(archive['_rels/.rels']).toBeDefined();
        expect(archive['word/document.xml']).toBeDefined();

        const docXml = strFromU8(archive['word/document.xml']);
        // 确认恶意或数学尖括号未破坏 XML 标签且高错误率第12题排在第5题之前，且 0 错题已被过滤
        expect(docXml).toContain('初二3班 &lt;分式与全等&gt; 随堂测');
        expect(docXml).toContain('求 m 的值 &amp; 讨论 &lt;边界&gt;');
        expect(docXml).not.toContain('<边界>');
        expect(docXml).not.toContain('全对题不应进入讲评');
        expect(docXml.indexOf('第 12 题')).toBeLessThan(docXml.indexOf('第 5 题'));
    });

    it('讲义默认不写参考答案，includeAnswers 为 true 时才写入', () => {
        const base = {
            taskTitle: '随堂测',
            className: '三(2)班',
            subjectName: '数学',
            gradedCount: 10,
            averageScore: 80,
            weakPoints: [],
            questions: [{ number: '1', questionText: '1+1=?', answer: '2', errorRate: 50, wrongCount: 5, answeredCount: 10 }],
        };
        const read = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)['word/document.xml']);
        const withoutAnswers = read(buildGradingHandoutDocx(base));
        expect(withoutAnswers).not.toContain('参考答案：2');
        expect(withoutAnswers).toContain('【订正区】');
        const withAnswers = read(buildGradingHandoutDocx({ ...base, includeAnswers: true }));
        expect(withAnswers).toContain('参考答案：2');
    });

    it('选择题选项按长度用制表位排成多列，与打印页一致', () => {
        const bytes = buildGradingHandoutDocx({
            taskTitle: '随堂测',
            className: '三(2)班',
            subjectName: '数学',
            gradedCount: 10,
            averageScore: 80,
            weakPoints: [],
            questions: [{ number: '3', questionText: '下列哪个数是质数？（ ）\nA. 4\nB. 6\nC. 7\nD. 9', answer: 'C', errorRate: 50, wrongCount: 5, answeredCount: 10 }],
        });
        const xml = strFromU8(unzipSync(bytes)['word/document.xml']);
        expect(xml).toContain('【原题题干】下列哪个数是质数？（ ）');
        // 4 列：3 个制表位，四个选项在同一段
        expect(xml.match(/<w:tab w:val="left"/g)).toHaveLength(3);
        const row = xml.slice(xml.indexOf('A. 4'), xml.indexOf('D. 9'));
        expect(row).not.toContain('</w:p>');
        expect(xml).toContain('D. 9');
    });
});
