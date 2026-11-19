import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildGradingHandoutDocx, escapeOoXmlText } from '@/lib/docx/grading-handout-docx';

describe('Task 2.4: 零依赖 OOXML Word (.docx) 错题讲评讲义生成与防注入转义', () => {
    it('escapeOoXmlText 严格转义 XML 特殊字符并剥离非法控制字符', () => {
        const malicious = '标题\x00\x07 <script>&"bad\'</script>';
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
        // 确认恶意或数学尖括号未破坏 XML 标签且高错误率第12题排在第5题之前
        expect(docXml).toContain('初二3班 &lt;分式与全等&gt; 随堂测');
        expect(docXml).toContain('求 m 的值 &amp; 讨论 &lt;边界&gt;');
        expect(docXml).not.toContain('<边界>');
        expect(docXml.indexOf('第 12 题')).toBeLessThan(docXml.indexOf('第 5 题'));
    });
});
