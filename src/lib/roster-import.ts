/**
 * 学生名册导入（纯逻辑）：解析粘贴的表格文本 / CSV / Excel 行，识别表头，
 * 检查重复与错误，并与已有名册比对生成预览（新增、更新、不变）。
 */
import { normalizeName, normalizeStudentNo } from "@/lib/student-match";

export interface RosterRow {
    /** 原始行号，从 1 开始 */
    line: number;
    className: string;
    studentNo: string | null;
    name: string;
}

export type RosterIssueCode = 'missing_name' | 'missing_class' | 'bad_student_no' | 'too_long';

export interface RosterIssue {
    line: number;
    code: RosterIssueCode;
}

export interface RosterDuplicate {
    line: number;
    firstLine: number;
    className: string;
    studentNo: string | null;
    name: string;
}

export interface ParsedRoster {
    rows: RosterRow[];
    errors: RosterIssue[];
    duplicates: RosterDuplicate[];
    hasHeader: boolean;
}

export const MAX_ROSTER_ROWS = 2000;

type Column = 'className' | 'studentNo' | 'name';

const HEADER_PATTERNS: Record<Column, RegExp> = {
    className: /^(班级|班|班别|class|classname|class name)$/i,
    studentNo: /^(学号|编号|序号|考号|学籍号|no|no\.|number|id|student ?no\.?|student ?id|student ?number)$/i,
    name: /^(姓名|名字|学生|学生姓名|name|student|student ?name)$/i,
};

/** 解析 CSV 一行（支持双引号转义） */
function splitCsvLine(line: string, delimiter: string): string[] {
    const cells: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (quoted) {
            if (char === '"' && line[i + 1] === '"') { cell += '"'; i++; }
            else if (char === '"') quoted = false;
            else cell += char;
        } else if (char === '"' && cell.trim() === '') {
            quoted = true;
            cell = '';
        } else if (char === delimiter) {
            cells.push(cell);
            cell = '';
        } else cell += char;
    }
    cells.push(cell);
    return cells.map((value) => value.trim());
}

/** 把粘贴的文本切成表格：优先制表符（从 Excel 复制），其次逗号，最后空白 */
export function splitTable(text: string): string[][] {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    const sample = lines.filter((line) => line.trim()).slice(0, 20);
    const delimiter = sample.some((line) => line.includes('\t')) ? '\t'
        : sample.some((line) => /[,，]/.test(line)) ? ','
            : sample.some((line) => line.includes(';')) ? ';' : null;
    return lines.map((line) => {
        if (!line.trim()) return [];
        if (delimiter === ',') return splitCsvLine(line.replace(/，/g, ','), ',');
        if (delimiter) return splitCsvLine(line, delimiter);
        return line.trim().split(/\s+/);
    });
}

const looksLikeNo = (value: string) => /^[A-Za-z]{0,3}\d{1,20}$/.test(normalizeStudentNo(value));
const looksLikeClass = (value: string) => /班|年级|级|class|^初|^高/i.test(value);

/** 按表头或内容推断每列含义 */
function detectColumns(rows: string[][]): { columns: (Column | null)[]; hasHeader: boolean } {
    const first = rows.find((row) => row.length) || [];
    const headerColumns = first.map((cell) => (Object.keys(HEADER_PATTERNS) as Column[]).find((column) => HEADER_PATTERNS[column].test(cell.trim())) || null);
    if (headerColumns.includes('name')) return { columns: headerColumns, hasHeader: true };

    const width = Math.max(...rows.map((row) => row.length), 0);
    const body = rows.filter((row) => row.length).slice(0, 50);
    const ratio = (index: number, test: (value: string) => boolean) => {
        const values = body.map((row) => row[index] || '').filter(Boolean);
        return values.length ? values.filter(test).length / values.length : 0;
    };
    const columns: (Column | null)[] = Array(width).fill(null);
    const noIndex = [...Array(width).keys()].sort((a, b) => ratio(b, looksLikeNo) - ratio(a, looksLikeNo))[0];
    if (width >= 2 && ratio(noIndex, looksLikeNo) >= 0.6) columns[noIndex] = 'studentNo';
    const classIndex = [...Array(width).keys()].filter((index) => !columns[index]).sort((a, b) => ratio(b, looksLikeClass) - ratio(a, looksLikeClass))[0];
    if (width >= 2 && classIndex !== undefined && ratio(classIndex, looksLikeClass) >= 0.6) columns[classIndex] = 'className';
    const nameIndex = [...Array(width).keys()].find((index) => !columns[index]);
    if (nameIndex !== undefined) columns[nameIndex] = 'name';
    return { columns, hasHeader: false };
}

/** 解析名册表格；没有班级列时使用 defaultClassName */
export function parseRosterTable(table: string[][], defaultClassName = ''): ParsedRoster {
    const { columns, hasHeader } = detectColumns(table);
    const rows: RosterRow[] = [];
    const errors: RosterIssue[] = [];
    const duplicates: RosterDuplicate[] = [];
    const seen = new Map<string, number>();
    let headerSkipped = !hasHeader;

    table.slice(0, MAX_ROSTER_ROWS + 1).forEach((cells, index) => {
        const line = index + 1;
        if (!cells.some((cell) => cell.trim())) return;
        if (!headerSkipped) { headerSkipped = true; return; }
        const get = (column: Column) => {
            const at = columns.indexOf(column);
            return at >= 0 ? (cells[at] || '').trim() : '';
        };
        const name = get('name').replace(/\s+/g, ' ');
        const className = (get('className') || defaultClassName).trim();
        const rawNo = get('studentNo');
        const studentNo = rawNo ? normalizeStudentNo(rawNo) : null;
        if (!name) { errors.push({ line, code: 'missing_name' }); return; }
        if (!className) { errors.push({ line, code: 'missing_class' }); return; }
        if (name.length > 50 || className.length > 100) { errors.push({ line, code: 'too_long' }); return; }
        if (studentNo && !/^[A-Za-z0-9]{1,30}$/.test(studentNo)) { errors.push({ line, code: 'bad_student_no' }); return; }

        // 同班同学号算重复；没有学号时同班同名算重复
        const key = studentNo ? `${className}\u0000no:${studentNo.replace(/^0+/, '')}` : `${className}\u0000name:${normalizeName(name)}`;
        const firstLine = seen.get(key);
        if (firstLine !== undefined) {
            duplicates.push({ line, firstLine, className, studentNo, name });
            return;
        }
        seen.set(key, line);
        rows.push({ line, className, studentNo, name });
    });
    return { rows, errors, duplicates, hasHeader };
}

export interface ExistingStudent {
    id: string;
    classId: string;
    className: string;
    name: string;
    studentNo: string | null;
}

export type RosterAction = 'create' | 'update' | 'unchanged';

export interface RosterPlanRow extends RosterRow {
    action: RosterAction;
    studentId: string | null;
    /** 更新时的原姓名 / 原学号 */
    previousName?: string;
    previousStudentNo?: string | null;
}

export interface RosterPlan {
    rows: RosterPlanRow[];
    newClasses: string[];
    counts: Record<RosterAction, number>;
}

/** 与已有名册比对：同班同学号 → 更新姓名；同班同名且原来没有学号 → 补学号；否则新增 */
export function planRosterImport(rows: RosterRow[], existing: ExistingStudent[], existingClasses: string[]): RosterPlan {
    const classNames = new Set(existingClasses);
    const newClasses = [...new Set(rows.map((row) => row.className).filter((name) => !classNames.has(name)))];
    const byClass = new Map<string, ExistingStudent[]>();
    for (const student of existing) byClass.set(student.className, [...(byClass.get(student.className) || []), student]);
    const used = new Set<string>();

    const planned = rows.map((row): RosterPlanRow => {
        const students = (byClass.get(row.className) || []).filter((student) => !used.has(student.id));
        const sameNo = row.studentNo ? students.find((student) => student.studentNo && student.studentNo.replace(/^0+/, '') === row.studentNo!.replace(/^0+/, '')) : undefined;
        const sameName = students.find((student) => normalizeName(student.name) === normalizeName(row.name) && (!student.studentNo || !row.studentNo));
        const match = sameNo || sameName;
        if (!match) return { ...row, action: 'create', studentId: null };
        used.add(match.id);
        const changed = match.name !== row.name || (row.studentNo !== null && match.studentNo !== row.studentNo);
        return {
            ...row,
            action: changed ? 'update' : 'unchanged',
            studentId: match.id,
            ...(changed ? { previousName: match.name, previousStudentNo: match.studentNo } : {}),
        };
    });
    const counts = { create: 0, update: 0, unchanged: 0 };
    for (const row of planned) counts[row.action]++;
    return { rows: planned, newClasses, counts };
}
