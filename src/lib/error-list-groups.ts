import { deriveErrorType } from "@/lib/error-type";
import { getItemTags } from "@/lib/item-tags";

export type ErrorListGroupMode = "date" | "knowledge" | "cause";

export interface ErrorListGroup<T> {
    key: string;
    label: string;
    items: T[];
}

/** 按知识点或错因分组；同一题可出现在多个知识点分组中。按日期时保持原顺序、不拆分组。 */
export function groupErrorItems<T extends {
    id: string;
    createdAt?: string | Date;
    errorType?: string | null;
    mistakeAnalysis?: string | null;
    tags?: { name: string }[] | null;
    knowledgePoints?: string | null;
}>(items: T[], mode: ErrorListGroupMode, labels: { ungrouped: string; unknownCause: string }): ErrorListGroup<T>[] {
    if (mode === "date") {
        return items.length > 0 ? [{ key: "date", label: labels.ungrouped, items }] : [];
    }
    const groups = new Map<string, ErrorListGroup<T>>();
    const add = (key: string, label: string, item: T) => {
        const existing = groups.get(key);
        if (existing) {
            if (!existing.items.some((entry) => entry.id === item.id)) existing.items.push(item);
            return;
        }
        groups.set(key, { key, label, items: [item] });
    };
    for (const item of items) {
        if (mode === "knowledge") {
            const points = getItemTags(item);
            if (points.length === 0) add("__ungrouped__", labels.ungrouped, item);
            else points.forEach((point) => add(`kp:${point}`, point, item));
        } else {
            const cause = item.errorType?.trim() || deriveErrorType(item.mistakeAnalysis) || labels.unknownCause;
            add(`cause:${cause}`, cause, item);
        }
    }
    return [...groups.values()];
}
