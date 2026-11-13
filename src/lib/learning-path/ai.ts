/**
 * 可选的顺序建议。自动规划不走这里；仅教师手动点击时调用，且由服务层限制每日次数。
 * 失败或无模型时退回传入的确定性顺序。
 */
import { getAIService } from "@/lib/ai";
import { createPromptRequest } from "@/lib/ai/prompts";

const SYSTEM_ZH = `你是教研助手。根据学生知识点的掌握分与先修关系，给出学习顺序。
只输出 JSON：{"order":["知识点1","知识点2"]}。order 必须是输入 knowledgePoints 的重排，不能新增或改名。`;
const SYSTEM_EN = `You are a teaching assistant. Reorder knowledge points for a student.
Return JSON only: {"order":["point1","point2"]}. Use exactly the given names, no additions.`;

export async function suggestKnowledgeOrder(
    points: Array<{ knowledgePoint: string; mastery: number; reason?: string }>,
    language: "zh" | "en",
): Promise<{ order: string[]; usedAi: boolean }> {
    const fallback = points.map((item) => item.knowledgePoint);
    if (fallback.length <= 1) return { order: fallback, usedAi: false };
    try {
        const result = await getAIService().completeJson(createPromptRequest(
            language === "en" ? SYSTEM_EN : SYSTEM_ZH,
            { knowledgePoints: points },
            language === "en" ? "Reorder the knowledge points as JSON." : "请重排知识点并输出 JSON。",
        ));
        const raw = result.data && typeof result.data === "object" ? (result.data as { order?: unknown }).order : undefined;
        const names = Array.isArray(raw) ? raw.map((item) => String(item)) : [];
        const allowed = new Set(fallback);
        const order = names.filter((name) => allowed.has(name));
        for (const name of fallback) {
            if (!order.includes(name)) order.push(name);
        }
        return { order, usedAi: order.length > 0 };
    } catch {
        return { order: fallback, usedAi: false };
    }
}
