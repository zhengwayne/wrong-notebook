import { strToU8, zipSync } from "fflate";

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
}

/**
 * 严格剥离 OOXML 非法控制字符并转义全部 XML 保留符号，彻底杜绝 XML 结构注入风险。
 */
export function escapeOoXmlText(value: string | null | undefined): string {
    if (!value) return "";
    return value
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
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
        paragraphs.push(paragraphXml(`【原题题干】${q.questionText?.trim() || "（请对照原卷题目）"}`, { sizeHalfPt: 21, spacingAfter: 60 }));
        if (q.sampleMistakes && q.sampleMistakes.length > 0) {
            paragraphs.push(paragraphXml(`【典型错因/错答】${q.sampleMistakes.join("；")}`, { sizeHalfPt: 20, colorHex: "6B7280", spacingAfter: 60 }));
        }
        paragraphs.push(paragraphXml(`【参考答案与订正区】参考答案：${q.answer?.trim() || "略"}`, { sizeHalfPt: 20, spacingAfter: 40 }));
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
