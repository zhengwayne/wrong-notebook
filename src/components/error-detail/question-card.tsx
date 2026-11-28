"use client";

import { useRef, useState } from "react";
import { MarkdownEditor } from "@/components/markdown-editor";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { PinyinToolbar } from "@/components/pinyin-toolbar";
import { FigureCompare } from "@/components/figure-compare";
import { QuestionFigure } from "@/components/question-figure";
import { RegenerateFigureButton } from "@/components/regenerate-figure-button";
import { ReplaceQuestionImageButton } from "@/components/replace-question-image-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";
import { ReadAloudButton } from "@/components/read-aloud-button";
import { CropFromOriginalImageButton } from "./crop-from-original-image-button";
import { EditButton, SaveCancelButtons, SectionHeader } from "./edit-controls";
import { QuestionMetadata } from "./question-metadata";
import { QuestionTags } from "./question-tags";
import { ToggleImage } from "./toggle-image";
import type { ErrorItemDetail, UpdateErrorItem } from "./types";
import { useEditableField } from "./use-editable-field";

interface QuestionCardProps {
    item: ErrorItemDetail;
    educationStage?: string;
    /** 保存字段到服务端并合并到页面状态，失败时抛出 */
    saveFields: (fields: Partial<ErrorItemDetail>) => Promise<void>;
    /** 只合并到页面状态（服务端已更新） */
    onUpdate: UpdateErrorItem;
    reload: () => Promise<void>;
    onEnlarge: (src: string) => void;
    /** 只读模式（如儿童专注做题锁）：隐藏编辑、标签修改、换图、重裁与重绘配图入口 */
    readOnly?: boolean;
}

/** 题目卡片：题干与配图、知识点标签、题目信息和原图 */
export function QuestionCard({ item, educationStage, saveFields, onUpdate, reload, onEnlarge, readOnly = false }: QuestionCardProps) {
    const { t } = useLanguage();
    const questionTextRef = useRef<HTMLTextAreaElement>(null);
    const [showImage, setShowImage] = useState(false);
    const question = useEditableField({
        read: () => item.questionText,
        save: (questionText) => saveFields({ questionText }),
        logLabel: 'question',
    });

    return (
        <Card>
            <CardHeader><SectionHeader title={<CardTitle>{t.detail.question}</CardTitle>} actions={!question.editing && <div className="flex flex-wrap items-center justify-end gap-1"><ReadAloudButton text={item.questionText} />{!readOnly && <EditButton onClick={question.start} />}</div>} /></CardHeader>
            <CardContent className="space-y-4">
                {question.editing && !readOnly ? (
                    <div className="space-y-3">
                        <MarkdownEditor value={question.value} onChange={question.setValue} textareaRef={questionTextRef} placeholder="Enter question text..." rows={8} className="w-full font-mono text-sm" />
                        <PinyinToolbar value={question.value} onChange={question.setValue} textareaRef={questionTextRef} subject={item.subject?.subjectKey || item.subject?.name} />
                        <SaveCancelButtons onSave={question.submit} onCancel={question.cancel} />
                    </div>
                ) : (
                    <>
                        <MarkdownRenderer content={item.questionText} />
                        {item.figureSvg && item.originalImageUrl ? (
                            <FigureCompare svg={item.figureSvg} originalSrc={item.originalImageUrl} onEnlarge={onEnlarge} />
                        ) : (
                            <QuestionFigure svg={item.figureSvg} />
                        )}
                    </>
                )}

                <QuestionTags item={item} educationStage={educationStage} onChanged={reload} readOnly={readOnly} />
                <QuestionMetadata item={item} onChanged={reload} readOnly={readOnly} />

                <div className="pt-3">
                    <ToggleImage
                        src={item.figureSvg && item.originalImageUrl ? null : item.originalImageUrl}
                        alt={t.detail.originalProblem || "Original Problem"}
                        showLabel={t.replaceImage?.view || "View original image"}
                        hideLabel={t.replaceImage?.hide || "Hide original image"}
                        variant="outline"
                        visible={showImage}
                        onVisibleChange={setShowImage}
                        onEnlarge={onEnlarge}
                        actions={readOnly ? undefined : <>
                            <ReplaceQuestionImageButton
                                errorItemId={item.id}
                                hasImage={!!item.originalImageUrl}
                                onDone={(originalImageUrl) => { onUpdate({ originalImageUrl }); setShowImage(true); }}
                            />
                            {item.originalImageUrl?.startsWith("data:image/") && (
                                <CropFromOriginalImageButton
                                    errorItemId={item.id}
                                    imageUrl={item.originalImageUrl}
                                    onDone={(originalImageUrl) => { onUpdate({ originalImageUrl }); setShowImage(true); }}
                                />
                            )}
                            {item.originalImageUrl && <RegenerateFigureButton errorItemId={item.id} onDone={onUpdate} />}
                        </>}
                    />
                </div>
            </CardContent>
        </Card>
    );
}
