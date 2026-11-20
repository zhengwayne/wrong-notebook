/** 从错因分析抽出简短分类标签，供错题本按错因分组 */
export function deriveErrorType(mistakeAnalysis?: string | null): string | null {
    if (!mistakeAnalysis) return null;
    const text = mistakeAnalysis.replace(/\s+/g, " ").trim();
    if (!text) return null;
    const sentence = (text.split(/[。！？.!?;；\n]/)[0] || text).trim();
    if (!sentence) return null;
    return sentence.slice(0, 40);
}
