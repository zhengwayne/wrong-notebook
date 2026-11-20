import type { ProcessLevel, VisualAlertKind } from "@/lib/ai/exam-paper-read";

export const PROCESS_CAPSULE_KEYS = [
    "neat_writing",
    "clean_layout",
    "serious_attitude",
    "clear_progress",
    "too_many_erasures",
    "messy_writing",
    "missing_steps",
    "avoid_blank",
] as const;

export type ProcessCapsuleKey = typeof PROCESS_CAPSULE_KEYS[number];

interface CapsuleCopy {
    label: string;
    sentence: string;
}

const ZH_CAPSULES: Record<ProcessCapsuleKey, CapsuleCopy> = {
    neat_writing: { label: "书写工整", sentence: "字迹端正有力，看着非常舒服！" },
    clean_layout: { label: "卷面清爽", sentence: "卷面整洁有序，分步排版清晰规范。" },
    serious_attitude: { label: "态度认真", sentence: "作答与订正态度十分端正，继续保持！" },
    clear_progress: { label: "进步明显", sentence: "相比前次作业，规范度与准确率都有明显进步！" },
    too_many_erasures: { label: "涂改偏多", sentence: "建议先在草稿纸理清思路再落笔，减少卷面黑团涂改。" },
    messy_writing: { label: "字迹略潦草", sentence: "书写速度可适当放慢，把数字、符号和关键字写清楚避免误判。" },
    missing_steps: { label: "跳步缺过程", sentence: "解答与证明题请写全关键推理条件，避免无谓扣步骤分。" },
    avoid_blank: { label: "切勿畏难留白", sentence: "遇到综合题先尝试转化已知条件，不要轻易留白放弃哦！" },
};

const EN_CAPSULES: Record<ProcessCapsuleKey, CapsuleCopy> = {
    neat_writing: { label: "Neat Writing", sentence: "Your handwriting is neat and clear—great job!" },
    clean_layout: { label: "Clean Layout", sentence: "Well-organized layout with clear step alignment." },
    serious_attitude: { label: "Earnest Attitude", sentence: "Thoughtful effort and diligent work—keep it up!" },
    clear_progress: { label: "Clear Progress", sentence: "Noticeable improvement in both accuracy and presentation!" },
    too_many_erasures: { label: "Heavy Erasures", sentence: "Plan on scratch paper first to reduce smudges and erasures." },
    messy_writing: { label: "Slightly Messy", sentence: "Slow down slightly so numbers and symbols stay legible." },
    missing_steps: { label: "Missing Steps", sentence: "Show key intermediate steps to avoid losing method marks." },
    avoid_blank: { label: "Avoid Leaving Blank", sentence: "Try listing known conditions on hard items rather than leaving them blank." },
};

const LEVEL_LABELS_ZH: Record<ProcessLevel, string> = {
    excellent: "优",
    good: "良",
    fair: "合格",
    needs_work: "待改进",
};

const LEVEL_LABELS_EN: Record<ProcessLevel, string> = {
    excellent: "Excellent",
    good: "Good",
    fair: "Fair",
    needs_work: "Needs Work",
};

const ALERT_TO_CAPSULE: Record<VisualAlertKind, ProcessCapsuleKey> = {
    heavy_erasure: "too_many_erasures",
    messy_handwriting: "messy_writing",
    missing_steps: "missing_steps",
    large_blank: "avoid_blank",
};

export function getProcessCapsules(language: "zh" | "en" = "zh"): Record<ProcessCapsuleKey, CapsuleCopy> {
    return language === "en" ? EN_CAPSULES : ZH_CAPSULES;
}

/** 将 AI 宏观视觉信号映射为推荐老师一键点选的评语胶囊 */
export function visualAlertDefaultCapsules(alerts: readonly string[]): ProcessCapsuleKey[] {
    const out = new Set<ProcessCapsuleKey>();
    for (const alert of alerts) {
        if (Object.hasOwn(ALERT_TO_CAPSULE, alert)) {
            out.add(ALERT_TO_CAPSULE[alert as VisualAlertKind]);
        }
    }
    return Array.from(out);
}

export interface SynthesizeCommentInput {
    handwritingLevel?: ProcessLevel | string | null;
    neatnessLevel?: ProcessLevel | string | null;
    attitudeLevel?: ProcessLevel | string | null;
    capsuleKeys?: readonly string[];
}

function asValidLevel(val: string | null | undefined): ProcessLevel | null {
    if (val === "excellent" || val === "good" || val === "fair" || val === "needs_work") return val;
    return null;
}

/**
 * 零打字合成教师/家长过程性评语：把书写、整洁度、学习态度等级与选中的胶囊自然拼接成鼓励式反馈。
 */
export function synthesizeTeacherComment(
    input: SynthesizeCommentInput,
    language: "zh" | "en" = "zh",
): string {
    const hw = asValidLevel(input.handwritingLevel);
    const nt = asValidLevel(input.neatnessLevel);
    const at = asValidLevel(input.attitudeLevel);
    const capsules = getProcessCapsules(language);

    const headerParts: string[] = [];
    if (language === "en") {
        if (hw) headerParts.push(`Handwriting: ${LEVEL_LABELS_EN[hw]}`);
        if (nt) headerParts.push(`Neatness: ${LEVEL_LABELS_EN[nt]}`);
        if (at) headerParts.push(`Attitude: ${LEVEL_LABELS_EN[at]}`);
    } else {
        if (hw) headerParts.push(`书写：${LEVEL_LABELS_ZH[hw]}`);
        if (nt) headerParts.push(`整洁：${LEVEL_LABELS_ZH[nt]}`);
        if (at) headerParts.push(`态度：${LEVEL_LABELS_ZH[at]}`);
    }

    const sentences = Array.from(new Set(input.capsuleKeys ?? []))
        .filter((k): k is ProcessCapsuleKey => Object.hasOwn(capsules, k))
        .map((k) => capsules[k].sentence);

    const prefix = headerParts.length > 0
        ? (language === "en" ? `[${headerParts.join(" · ")}] ` : `【${headerParts.join(" · ")}】`)
        : "";
    return `${prefix}${sentences.join(language === "en" ? " " : "")}`.trim();
}
