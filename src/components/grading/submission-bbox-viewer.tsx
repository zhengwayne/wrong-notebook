"use client";

import { Scissors } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { validateQuestionBBox } from "@/lib/parent-paper-review";
import type { GradingResultDetail } from "@/types/grading";

export interface SubmissionBboxViewerProps {
    images: string[];
    results: GradingResultDetail[];
    activeResultId: string | null;
    canSplit: boolean;
    onSelectResult: (resultId: string) => void;
    onSplitPage: (pageIndex: number) => void;
}

function borderClassByVerdict(verdict: GradingResultDetail["verdict"], active: boolean): string {
    const ring = active ? "ring-2 ring-primary ring-offset-1 z-10" : "opacity-85 hover:opacity-100";
    if (verdict === "correct") return `border-emerald-500 bg-emerald-500/10 ${ring}`;
    if (verdict === "partial") return `border-amber-500 bg-amber-500/15 ${ring}`;
    return `border-rose-500 bg-rose-500/15 ${ring}`;
}

function badgeSymbol(verdict: GradingResultDetail["verdict"]): string {
    if (verdict === "correct") return "✓";
    if (verdict === "partial") return "△";
    return "✗";
}

/**
 * 教师复核页原卷题框叠层视图：在学生答卷照片上展示每道题的归一化 bbox 红绿批注框，点击可与右侧得分栏双向联动定位。
 */
export function SubmissionBboxViewer({
    images,
    results,
    activeResultId,
    canSplit,
    onSelectResult,
    onSplitPage,
}: SubmissionBboxViewerProps) {
    const { t } = useLanguage();
    const pageCount = Math.max(1, images.length);

    const parsedBoxes = results.flatMap((res) => {
        if (!res.bbox) return [];
        try {
            const validated = validateQuestionBBox(JSON.parse(res.bbox), pageCount);
            return validated ? [{ res, bbox: validated }] : [];
        } catch {
            return [];
        }
    });

    return (
        <div className="space-y-3">
            {images.map((image, pageIndex) => {
                const pageBoxes = parsedBoxes.filter((item) => item.bbox.pageIndex === pageIndex);
                return (
                    <div key={pageIndex} className="space-y-1.5">
                        <div className="relative overflow-hidden rounded-xl border bg-muted/20">
                            <img
                                src={image}
                                alt={t.grading.paperN.replace("{index}", String(pageIndex + 1))}
                                className="block w-full select-none"
                            />
                            {pageBoxes.map(({ res, bbox }) => {
                                const isActive = activeResultId === res.id;
                                return (
                                    <button
                                        key={res.id}
                                        type="button"
                                        onClick={() => onSelectResult(res.id)}
                                        style={{
                                            left: `${bbox.x * 100}%`,
                                            top: `${bbox.y * 100}%`,
                                            width: `${bbox.width * 100}%`,
                                            height: `${bbox.height * 100}%`,
                                        }}
                                        className={`absolute rounded-md border-2 text-left transition ${borderClassByVerdict(res.verdict, isActive)}`}
                                        title={`#${res.question.number} (${res.score}/${res.question.maxScore})`}
                                    >
                                        <span className="inline-flex items-center gap-0.5 rounded-br bg-background/90 px-1.5 py-0.5 font-mono text-[11px] font-semibold shadow-sm">
                                            <span>{badgeSymbol(res.verdict)}</span>
                                            <span>{res.question.number}</span>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <a href={image} target="_blank" rel="noreferrer" className="hover:underline">
                                {t.grading.paperN.replace("{index}", String(pageIndex + 1))}
                            </a>
                            {pageIndex > 0 && canSplit && (
                                <Button size="sm" variant="outline" onClick={() => onSplitPage(pageIndex)}>
                                    <Scissors className="h-3.5 w-3.5" />
                                    {t.grading.match.splitHere}
                                </Button>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
