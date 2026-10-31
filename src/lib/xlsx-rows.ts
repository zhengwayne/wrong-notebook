/**
 * 在浏览器中读取 .xlsx 第一个工作表为字符串表格（只取单元格的显示值，不执行公式）。
 * 解压用 fflate（MIT），XML 用浏览器自带的 DOMParser 解析。
 */
import { unzipSync, strFromU8 } from "fflate";

const MAX_XLSX_BYTES = 5 * 1024 * 1024;

function columnIndex(ref: string): number {
    const letters = ref.match(/^[A-Z]+/)?.[0] || 'A';
    return [...letters].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function textOf(node: Element | null | undefined): string {
    if (!node) return '';
    return [...node.getElementsByTagName('t')].map((item) => item.textContent || '').join('');
}

export async function readXlsxRows(file: File): Promise<string[][]> {
    if (file.size > MAX_XLSX_BYTES) throw new Error('FILE_TOO_LARGE');
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()), {
        filter: (entry) => entry.name === 'xl/sharedStrings.xml' || entry.name === 'xl/workbook.xml'
            || entry.name === 'xl/_rels/workbook.xml.rels' || entry.name.startsWith('xl/worksheets/sheet'),
    });
    const parser = new DOMParser();
    const xml = (name: string) => files[name] ? parser.parseFromString(strFromU8(files[name]), 'application/xml') : null;

    const shared = [...(xml('xl/sharedStrings.xml')?.getElementsByTagName('si') || [])].map((item) => textOf(item));
    // 找到第一个工作表对应的文件
    const firstSheetRel = xml('xl/workbook.xml')?.getElementsByTagName('sheet')[0]?.getAttribute('r:id');
    const target = [...(xml('xl/_rels/workbook.xml.rels')?.getElementsByTagName('Relationship') || [])]
        .find((rel) => rel.getAttribute('Id') === firstSheetRel)?.getAttribute('Target');
    const sheetName = target ? `xl/${target.replace(/^\/?xl\//, '')}` : Object.keys(files).filter((name) => name.startsWith('xl/worksheets/sheet')).sort()[0];
    const sheet = sheetName ? xml(sheetName) : null;
    if (!sheet) throw new Error('NO_SHEET');

    return [...sheet.getElementsByTagName('row')].map((row) => {
        const cells: string[] = [];
        for (const cell of [...row.getElementsByTagName('c')]) {
            const type = cell.getAttribute('t');
            const value = cell.getElementsByTagName('v')[0]?.textContent || '';
            const text = type === 's' ? shared[Number(value)] || '' : type === 'inlineStr' ? textOf(cell.getElementsByTagName('is')[0]) : value;
            cells[columnIndex(cell.getAttribute('r') || '')] = text.trim();
        }
        return Array.from(cells, (value) => value ?? '');
    });
}
