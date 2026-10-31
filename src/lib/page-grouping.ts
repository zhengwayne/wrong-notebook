/**
 * 收卷拍照时把连续拍的页自动归成一份份答卷（纯逻辑）：
 * - 读出身份（班级/学号/姓名）且与上一份不同 → 新的一份
 * - 与上一份是同一个学生（连续两页都写了名字）→ 续页，不重复
 * - 没有身份信息（背面、A3 第二面）→ 接在上一份后面；第一页就没有身份 → 单独一份并待确认
 * - 老师可以手动"从这页起新一份"或"并入上一份"，并给一份指定学生
 * 一份答卷只有在后面已经开始新的一份（或老师点了"完成"）且所有页都识别完时才算定稿，可以上传判分。
 */
import { identityKey, type MatchResult, type PaperIdentity } from "@/lib/student-match";

export interface CapturedPage {
    id: string;
    /** reading 识别中；read 已识别；failed 识别失败（按无身份处理） */
    status: 'reading' | 'read' | 'failed';
    identity?: PaperIdentity | null;
    match?: Pick<MatchResult, 'status' | 'studentId' | 'confidence' | 'reason' | 'candidates'> | null;
    /** 老师手动：new 从这页起新一份；continue 并入上一份 */
    manualBreak?: 'new' | 'continue';
    /** 老师给这页所在的一份指定学生（记在该份第一页） */
    assignStudentId?: string | null;
}

export type PaperFlag = 'no_identity' | 'needs_review' | 'read_failed';

export interface GroupedPaper {
    pageIds: string[];
    /** 首个带身份的页（用于显示匹配结果） */
    identityPageId: string | null;
    studentId: string | null;
    /** 老师指定的学生 */
    manual: boolean;
    match: CapturedPage['match'] | null;
    identity: PaperIdentity | null;
    flags: PaperFlag[];
    settled: boolean;
}

/** 按拍摄顺序分组；finished 表示老师已点"完成"，最后一份也可以定稿 */
export function groupCapturedPages(pages: CapturedPage[], finished = false): GroupedPaper[] {
    const papers: (GroupedPaper & { key: string | null; hasPending: boolean })[] = [];
    for (const page of pages) {
        const current = papers[papers.length - 1];
        const pending = page.status === 'reading';
        const matchedId = page.match?.status === 'matched' ? page.match.studentId : null;
        const key = pending ? null : identityKey(page.identity, page.assignStudentId || matchedId);
        const startNew = () => {
            papers.push({
                pageIds: [page.id], identityPageId: key ? page.id : null, key,
                studentId: page.assignStudentId || matchedId || null, manual: !!page.assignStudentId,
                match: key ? page.match || null : null, identity: key ? page.identity || null : null,
                flags: [], settled: false, hasPending: pending,
            });
        };
        const append = () => {
            current.pageIds.push(page.id);
            current.hasPending ||= pending;
            if (!current.key && key) {
                // 第一页没身份，后面的页读出了身份：整份按这个身份
                current.key = key;
                current.identityPageId = page.id;
                current.identity = page.identity || null;
                current.match = page.match || null;
                if (!current.manual) current.studentId = page.assignStudentId || matchedId || null;
            }
        };

        if (!current || page.manualBreak === 'new') startNew();
        else if (page.manualBreak === 'continue' || pending || !key || key === current.key) append();
        else startNew();
        if (page.status === 'failed') {
            const target = papers[papers.length - 1];
            if (!target.flags.includes('read_failed')) target.flags.push('read_failed');
        }
    }

    let pendingBefore = false;
    return papers.map(({ key, hasPending, ...paper }, index) => {
        const flags = [...paper.flags];
        if (!key && !paper.manual) flags.push('no_identity');
        if (!paper.manual && (!paper.studentId || paper.match?.status === 'review')) flags.push('needs_review');
        // 后面已开始新的一份（或已点完成）说明这一份的页已经齐了；前面还有页在识别时不定稿，因为它可能改变分组
        const closed = index < papers.length - 1 || finished;
        const settled = !hasPending && !pendingBefore && closed;
        pendingBefore ||= hasPending;
        return { ...paper, flags: [...new Set(flags)], settled };
    });
}
