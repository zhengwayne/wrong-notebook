import { strToU8, zipSync } from "fflate";
import { splitChoiceOptions } from "@/lib/choice-options";
import type { ChoiceColumns, ChoiceOption } from "@/lib/choice-options";

export interface HandoutQuestionItem {
    number: string;
    questionText: string | null;
    answer: string | null;
    errorRate: number;
    wrongCount: number;
    answeredCount: number;
    sampleMistakes?: string[];
}

export interface GradingHandoutInput {
    taskTitle: string;
    className: string;
    subjectName: string;
    gradedCount: number;
    averageScore: number | null;
    weakPoints: Array<{ name: string; errorRate: number }>;
    questions: HandoutQuestionItem[];
    topN?: number;
    /** 是否写入参考答案；默认不写，讲义可直接发给学生订正 */
    includeAnswers?: boolean;
}

/**
 * 严格剥离 OOXML 非法控制字符并转义全部 XML 保留符号，彻底杜绝 XML 结构注入风险。
 */
export function escapeOoXmlText(value: string | null | undefined): string {
    if (!value) return "";
    return value
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFE\uFFFF]/g, "")
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function paragraphXml(text: string, opts?: { bold?: boolean; sizeHalfPt?: number; colorHex?: string; spacingAfter?: number }): string {
    const lines = text.split(/\r?\n/);
    const rPrParts: string[] = [];
    if (opts?.bold) rPrParts.push("<w:b/>");
    if (opts?.sizeHalfPt) rPrParts.push(`<w:sz w:val="${opts.sizeHalfPt}"/><w:szCs w:val="${opts.sizeHalfPt}"/>`);
    if (opts?.colorHex) rPrParts.push(`<w:color w:val="${opts.colorHex}"/>`);
    const rPr = rPrParts.length > 0 ? `<w:rPr>${rPrParts.join("")}</w:rPr>` : "";
    const pPr = opts?.spacingAfter !== undefined ? `<w:pPr><w:spacing w:after="${opts.spacingAfter}"/></w:pPr>` : "";

    const runs = lines.map((line, idx) => {
        const safe = escapeOoXmlText(line);
        const br = idx > 0 ? "<w:br/>" : "";
        return `<w:r>${rPr}${br}<w:t xml:space="preserve">${safe}</w:t></w:r>`;
    }).join("");

    return `<w:p>${pPr}${runs}</w:p>`;
}

/** A4 纵向、左右页边距 1134 twips 时的正文宽度 */
const BODY_WIDTH_TWIPS = 11906 - 1134 * 2;

/**
 * 选择题选项一行一段：按列数用制表位排开（4 列、2 列或 1 列），与打印页的选项横排一致。
 */
function choiceRowsXml(options: ChoiceOption[], columns: ChoiceColumns, sizeHalfPt: number): string[] {
    const rPr = `<w:rPr><w:sz w:val="${sizeHalfPt}"/><w:szCs w:val="${sizeHalfPt}"/></w:rPr>`;
    const step = Math.floor(BODY_WIDTH_TWIPS / columns);
    const tabs = columns > 1
        ? `<w:tabs>${Array.from({ length: columns - 1 }, (_, i) => `<w:tab w:val="left" w:pos="${step * (i + 1)}"/>`).join("")}</w:tabs>`
        : "";
    const rows: string[] = [];
    for (let start = 0; start < options.length; start += columns) {
        const runs = options.slice(start, start + columns).map((option, index) => {
            const tab = index > 0 ? `<w:r>${rPr}<w:tab/></w:r>` : "";
            const text = `${option.label} ${option.content}`.replace(/\r?\n/g, " ");
            return `${tab}<w:r>${rPr}<w:t xml:space="preserve">${escapeOoXmlText(text)}</w:t></w:r>`;
        }).join("");
        rows.push(`<w:p><w:pPr>${tabs}<w:spacing w:after="20"/><w:ind w:left="240"/></w:pPr>${runs}</w:p>`);
    }
    return rows;
}

/** 原题题干：逐行排列的选择题选项按长度排成 4 / 2 / 1 列；其他题目原样输出 */
function questionTextXml(questionText: string | null): string[] {
    const text = questionText?.trim() || "";
    const layout = text ? splitChoiceOptions(text) : null;
    if (!layout) {
        return [paragraphXml(`【原题题干】${text || "（请对照原卷题目）"}`, { sizeHalfPt: 21, spacingAfter: 60 })];
    }
    const out = [paragraphXml(`【原题题干】${layout.stem}`, { sizeHalfPt: 21, spacingAfter: 20 })];
    out.push(...choiceRowsXml(layout.options, layout.columns, 21));
    if (layout.after) out.push(paragraphXml(layout.after, { sizeHalfPt: 21, spacingAfter: 60 }));
    return out;
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/**
 * 零外部重型依赖构建标准可编辑 Word (.docx) 班级错题讲评讲义（复用已安装的 fflate ZIP 压缩）。
 */
export function buildGradingHandoutDocx(input: GradingHandoutInput): Uint8Array {
    const limit = Math.max(1, Math.min(50, input.topN ?? 10));
    const sortedQuestions = [...input.questions]
        .filter((q) => q.wrongCount > 0)
        .sort((a, b) => b.errorRate - a.errorRate)
        .slice(0, limit);

    const paragraphs: string[] = [];

    // 讲义主标题与学情概览
    paragraphs.push(paragraphXml(`${input.taskTitle} · 错题讲评与巩固讲义`, { bold: true, sizeHalfPt: 32, spacingAfter: 160 }));
    const avgLabel = input.averageScore !== null ? `${input.averageScore}` : "-";
    paragraphs.push(
        paragraphXml(
            `班级：${input.className} ｜ 学科：${input.subjectName} ｜ 已统计人数：${input.gradedCount} 人 ｜ 班级均分：${avgLabel}`,
            { sizeHalfPt: 21, colorHex: "555555", spacingAfter: 160 },
        ),
    );

    if (input.weakPoints.length > 0) {
        const wpText = input.weakPoints.map((w) => `${w.name}（错误率 ${w.errorRate}%）`).join("、");
        paragraphs.push(paragraphXml(`【本班共性薄弱知识点】${wpText}`, { bold: true, sizeHalfPt: 22, colorHex: "B45309", spacingAfter: 200 }));
    }

    paragraphs.push(paragraphXml(`一、高频错题精讲（Top ${sortedQuestions.length}）`, { bold: true, sizeHalfPt: 26, spacingAfter: 140 }));

    for (const q of sortedQuestions) {
        paragraphs.push(
            paragraphXml(
                `第 ${q.number} 题  [本班错误率 ${q.errorRate}% · 答错 ${q.wrongCount}/${q.answeredCount} 人]`,
                { bold: true, sizeHalfPt: 23, colorHex: "B91C1C", spacingAfter: 80 },
            ),
        );
        paragraphs.push(...questionTextXml(q.questionText));
        if (q.sampleMistakes && q.sampleMistakes.length > 0) {
            paragraphs.push(paragraphXml(`【典型错因/错答】${q.sampleMistakes.join("；")}`, { sizeHalfPt: 20, colorHex: "6B7280", spacingAfter: 60 }));
        }
        if (input.includeAnswers) {
            paragraphs.push(paragraphXml(`【参考答案与订正区】参考答案：${q.answer?.trim() || "略"}`, { sizeHalfPt: 20, spacingAfter: 40 }));
        } else {
            paragraphs.push(paragraphXml("【订正区】", { sizeHalfPt: 20, spacingAfter: 40 }));
        }
        paragraphs.push(paragraphXml("课堂订正笔记：________________________________________________________________", { sizeHalfPt: 20, colorHex: "9CA3AF", spacingAfter: 200 }));
    }

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs.join("\n    ")}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/>
    </w:sectPr>
  </w:body>
</w:document>`;

    return zipSync({
        "[Content_Types].xml": strToU8(CONTENT_TYPES_XML),
        "_rels/.rels": strToU8(ROOT_RELS_XML),
        "word/document.xml": strToU8(documentXml),
    });
}
