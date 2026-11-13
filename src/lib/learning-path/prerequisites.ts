/**
 * 知识点先修关系：以 KnowledgeTag.parentId 邻接表为边，再补上同题共现的弱提示（仅用于打破平局）。
 * 环会被丢弃。排序使用 Kahn 拓扑，与常见技能图做法一致，独立实现。
 */
export interface PrerequisiteTag {
    name: string;
    parentName?: string | null;
}

export interface PrerequisiteGraph {
    /** prereq -> dependents */
    edges: Map<string, Set<string>>;
    /** dependent -> prereqs */
    prereqs: Map<string, Set<string>>;
}

function addEdge(graph: PrerequisiteGraph, from: string, to: string) {
    const a = from.trim();
    const b = to.trim();
    if (!a || !b || a === b) return;
    if (!graph.edges.has(a)) graph.edges.set(a, new Set());
    if (!graph.prereqs.has(b)) graph.prereqs.set(b, new Set());
    graph.edges.get(a)!.add(b);
    graph.prereqs.get(b)!.add(a);
}

function wouldCreateCycle(graph: PrerequisiteGraph, from: string, to: string): boolean {
    // 若 to 已能走到 from，再加 from->to 会成环
    const seen = new Set<string>();
    const stack = [to];
    while (stack.length) {
        const node = stack.pop()!;
        if (node === from) return true;
        if (seen.has(node)) continue;
        seen.add(node);
        for (const next of graph.edges.get(node) ?? []) stack.push(next);
    }
    return false;
}

export function buildPrerequisiteGraph(tags: PrerequisiteTag[]): PrerequisiteGraph {
    const graph: PrerequisiteGraph = { edges: new Map(), prereqs: new Map() };
    for (const tag of tags) {
        if (tag.parentName) addEdge(graph, tag.parentName, tag.name);
    }
    return graph;
}

/** 若加入边不会成环则添加（用于共现等弱启发式） */
export function addPrerequisiteEdge(graph: PrerequisiteGraph, from: string, to: string): boolean {
    if (wouldCreateCycle(graph, from, to)) return false;
    addEdge(graph, from, to);
    return true;
}

/**
 * 对给定知识点做拓扑排序：先修在前。不在图中的点按传入的优先级（弱点分）排列并插入。
 * priority 越大越需要先补（薄弱），但须排在未掌握的先修之后。
 */
export function orderKnowledgePoints(
    points: string[],
    graph: PrerequisiteGraph,
    priority: Map<string, number> = new Map(),
): string[] {
    const unique = [...new Set(points.map((name) => name.trim()).filter(Boolean))];
    const set = new Set(unique);
    const indegree = new Map<string, number>();
    for (const point of unique) indegree.set(point, 0);
    for (const point of unique) {
        for (const pre of graph.prereqs.get(point) ?? []) {
            if (set.has(pre)) indegree.set(point, (indegree.get(point) ?? 0) + 1);
        }
    }

    const ready = unique.filter((point) => (indegree.get(point) ?? 0) === 0);
    const sortReady = () => ready.sort((a, b) => (priority.get(b) ?? 0) - (priority.get(a) ?? 0) || a.localeCompare(b, "zh"));
    sortReady();

    const ordered: string[] = [];
    while (ready.length) {
        const next = ready.shift()!;
        ordered.push(next);
        for (const child of graph.edges.get(next) ?? []) {
            if (!set.has(child)) continue;
            const degree = (indegree.get(child) ?? 0) - 1;
            indegree.set(child, degree);
            if (degree === 0) {
                ready.push(child);
                sortReady();
            }
        }
    }

    // 若有环导致剩余，按优先级追加，避免丢点
    for (const point of unique) {
        if (!ordered.includes(point)) ordered.push(point);
    }
    return ordered;
}

/** 某知识点尚未就绪：存在优先度更高（更薄弱或明确先修）且仍弱的先修 */
export function unmetPrerequisites(
    point: string,
    graph: PrerequisiteGraph,
    masteryScore: Map<string, number>,
    cutoff: number,
): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    const stack = [...(graph.prereqs.get(point) ?? [])];
    while (stack.length) {
        const pre = stack.pop()!;
        if (seen.has(pre)) continue;
        seen.add(pre);
        if ((masteryScore.get(pre) ?? 0) < cutoff) result.push(pre);
        for (const parent of graph.prereqs.get(pre) ?? []) stack.push(parent);
    }
    return result;
}
