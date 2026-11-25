/**
 * 小程序公式转文本（miniprogram/src/utils/latex.ts）：小程序没有 KaTeX，各学科的 LaTeX / mhchem 写法要转成可读的 Unicode。
 */
import { describe, expect, it } from 'vitest';
import { convertChem, latexToPlainText as t } from '../../../miniprogram/src/utils/latex';
import { toPlainText } from '../../../miniprogram/src/utils/text';

describe('数学', () => {
    it('分式、根式、上下标、运算符', () => {
        expect(t('$\\frac{1}{2} + \\dfrac{x+1}{x-1}$')).toBe('1/2 + (x+1)/(x-1)');
        expect(t('$\\sqrt{2}$ 与 $\\sqrt[3]{x+1}$')).toBe('√2 与 ³√(x+1)');
        expect(t('$x^2 + y^{10} = a_1 + a_{n+1}$')).toBe('x² + y¹⁰ = a₁ + aₙ₊₁');
        expect(t('$3 \\times 4 \\div 2 \\pm 1 \\leq 5 \\neq 6$')).toBe('3 × 4 ÷ 2 ± 1 ≤ 5 ≠ 6');
        expect(t('$e^{\\frac{1}{2}}$')).toBe('e^(1/2)');
        expect(t('$\\frac{\\sqrt{12}}{2}$')).toBe('(√12)/2');
    });

    it('命令按完整名称匹配，不会把 \\left、\\int、\\top 拆坏', () => {
        expect(t('$\\left( a+b \\right)$')).toBe('( a+b )');
        expect(t('$\\int_0^1 x\\,dx$')).toBe('∫₀¹ x dx');
        expect(t('$\\infty$、$\\in$、$\\leftarrow$')).toBe('∞、∈、←');
        expect(t('$\\sin\\alpha + \\cos 2\\theta$')).toBe('sinα + cos 2θ');
    });

    it('几何记号与方程组', () => {
        expect(t('$\\angle ABC = 90^\\circ$，$\\triangle ABC \\cong \\triangle DEF$')).toBe('∠ABC = 90°，△ABC ≅ △DEF');
        expect(t('$\\overline{AB} \\parallel CD$，$AB \\perp CD$')).toBe('A̅B̅ ∥ CD，AB ⊥ CD');
        expect(t('弧 $\\overset{\\frown}{AB}$')).toBe('弧 ⌒AB');
        expect(t('$\\because a>b, \\therefore b<a$')).toBe('∵ a>b, ∴ b<a');
        expect(t('$$\\begin{cases} x+y=7 \\\\ 2x-y=4 \\end{cases}$$')).toBe('{ x+y=7；2x-y=4 }');
        expect(t('$\\mathbb{R}$、$x \\in \\mathbb{Z}$')).toBe('ℝ、x ∈ ℤ');
    });

    it('多行推导按行显示', () => {
        expect(t('$$\\begin{aligned} y &= 2x+1 \\\\ &= 5 \\end{aligned}$$')).toBe('y = 2x+1\n= 5');
    });
});

describe('物理', () => {
    it('单位、矢量、希腊字母、角标', () => {
        expect(t('$g = 9.8\\,\\mathrm{m/s^2}$')).toBe('g = 9.8 m/s²');
        expect(t('$\\pu{9.8 m/s^2}$')).toBe('9.8 m/s²');
        expect(t('$\\vec{F}$ 与 $\\overrightarrow{AB}$')).toBe('F⃗ 与 AB⃗');
        expect(t('$R = 10\\,\\Omega$，$\\lambda = 500\\,\\mathrm{nm}$，$\\mu$')).toBe('R = 10 Ω，λ = 500 nm，μ');
        expect(t('$v_0$、$E_k$、$F_{合}$、$v_{max}$')).toBe('v₀、Eₖ、F合、vₘₐₓ');
        expect(t('$\\Delta t = 3\\times 10^{-3}\\,\\mathrm{s}$')).toBe('Δt = 3× 10⁻³ s');
        expect(t('$25^{\\circ}\\mathrm{C}$')).toBe('25°C');
    });
});

describe('化学（mhchem）', () => {
    it('化学式与系数', () => {
        expect(t('$\\ce{H2SO4}$')).toBe('H₂SO₄');
        expect(t('$\\ce{C6H12O6}$')).toBe('C₆H₁₂O₆');
        expect(t('$\\ce{2H2 + O2 -> 2H2O}$')).toBe('2H₂ + O₂ → 2H₂O');
        expect(t('$\\ce{CuSO4*5H2O}$')).toBe('CuSO₄·5H₂O');
        expect(t('$\\ce{Ca(OH)2}$')).toBe('Ca(OH)₂');
    });

    it('离子与电荷', () => {
        expect(t('$\\ce{SO4^{2-}}$')).toBe('SO₄²⁻');
        expect(t('$\\ce{Fe^3+}$')).toBe('Fe³⁺');
        expect(t('$\\ce{Na+ + Cl- -> NaCl}$')).toBe('Na⁺ + Cl⁻ → NaCl');
        expect(t('$\\ce{NH4+}$')).toBe('NH₄⁺');
    });

    it('可逆、条件、气体与沉淀', () => {
        expect(t('$\\ce{N2 + 3H2 <=> 2NH3}$')).toBe('N₂ + 3H₂ ⇌ 2NH₃');
        expect(t('$\\ce{2KClO3 ->[MnO2][\\Delta] 2KCl + 3O2 ^}$')).toBe('2KClO₃ ─MnO₂，Δ→ 2KCl + 3O₂ ↑');
        expect(t('$\\ce{CaCO3 ->[高温] CaO + CO2 ^}$')).toBe('CaCO₃ ─高温→ CaO + CO₂ ↑');
        expect(t('$\\ce{Ba^{2+} + SO4^{2-} -> BaSO4 v}$')).toBe('Ba²⁺ + SO₄²⁻ → BaSO₄ ↓');
        expect(convertChem('CO2 + H2O <=> H2CO3')).toBe('CO₂ + H₂O ⇌ H₂CO₃');
    });

    it('\\ce 写在公式外也能转', () => {
        expect(t('生成 \\ce{CO2} 气体')).toBe('生成 CO₂ 气体');
    });

    it('有机结构式 SMILES 代码块标注出来', () => {
        expect(t('乙醇的结构：\n```smiles\nCCO\n```')).toBe('乙醇的结构：\n〔结构式：CCO〕');
    });
});

describe('生物、英语、语文等文字题', () => {
    it('英语填空的下划线、编号空、撇号原样保留', () => {
        expect(t("She ___ to school every day. A. go B. goes")).toBe('She ___ to school every day. A. go B. goes');
        expect(t("Tom's book __1__ on the desk __2__.")).toBe("Tom's book __1__ on the desk __2__.");
        expect(t('x_1 写在公式外不动')).toBe('x_1 写在公式外不动');
    });

    it('生物：比例、遗传符号与百分号', () => {
        expect(t('$F_1$ 自交，$F_2$ 中性状分离比为 $9:3:3:1$，约占 $25\\%$')).toBe('F₁ 自交，F₂ 中性状分离比为 9:3:3:1，约占 25%');
        expect(t('$\\mathrm{CO_2}$ 浓度')).toBe('CO₂ 浓度');
        expect(t('基因型 $AaBb$ × $aabb$')).toBe('基因型 AaBb × aabb');
    });

    it('语文：拼音与中文标点不受影响', () => {
        expect(t('给加点字注音：hǎo、lǜ。“春风又绿江南岸”')).toBe('给加点字注音：hǎo、lǜ。“春风又绿江南岸”');
    });

    it('Markdown 粗体、标题、列表与 HTML 上下标', () => {
        expect(t('## 解析\n**关键**是 H<sub>2</sub>O 和 x<sup>2</sup>\n- 第一步')).toBe('解析\n关键是 H₂O 和 x²\n• 第一步');
        expect(t('价格是 \\$5，不是公式')).toBe('价格是 $5，不是公式');
        expect(t('a<b 且 c>d')).toBe('a<b 且 c>d');
    });

    it('空值与 toPlainText 入口', () => {
        expect(t(null)).toBe('');
        expect(t(undefined)).toBe('');
        expect(toPlainText('$\\ce{H2O}$')).toBe('H₂O');
    });

    it('括号不配对等坏输入不会抛错', () => {
        expect(() => t('$\\frac{1}{$ 和 $\\sqrt{$')).not.toThrow();
        expect(() => t('$\\begin{cases} x $')).not.toThrow();
        expect(() => t('$\\ce{SO4^{2-$')).not.toThrow();
    });
});
