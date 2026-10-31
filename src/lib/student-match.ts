/**
 * 答卷与花名册匹配（纯逻辑）：按卷头手写的班级、学号、姓名找到对应学生。
 * 优先级：班级+学号 → 学号（在本次收卷的班级内唯一）→ 姓名（容忍手写/识别错字）。
 * 身份信息互相矛盾、有歧义或置信度低时返回 review（待确认），从不静默分配低置信度结果。
 */

export interface PaperIdentity {
    className?: string | null;
    studentNo?: string | null;
    name?: string | null;
}

export interface RosterStudent {
    id: string;
    name: string;
    studentNo: string | null;
    classId: string;
    className: string;
}

export type MatchReasonCode =
    | 'class_no'        // 班级+学号一致
    | 'no_only'         // 学号唯一
    | 'no_name'         // 学号重复，靠姓名区分
    | 'name'            // 姓名一致
    | 'name_fuzzy'      // 姓名相近（可能是错字）
    | 'conflict'        // 学号指向一人、姓名指向另一人
    | 'name_mismatch'   // 学号命中但姓名对不上
    | 'class_mismatch'  // 学号只存在于其他班
    | 'ambiguous'       // 多人同样符合（如不同班同名）
    | 'not_found'       // 花名册中找不到
    | 'no_identity'     // 卷面没有可识别的身份信息
    | 'duplicate'       // 该学生已有另一份答卷
    | 'manual';         // 老师指定

export interface MatchCandidate {
    studentId: string;
    confidence: number;
    reason: MatchReasonCode;
}

export interface MatchResult {
    status: 'matched' | 'review';
    studentId: string | null;
    confidence: number;
    reason: MatchReasonCode;
    /** 学号填了但花名册中没有 */
    studentNoUnmatched?: boolean;
    candidates: MatchCandidate[];
}

/** 达到此置信度才自动分配 */
export const AUTO_MATCH_CONFIDENCE = 0.75;

// 手写或识别时容易混淆的字，替换代价按 0.4 计
const SIMILAR_GROUPS = [
    '己已巳', '未末', '王玉主', '李季', '刘浏', '陈阵', '杨扬', '晓哓', '明朋', '子孑', '土士', '天夭', '日曰',
    '人入八', '干千于', '刀力', '大太犬', '冶治', '睛晴', '候侯', '延廷', '佳住', '宁宇', '欣忻', '婷停', '涛寿',
    '浩洁', '伟玮', '萱宣', '辰晨', '宸震', '轩新', '怡恰', '琪棋', '琳淋', '静净', '雯文', '彤丹', '昊吴', '浚俊',
    '峻竣', '钰玉', '颖颍', '睿蕊', '妍研', '涵函', '馨磬', '泽择', '锦绵', '程呈', '思恩', '雨两', '梓样', '一乙',
];
const SIMILAR = new Map<string, Set<string>>();
for (const group of SIMILAR_GROUPS) {
    for (const char of group) {
        const set = SIMILAR.get(char) || new Set<string>();
        for (const other of group) if (other !== char) set.add(other);
        SIMILAR.set(char, set);
    }
}

const FULL_WIDTH = /[\uFF01-\uFF5E]/g;
const toHalfWidth = (text: string) => text.replace(FULL_WIDTH, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ');

/** 姓名归一：去空格、标点、"同学"等后缀 */
export function normalizeName(value: string | null | undefined): string {
    return toHalfWidth(value || '').replace(/[\s·•.,，。、'"()（）\-_]/g, '').replace(/(同学|学生)$/, '').toLowerCase();
}

// 学号里常见的字母误读为数字
const DIGIT_LIKE: Record<string, string> = { o: '0', O: '0', D: '0', l: '1', I: '1', i: '1', '|': '1', Z: '2', z: '2', S: '5', s: '5', B: '8', g: '9', q: '9' };

/** 学号归一：全角转半角、去分隔符；纯数字的学号里把形似数字的字母纠正为数字 */
export function normalizeStudentNo(value: string | null | undefined): string {
    const text = toHalfWidth(value || '').replace(/[\s\-_./#№号]/g, '');
    if (!text) return '';
    const digits = text.replace(/[oODlIi|ZzSsBgq]/g, (char) => DIGIT_LIKE[char] || char);
    return /^\d+$/.test(digits) && /\d/.test(text) ? digits : text.toUpperCase();
}

/** 学号相等：忽略前导零（"07" 与 "7"） */
export function studentNoEqual(a: string | null | undefined, b: string | null | undefined): boolean {
    const x = normalizeStudentNo(a);
    const y = normalizeStudentNo(b);
    if (!x || !y) return false;
    if (x === y) return true;
    return /^\d+$/.test(x) && /^\d+$/.test(y) && x.replace(/^0+/, '') === y.replace(/^0+/, '');
}

/** 带形近字的编辑距离 */
function editDistance(a: string[], b: string[]): number {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        let prev = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const temp = row[j];
            const cost = a[i - 1] === b[j - 1] ? 0 : SIMILAR.get(a[i - 1])?.has(b[j - 1]) ? 0.4 : 1;
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
            prev = temp;
        }
    }
    return row[b.length];
}

/** 姓名相似度 0~1 */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
    const x = [...normalizeName(a)];
    const y = [...normalizeName(b)];
    if (!x.length || !y.length) return 0;
    return Math.max(0, 1 - editDistance(x, y) / Math.max(x.length, y.length));
}

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 把 "十二"、"三" 这样的中文数字转成阿拉伯数字 */
function chineseNumbers(text: string): string {
    return text.replace(/[零〇一二两三四五六七八九十]+/g, (match) => {
        if (!match.includes('十')) return [...match].map((char) => CN_DIGITS[char]).join('');
        const [tens, ones] = match.split('十');
        return String((tens ? CN_DIGITS[tens] ?? 1 : 1) * 10 + (ones ? CN_DIGITS[ones] ?? 0 : 0));
    });
}

/** 从班级名中解析年级和班号，如 "七年级(3)班" → {grade: 7, cls: 3}，"初二5班" → {grade: 8, cls: 5} */
export function parseClassKey(value: string | null | undefined): { grade: number | null; cls: number | null; text: string } {
    let text = chineseNumbers(toHalfWidth(value || '')).replace(/\s+/g, '');
    text = text.replace(/初([1-3])/, (_, n) => `${6 + Number(n)}年级`).replace(/高([1-3])/, (_, n) => `${9 + Number(n)}年级`);
    const grade = text.match(/(\d{1,2})年级/)?.[1];
    const rest = grade ? text.replace(/\d{1,2}年级/, '') : text;
    const cls = rest.match(/(\d{1,2})班/)?.[1] || rest.match(/\((\d{1,2})\)/)?.[1] || rest.match(/^(\d{1,2})$/)?.[1];
    if (!grade && !cls) {
        // "703" 这种年级+班号的简写
        const compact = text.match(/^(\d)(\d{2})班?$/);
        if (compact) return { grade: Number(compact[1]), cls: Number(compact[2]), text };
    }
    return { grade: grade ? Number(grade) : null, cls: cls ? Number(cls) : null, text };
}

/** 卷面班级与花名册班级的关系 */
export function classRelation(detected: string | null | undefined, rosterClass: string): 'match' | 'mismatch' | 'unknown' {
    if (!detected?.trim()) return 'unknown';
    const a = parseClassKey(detected);
    const b = parseClassKey(rosterClass);
    if (a.text && a.text === b.text) return 'match';
    if (a.cls === null || b.cls === null) return 'unknown';
    if (a.cls !== b.cls) return 'mismatch';
    if (a.grade !== null && b.grade !== null && a.grade !== b.grade) return 'mismatch';
    return 'match';
}

export function hasIdentity(identity: PaperIdentity | null | undefined): boolean {
    return !!(identity && (normalizeName(identity.name) || normalizeStudentNo(identity.studentNo) || identity.className?.trim()));
}

const round2 = (value: number) => Math.round(value * 100) / 100;

interface Scored {
    student: RosterStudent;
    rel: 'match' | 'mismatch' | 'unknown';
    noEq: boolean;
    sim: number;
}

/** 按卷面身份信息在花名册（本次收卷的所有班级）中找学生 */
export function matchStudent(identity: PaperIdentity, roster: RosterStudent[]): MatchResult {
    const no = normalizeStudentNo(identity.studentNo);
    const name = normalizeName(identity.name);
    const review = (reason: MatchReasonCode, confidence: number, candidates: MatchCandidate[], extra: Partial<MatchResult> = {}): MatchResult =>
        ({ status: 'review', studentId: null, confidence: round2(confidence), reason, candidates: candidates.slice(0, 3), ...extra });

    if (!no && !name) return review('no_identity', 0, []);

    const scored: Scored[] = roster.map((student) => ({
        student,
        rel: classRelation(identity.className, student.className),
        noEq: !!no && studentNoEqual(no, student.studentNo),
        sim: name ? nameSimilarity(name, student.name) : 0,
    }));
    const candidate = (item: Scored, confidence: number, reason: MatchReasonCode): MatchCandidate =>
        ({ studentId: item.student.id, confidence: round2(confidence), reason });
    const byName = scored.filter((item) => item.sim >= 0.4 && item.rel !== 'mismatch').sort((a, b) => b.sim - a.sim || relRank(a) - relRank(b));

    // 1. 学号
    const noHits = scored.filter((item) => item.noEq);
    if (noHits.length) {
        let hit: Scored | null = null;
        let base = 0;
        let reason: MatchReasonCode = 'no_only';
        const sameClass = noHits.filter((item) => item.rel === 'match');
        const notOther = noHits.filter((item) => item.rel !== 'mismatch');
        if (sameClass.length === 1) {
            hit = sameClass[0]; base = 0.97; reason = 'class_no';
        } else if (notOther.length === 1) {
            hit = notOther[0]; base = 0.9;
        } else if (notOther.length > 1) {
            // 不同班同学号：用姓名区分
            const named = notOther.filter((item) => item.sim >= 0.8);
            if (named.length === 1) {
                hit = named[0]; base = 0.88; reason = 'no_name';
            } else {
                return review('ambiguous', 0.4, notOther.map((item) => candidate(item, 0.4 + item.sim * 0.3, 'ambiguous')).sort((a, b) => b.confidence - a.confidence));
            }
        } else {
            // 学号只存在于卷面班级以外的班
            const best = noHits.sort((a, b) => b.sim - a.sim)[0];
            return review('class_mismatch', 0.5, [candidate(best, 0.5, 'class_mismatch'), ...byName.filter((item) => item !== best).map((item) => candidate(item, item.sim * 0.6, 'name_fuzzy'))]);
        }

        if (!name) {
            return { status: 'matched', studentId: hit.student.id, confidence: round2(base - 0.04), reason, candidates: [candidate(hit, base - 0.04, reason)] };
        }
        if (hit.sim >= 0.8) {
            const confidence = Math.min(0.99, base + 0.02);
            return { status: 'matched', studentId: hit.student.id, confidence: round2(confidence), reason, candidates: [candidate(hit, confidence, reason)] };
        }
        const other = byName.find((item) => item !== hit && item.sim >= 0.8);
        if (other) {
            return review('conflict', 0.4, [candidate(hit, 0.45, 'class_no'), candidate(other, 0.45, 'name')]);
        }
        if (hit.sim >= 0.5) {
            const confidence = base - 0.12;
            return { status: confidence >= AUTO_MATCH_CONFIDENCE ? 'matched' : 'review', studentId: confidence >= AUTO_MATCH_CONFIDENCE ? hit.student.id : null, confidence: round2(confidence), reason: 'name_fuzzy', candidates: [candidate(hit, confidence, reason)] };
        }
        return review('name_mismatch', 0.5, [candidate(hit, 0.5, 'name_mismatch'), ...byName.slice(0, 2).map((item) => candidate(item, item.sim * 0.6, 'name_fuzzy'))]);
    }

    // 2. 姓名
    const extra = no ? { studentNoUnmatched: true } : {};
    if (!name || !byName.length) {
        const loose = scored.filter((item) => item.sim >= 0.3).sort((a, b) => b.sim - a.sim);
        return review('not_found', 0, loose.map((item) => candidate(item, item.sim * 0.5, 'name_fuzzy')), extra);
    }
    const top = byName[0];
    const ties = byName.filter((item) => item.sim === top.sim && relRank(item) === relRank(top));
    if (ties.length > 1) {
        return review('ambiguous', 0.4, ties.map((item) => candidate(item, 0.4, 'ambiguous')), extra);
    }
    let confidence = top.sim * (top.rel === 'match' ? 0.95 : 0.85);
    const second = byName[1];
    if (second && top.sim - second.sim < 0.15 && relRank(second) <= relRank(top)) confidence *= 0.8;
    if (no) confidence *= 0.85;
    const reason: MatchReasonCode = top.sim === 1 ? 'name' : 'name_fuzzy';
    const candidates = byName.slice(0, 3).map((item, index) => candidate(item, index === 0 ? confidence : item.sim * 0.6, item.sim === 1 ? 'name' : 'name_fuzzy'));
    if (confidence >= AUTO_MATCH_CONFIDENCE) {
        return { status: 'matched', studentId: top.student.id, confidence: round2(confidence), reason, candidates, ...extra };
    }
    return review(reason, confidence, candidates, extra);
}

/** 同班优先 */
function relRank(item: Scored): number {
    return item.rel === 'match' ? 0 : 1;
}

/** 自动匹配到的学生已经有另一份答卷时，改为待确认，避免一人两份 */
export function flagDuplicate(result: MatchResult, takenStudentIds: Set<string>): MatchResult {
    if (result.status !== 'matched' || !result.studentId || !takenStudentIds.has(result.studentId)) return result;
    return {
        ...result,
        status: 'review',
        studentId: null,
        reason: 'duplicate',
        candidates: result.candidates.map((item) => item.studentId === result.studentId ? { ...item, reason: 'duplicate' } : item),
    };
}

/** 用于把连续的页归为同一份的身份键：已匹配学生用学生 ID，否则用归一后的卷面信息 */
export function identityKey(identity: PaperIdentity | null | undefined, studentId?: string | null): string | null {
    if (studentId) return `s:${studentId}`;
    if (!hasIdentity(identity)) return null;
    return `i:${parseClassKey(identity?.className).text}|${normalizeStudentNo(identity?.studentNo).replace(/^0+/, '')}|${normalizeName(identity?.name)}`;
}
