"use client";

import Link from "next/link";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { QuestionFigure } from "@/components/question-figure";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTimeZone } from "@/contexts/TimeZoneContext";
import { formatDateTime } from "@/lib/date-time";
import type { PracticeHistoryRecord } from "@/types/api";

export const RESULT_BADGE_CLASS: Record<string, string> = {
    correct: "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 border-green-200 dark:border-green-900",
    wrong: "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900",
    not_attempted: "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900",
};

interface PracticeRecordListProps {
    records: PracticeHistoryRecord[];
    expanded: string | null;
    onToggleExpand: (id: string | null) => void;
    onDelete?: (id: string) => void;
}

/** 举一反三作答历史列表 */
export function PracticeRecordList({ records, expanded, onToggleExpand, onDelete }: PracticeRecordListProps) {
    const { timeZone } = useTimeZone();
    const { t } = useLanguage();
    const difficultyLabels = t.practice.difficulty as Record<string, string>;

    if (records.length === 0) {
        return <p className="text-sm text-muted-foreground italic">{t.mastery.noHistory}</p>;
    }

    return (
        <ul className="divide-y rounded-md border">
            {records.map((record) => (
                <li key={record.id} className="p-3 text-sm space-y-2">
                    <div className="flex items-start gap-2">
                        <button
                            type="button"
                            className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left"
                            onClick={() => onToggleExpand(expanded === record.id ? null : record.id)}
                        >
                            <span className="text-muted-foreground tabular-nums">{formatDateTime(record.createdAt, "yyyy-MM-dd HH:mm", timeZone)}</span>
                            <Badge variant="outline" className={RESULT_BADGE_CLASS[record.result] || ""}>
                                {t.mastery.results[record.result as keyof typeof t.mastery.results] || record.result}
                            </Badge>
                            {record.difficulty && <Badge variant="secondary">{difficultyLabels[record.difficulty] || record.difficulty}</Badge>}
                            <span className="text-xs text-muted-foreground">
                                {record.exam ? `${t.mastery.sources.exam} · ${record.exam.title}` : t.mastery.sources[record.source as keyof typeof t.mastery.sources] || t.mastery.sources.practice}
                            </span>
                            {record.questionText && (
                                <span className="ml-auto text-muted-foreground">
                                    {expanded === record.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                </span>
                            )}
                        </button>
                        {onDelete && (
                            <button
                                type="button"
                                aria-label={t.mastery.deleteRecord}
                                title={t.mastery.deleteRecord}
                                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-600 dark:hover:text-red-400"
                                onClick={() => onDelete(record.id)}
                            >
                                <Trash2 className="h-4 w-4" />
                            </button>
                        )}
                    </div>
                    {expanded === record.id && record.questionText && (
                        <div className="space-y-2 rounded-md bg-muted/40 p-3">
                            <MarkdownRenderer content={record.questionText} />
                            <QuestionFigure svg={record.figureSvg} />
                            {record.wrongAnswerText && (
                                <div className="border-t pt-2">
                                    <p className="mb-1 font-medium">{t.editor.wrongAnswerText}</p>
                                    <MarkdownRenderer content={record.wrongAnswerText} />
                                </div>
                            )}
                            {record.mistakeAnalysis && (
                                <div className="border-t pt-2">
                                    <p className="mb-1 font-medium">{t.editor.mistakeAnalysis}</p>
                                    <MarkdownRenderer content={record.mistakeAnalysis} />
                                </div>
                            )}
                            {record.originalImageUrl && (
                                // 作答图片可能来自上传的数据 URL，按原始比例显示。
                                <img src={record.originalImageUrl} alt={t.editor.wrongAnswerText} className="max-h-96 max-w-full rounded object-contain" />
                            )}
                            {record.answerText && (
                                <div className="border-t pt-2">
                                    <MarkdownRenderer content={record.answerText} className="font-semibold" />
                                </div>
                            )}
                            {record.exam && (
                                <Link href={`/exams/${record.exam.paperId}`} className="text-xs text-primary hover:underline">
                                    {record.exam.title}
                                </Link>
                            )}
                        </div>
                    )}
                </li>
            ))}
        </ul>
    );
}
