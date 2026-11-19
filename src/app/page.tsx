"use client";

import { useState, Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Camera, PenLine, Sparkles } from "lucide-react";
import { BatchImportPanel } from "@/components/batch-import-panel";
import { CorrectionEditor } from "@/components/correction-editor";
import { DirectTextEditor } from "@/components/direct-text-editor";
import { HomeHero } from "@/components/home-hero";
import { ImageCropper } from "@/components/image-cropper";
import { ImportResultBanner } from "@/components/import-result-banner";
import { MultiQuestionConfirm } from "@/components/multi-question-confirm";
import { TextInputZone } from "@/components/text-input-zone";
import { UploadZone } from "@/components/upload-zone";
import { PageContainer } from "@/components/ui/page-container";
import { PageLoading } from "@/components/ui/page-loading";
import { ProgressFeedback } from "@/components/ui/progress-feedback";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SnapshotWarningBanner } from "@/components/snapshot-warning-banner";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { withChildParam } from "@/lib/current-child";
import { frontendLogger } from "@/lib/frontend-logger";
import { useCurrentChild } from "@/lib/use-current-child";
import { usePageTitle } from "@/lib/page-title";
import { useQuestionImport } from "@/lib/use-question-import";
import type { Notebook, PaginatedResponse } from "@/types/api";

/** 直接录入（不经 AI）提交的内容 */
interface DirectEntry {
    questionText: string;
    answerText: string;
    analysis: string;
    wrongAnswerText: string;
    mistakeAnalysis: string;
    mistakeStatus: string;
    knowledgePoints: string[];
    subjectId: string;
    gradeSemester?: string;
    paperLevel?: string;
}

function HomeContent() {
    const { t } = useLanguage();
    usePageTitle(t.pageTitle.home);
    const searchParams = useSearchParams();
    const { learnerId } = useCurrentChild();
    const initialNotebookId = searchParams.get("notebook");
    const [notebooks, setNotebooks] = useState<Notebook[]>([]);
    const [autoSelectedNotebookId, setAutoSelectedNotebookId] = useState<string | null>(null);
    const [dueCount, setDueCount] = useState<number | null>(null);
    const [inputMode, setInputMode] = useState<"image" | "text" | "direct">("image");

    const targetNotebookId = initialNotebookId || autoSelectedNotebookId;
    const targetNotebook = targetNotebookId ? notebooks.find((n) => n.id === targetNotebookId) : undefined;

    const flow = useQuestionImport({
        logPrefix: "[Home]",
        analyzeSubjectId: targetNotebookId,
        importSubjectId: initialNotebookId,
        learnerId,
        textNotebook: targetNotebook && { id: targetNotebook.id, name: targetNotebook.name },
        // 按识别出的学科自动选择名称相近的错题本
        onParsed: (data) => {
            const matched =
                data.subject &&
                notebooks.find((n) => n.name.includes(data.subject!) || data.subject!.includes(n.name));
            if (matched) setAutoSelectedNotebookId(matched.id);
        },
    });

    useEffect(() => {
        let cancelled = false;
        apiClient
            .get<Notebook[]>(withChildParam("/api/notebooks", learnerId))
            .then((data) => {
                if (!cancelled) setNotebooks(data);
            })
            .catch((err) => frontendLogger.error("[Home]", "Failed to fetch notebooks", { error: err }));

        apiClient
            .get<PaginatedResponse<unknown>>(withChildParam("/api/review/due?pageSize=1", learnerId))
            .then((data) => {
                if (!cancelled) setDueCount(data.total);
            })
            .catch((err) => frontendLogger.error("[Home]", "Failed to fetch due reviews", { error: err }));

        return () => {
            cancelled = true;
        };
    }, [learnerId]);

    const handleDirectSave = async (data: DirectEntry): Promise<void> => {
        flow.setAnalysisStep("saving");
        await flow.saveQuestion({
            ...data,
            wrongAnswerText: data.wrongAnswerText || null,
            mistakeAnalysis: data.mistakeAnalysis || null,
            mistakeStatus: data.mistakeStatus || "unknown",
            originalImageUrl: "",
        });
        flow.setAnalysisStep("idle");
    };

    const totalItems = notebooks.reduce((sum, n) => sum + (n._count?.errorItems || 0), 0);
    const inputModes = [
        { value: "image" as const, icon: Camera, label: t.app?.uploadImage || "Take Photo" },
        { value: "text" as const, icon: Sparkles, label: t.app?.manualInput || "Manual Input" },
        { value: "direct" as const, icon: PenLine, label: t.app?.directInput || "Manual Entry" },
    ];

    return (
        <PageContainer maxWidth={flow.step === "review" || flow.step === "confirm" ? "6xl" : "4xl"} className="space-y-6">
            <SnapshotWarningBanner />
            <ProgressFeedback status={flow.analysisStep} />

            {flow.step === "upload" && (
                <>
                    <HomeHero
                        notebookCount={notebooks.length}
                        itemCount={totalItems}
                        dueCount={dueCount}
                        targetNotebook={initialNotebookId ? targetNotebook?.name : undefined}
                    />

                    <div className="space-y-4">
                        <SegmentedControl
                            options={inputModes}
                            value={inputMode}
                            onChange={setInputMode}
                            ariaLabel={t.notebook.inputModeLabel}
                        />

                        {flow.lastImported && (
                            <ImportResultBanner imported={flow.lastImported} onDismiss={flow.dismissImported} />
                        )}

                        {flow.batchBlobs ? (
                            <BatchImportPanel
                                blobs={flow.batchBlobs}
                                subjectId={initialNotebookId}
                                timeout={flow.aiTimeout}
                                onClose={flow.closeBatch}
                            />
                        ) : inputMode === "image" ? (
                            <UploadZone onImageSelect={flow.selectImage} onImagesSelect={flow.selectImages} isAnalyzing={flow.isBusy} />
                        ) : inputMode === "text" ? (
                            <TextInputZone
                                onSubmit={flow.submitText}
                                isAnalyzing={flow.isBusy}
                                defaultNotebookName={targetNotebook?.name}
                            />
                        ) : (
                            <DirectTextEditor
                                onSubmit={handleDirectSave}
                                defaultNotebookId={targetNotebookId || undefined}
                                defaultNotebookName={targetNotebook?.name}
                                isSaving={flow.analysisStep === "saving"}
                            />
                        )}
                    </div>
                </>
            )}

            {flow.croppingImage && (
                <ImageCropper
                    imageSrc={flow.croppingImage}
                    open={flow.isCropperOpen}
                    onClose={flow.closeCropper}
                    onCropComplete={flow.cropComplete}
                    onMultiCropComplete={flow.multiCropComplete}
                    titleSuffix={flow.cropQueueLabel}
                />
            )}

            {flow.step === "confirm" && flow.pendingItems && (
                <MultiQuestionConfirm
                    items={flow.pendingItems.items}
                    saving={flow.savingItems}
                    onCancel={flow.cancelPending}
                    onSave={flow.savePendingItems}
                />
            )}

            {flow.step === "review" && flow.parsedData && (
                <CorrectionEditor
                    initialData={flow.parsedData}
                    onSave={flow.saveReviewed}
                    onCancel={flow.cancelReview}
                    imagePreview={flow.currentImage}
                    initialSubjectId={targetNotebookId || undefined}
                    aiTimeout={flow.aiTimeout}
                />
            )}
        </PageContainer>
    );
}

export default function Home() {
    return (
        <Suspense fallback={<PageLoading />}>
            <HomeContent />
        </Suspense>
    );
}
