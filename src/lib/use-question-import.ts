"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProgressStatus } from "@/components/ui/progress-feedback";
import { useLanguage } from "@/contexts/LanguageContext";
import type { ParsedQuestion } from "@/lib/ai";
import { getAnalysisErrorMessage } from "@/lib/analysis-error";
import { apiClient } from "@/lib/api-client";
import { getApiErrorMessage, getErrorMessage } from "@/lib/error-message";
import { toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import { processImageFile } from "@/lib/image-utils";
import { normalizeMistakeStatus } from "@/lib/mistake-status";
import { fetchConfirmBeforeImport, saveParsedQuestion } from "@/lib/question-import";
import type { ImportedQuestion } from "@/lib/question-import";
import type { AnalyzeResponse, AppConfig } from "@/types/api";
import { reportLearningProgress } from "@/lib/onboarding-client";

/** 未配置时 AI 识别的超时（毫秒） */
const DEFAULT_AI_TIMEOUT = 180000;

export type ReviewedQuestion = ParsedQuestion & { subjectId?: string; paperLevel?: string };

interface ReanswerResponse {
    gradeSemester?: string | null;
    answerText: string;
    analysis: string;
    knowledgePoints: string[];
    wrongAnswerText: string;
    mistakeAnalysis: string;
    mistakeStatus: string;
    difficultyStars?: number | null;
    subject?: string;
}

interface QuestionImportOptions {
    /** 日志前缀，如 [Home] */
    logPrefix: string;
    /** 识别时参考的错题本（决定候选知识点） */
    analyzeSubjectId?: string | null;
    /** 免确认直接入库时放入的错题本 */
    importSubjectId?: string | null;
    /** 文字解题时参考的错题本 */
    textNotebook?: { id: string; name: string };
    /** 校对后保存时固定放入的错题本，不传则使用校对页中选择的错题本 */
    fixedSubjectId?: string;
    /** 家长身份下把题目挂到当前孩子 */
    learnerId?: string | null;
    /** 图片识别完成、进入校对页之前调用（如按学科自动选择错题本） */
    onParsed?: (data: ParsedQuestion) => void;
}

/** 仅在用户主动发起耗时 AI 识别时请求桌面通知权限 */
function requestNotificationPermissionOnAction() {
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
        try {
            const pending = Notification.requestPermission?.();
            void Promise.resolve(pending).catch(() => undefined);
        } catch {
            // 忽略不支持或拒绝环境
        }
    }
}

/**
 * 题目导入流程：裁剪图片 → 压缩 → AI 识别（或文字解题）→ 免确认直接入库，或进入校对页后保存。
 * 首页与错题本的添加错题页共用。
 */
export function useQuestionImport({ logPrefix, analyzeSubjectId, importSubjectId, textNotebook, fixedSubjectId, learnerId, onParsed }: QuestionImportOptions) {
    const { t, language } = useLanguage();
    const router = useRouter();
    const [step, setStep] = useState<"upload" | "review" | "confirm">("upload");
    const [analysisStep, setAnalysisStep] = useState<ProgressStatus>('idle');
    const [parsedData, setParsedData] = useState<ParsedQuestion | null>(null);
    const [currentImage, setCurrentImage] = useState<string | null>(null);
    const [config, setConfig] = useState<AppConfig | null>(null);
    const [croppingImage, setCroppingImage] = useState<string | null>(null);
    const [isCropperOpen, setIsCropperOpen] = useState(false);
    // 免确认导入：偏好、最近一次导入结果、批量框选的题目图片
    const [confirmBeforeImport, setConfirmBeforeImport] = useState(false);
    const [lastImported, setLastImported] = useState<ImportedQuestion | null>(null);
    const [batchBlobs, setBatchBlobs] = useState<Blob[] | null>(null);
    // 一次选择多张图片时逐张排队裁剪，裁完后一起识别（Ported from margrop/wrong-notebook 4435a761, MIT）
    const [imageQueue, setImageQueue] = useState<{ files: File[]; index: number; blobs: Blob[] } | null>(null);
    const [pendingItems, setPendingItems] = useState<{ items: ParsedQuestion[]; imageUrl: string | null; provenanceId?: string | null } | null>(null);
    const [savingItems, setSavingItems] = useState(false);

    const aiTimeout = config?.timeouts?.analyze || DEFAULT_AI_TIMEOUT;
    const safetyTimeout = aiTimeout + 10000;

    // Cleanup Blob URL to prevent memory leak
    useEffect(() => {
        return () => {
            if (croppingImage) URL.revokeObjectURL(croppingImage);
        };
    }, [croppingImage]);

    useEffect(() => {
        fetchConfirmBeforeImport().then(setConfirmBeforeImport);
        apiClient.get<AppConfig>("/api/settings")
            .then(setConfig)
            .catch(err => frontendLogger.error(logPrefix, 'Failed to fetch config', { error: err }));
    }, [logPrefix]);

    // 保留按阶段计时的超时兜底，进度估值和已用时间由提示组件统一维护。
    useEffect(() => {
        if (analysisStep === 'idle') return;
        const timeout = setTimeout(() => {
            frontendLogger.warn('[Progress]', '处理超时，关闭进度提示', { analysisStep, safetyTimeout });
            setAnalysisStep('idle');
        }, safetyTimeout);
        return () => clearTimeout(timeout);
    }, [analysisStep, safetyTimeout]);

    const selectImage = (file: File) => {
        setLastImported(null);
        setCroppingImage(URL.createObjectURL(file));
        setIsCropperOpen(true);
    };

    const startBatch = (blobs: Blob[]) => {
        setIsCropperOpen(false);
        setCroppingImage(null);
        setLastImported(null);
        setBatchBlobs(blobs);
    };

    /** 多张图片：逐张打开裁剪框；只选了一张时与单张流程一致 */
    const selectImages = (files: File[]) => {
        if (files.length === 0) return;
        if (files.length === 1) {
            setImageQueue(null);
            selectImage(files[0]);
            return;
        }
        setLastImported(null);
        setImageQueue({ files, index: 0, blobs: [] });
        setCroppingImage(URL.createObjectURL(files[0]));
        setIsCropperOpen(true);
    };

    /** 当前图片处理完（裁剪得到的图片，取消时为空），打开下一张；全部完成后一起识别 */
    const advanceQueue = (queue: { files: File[]; index: number; blobs: Blob[] }, added: Blob[]) => {
        const blobs = [...queue.blobs, ...added];
        const next = queue.index + 1;
        if (next < queue.files.length) {
            setImageQueue({ files: queue.files, index: next, blobs });
            setCroppingImage(URL.createObjectURL(queue.files[next]));
            setIsCropperOpen(true);
            return;
        }
        setImageQueue(null);
        setIsCropperOpen(false);
        setCroppingImage(null);
        if (blobs.length > 1) {
            startBatch(blobs);
        } else if (blobs.length === 1) {
            analyzeImage(new File([blobs[0]], "cropped-image.jpg", { type: "image/jpeg" }));
        }
    };

    const itemsFromAnalyze = (data: ParsedQuestion | AnalyzeResponse): ParsedQuestion[] => {
        if ('items' in data && Array.isArray(data.items) && data.items.length > 0) {
            return data.items;
        }
        return [data];
    };

    /** 多题始终进入确认页；单题仍遵循「导入前人工确认」偏好 */
    const handleParsed = async (data: ParsedQuestion | AnalyzeResponse, imageUrl: string | null) => {
        if ('failedCount' in data && typeof data.failedCount === 'number' && data.failedCount > 0) {
            toast.warning(
                (t.importFlow?.partialParseFailed || '{count} question(s) could not be parsed completely and were skipped.').replace('{count}', String(data.failedCount))
            );
        }
        const provenanceId = 'provenanceId' in data && data.provenanceId ? data.provenanceId : undefined;
        const items = itemsFromAnalyze(data);
        if (items.length > 1) {
            setCurrentImage(imageUrl);
            setPendingItems({ items, imageUrl, provenanceId });
            setStep("confirm");
            return;
        }
        if (!confirmBeforeImport) {
            setAnalysisStep('saving');
            const imported = await saveParsedQuestion(
                items[0],
                provenanceId
                    ? { subjectId: importSubjectId, imageUrl, learnerId, provenanceId }
                    : { subjectId: importSubjectId, imageUrl, learnerId },
            );
            setLastImported(imported);
            setCurrentImage(null);
            frontendLogger.info(logPrefix, 'Imported without review', { id: imported.id });
            return;
        }
        setCurrentImage(imageUrl);
        setParsedData(provenanceId ? ({ ...items[0], provenanceId } as ParsedQuestion) : items[0]);
        setStep("review");
    };

    const cancelPending = () => {
        setPendingItems(null);
        setCurrentImage(null);
        setStep("upload");
    };

    const savePendingItems = async (selected: ParsedQuestion[]) => {
        if (!pendingItems || selected.length === 0) {
            toast.error(t.importFlow.emptySelection);
            return;
        }
        setSavingItems(true);
        setAnalysisStep('saving');
        try {
            const imported: ImportedQuestion[] = [];
            for (const item of selected) {
                imported.push(await saveParsedQuestion(
                    item,
                    pendingItems.provenanceId
                        ? { subjectId: importSubjectId, imageUrl: pendingItems.imageUrl, learnerId, provenanceId: pendingItems.provenanceId }
                        : { subjectId: importSubjectId, imageUrl: pendingItems.imageUrl, learnerId },
                ));
            }
            toast.success(t.importFlow.savedCount.replace("{count}", String(imported.length)));
            setLastImported(imported[imported.length - 1]);
            frontendLogger.info(logPrefix, 'Imported multiple questions', { count: imported.length, ids: imported.map((item) => item.id) });
            cancelPending();
        } catch (error) {
            frontendLogger.error(logPrefix, 'Failed to save selected questions', { error: getApiErrorMessage(error) ?? getErrorMessage(error) });
            toast.error(t.common?.messages?.saveFailed || 'Failed to save');
        } finally {
            setSavingItems(false);
            setAnalysisStep('idle');
        }
    };

    const analyzeImage = async (file: File) => {
        const startTime = Date.now();
        requestNotificationPermissionOnAction();
        frontendLogger.info(logPrefix, 'Starting analysis flow', { apiTimeout: aiTimeout, safetyTimeout });
        try {
            setAnalysisStep('compressing');
            const base64Image = await processImageFile(file);

            setAnalysisStep('analyzing');
            const data = await apiClient.post<AnalyzeResponse>("/api/analyze", {
                imageBase64: base64Image,
                language,
                subjectId: analyzeSubjectId || undefined,
            }, { timeout: aiTimeout, recoverable: true });
            if (!data || typeof data !== 'object') {
                throw new Error('Invalid API response: data is null or not an object');
            }

            setAnalysisStep('processing');
            if (confirmBeforeImport) onParsed?.(data);
            await handleParsed(data, base64Image);
            frontendLogger.info(logPrefix, 'Analysis completed', { totalDuration: Date.now() - startTime });
        } catch (error) {
            frontendLogger.error(logPrefix, 'Analysis failed', { errorDuration: Date.now() - startTime, error: getErrorMessage(error) });
            toast.error(getAnalysisErrorMessage(error, t));
        } finally {
            setAnalysisStep('idle');
        }
    };

    const cropComplete = (croppedBlob: Blob) => {
        if (imageQueue) {
            advanceQueue(imageQueue, [croppedBlob]);
            return;
        }
        setIsCropperOpen(false);
        setCroppingImage(null);
        analyzeImage(new File([croppedBlob], "cropped-image.jpg", { type: "image/jpeg" }));
    };

    /** 多题框选：排队中时把框出的各题并入队列，否则直接批量识别 */
    const multiCropComplete = (blobs: Blob[]) => {
        if (imageQueue) {
            advanceQueue(imageQueue, blobs);
            return;
        }
        startBatch(blobs);
    };

    /** 关闭裁剪框：排队中时跳过当前图片，继续下一张 */
    const closeCropper = () => {
        if (imageQueue) {
            advanceQueue(imageQueue, []);
            return;
        }
        setIsCropperOpen(false);
        setCroppingImage(null);
    };

    /** 取消整个多图排队裁剪流程，放弃已暂存的裁剪结果 */
    const cancelQueue = () => {
        setImageQueue(null);
        setIsCropperOpen(false);
        setCroppingImage(null);
    };

    const cropQueueLabel = imageQueue
        ? t.upload.multiCropProgress.replace("{n}", String(imageQueue.index + 1)).replace("{total}", String(imageQueue.files.length))
        : undefined;

    /** 文字题目由 AI 解答后导入 */
    const submitText = async (questionText: string) => {
        const startTime = Date.now();
        requestNotificationPermissionOnAction();
        frontendLogger.info(logPrefix, 'Starting text-based analysis', { textLength: questionText.length });
        try {
            setAnalysisStep('analyzing');
            const result = await apiClient.post<ReanswerResponse>("/api/reanswer", {
                questionText,
                language,
                forImport: true,
                subject: textNotebook?.name,
                subjectId: textNotebook?.id,
            }, { timeout: aiTimeout, recoverable: true });

            setAnalysisStep('processing');
            await handleParsed({
                questionText,
                answerText: result.answerText,
                analysis: result.analysis,
                knowledgePoints: result.knowledgePoints || [],
                wrongAnswerText: result.wrongAnswerText || "",
                mistakeAnalysis: result.mistakeAnalysis || "",
                mistakeStatus: normalizeMistakeStatus(result.mistakeStatus),
                subject: (result.subject || "其他") as ParsedQuestion["subject"],
                requiresImage: false,
                difficultyStars: result.difficultyStars ?? null,
                gradeSemester: result.gradeSemester ?? null,
            }, null);
            frontendLogger.info(logPrefix, 'Text analysis completed', { totalDuration: Date.now() - startTime });
        } catch (error) {
            frontendLogger.error(logPrefix, 'Text analysis failed', { errorDuration: Date.now() - startTime, error: getErrorMessage(error) });
            toast.error(getAnalysisErrorMessage(error, t));
        } finally {
            setAnalysisStep('idle');
        }
    };

    /** 保存题目；重复题跳到原题，否则跳到所在错题本 */
    const saveQuestion = async (payload: Record<string, unknown> & { subjectId?: string | null }) => {
        try {
            const result = await apiClient.post<{ id: string; duplicate?: boolean }>("/api/error-items", payload);
            toast.success(result.duplicate ? t.importFlow.duplicate : t.common.messages.saveSuccess);
            if (!result.duplicate) reportLearningProgress("item", learnerId);
            if (result.duplicate) {
                router.push(`/error-items/${result.id}`);
            } else if (payload.subjectId) {
                router.push(learnerId ? `/notebooks/${payload.subjectId}?learnerId=${encodeURIComponent(learnerId)}` : `/notebooks/${payload.subjectId}`);
            }
            return true;
        } catch (error) {
            frontendLogger.error(logPrefix, 'Save failed', { errorMessage: getApiErrorMessage(error) ?? getErrorMessage(error) });
            toast.error(t.common?.messages?.saveFailed || 'Failed to save');
            return false;
        }
    };

    /** 校对页保存 */
    const saveReviewed = async (finalData: ReviewedQuestion) => {
        const parsedProvenanceId = parsedData && 'provenanceId' in parsedData
            ? (parsedData as ParsedQuestion & { provenanceId?: string | null }).provenanceId
            : undefined;
        const saved = await saveQuestion({
            ...finalData,
            originalImageUrl: currentImage || "",
            ...(fixedSubjectId ? { subjectId: fixedSubjectId } : {}),
            ...(learnerId ? { learnerId } : {}),
            ...(parsedProvenanceId ? { provenanceId: parsedProvenanceId } : {}),
        });
        if (saved) {
            setStep("upload");
            setParsedData(null);
            setCurrentImage(null);
        }
    };

    return {
        step, cancelReview: () => { setStep("upload"); setPendingItems(null); },
        analysisStep, setAnalysisStep, isBusy: analysisStep !== 'idle',
        parsedData, currentImage, aiTimeout,
        croppingImage, isCropperOpen, closeCropper, cancelQueue, cropQueueLabel,
        lastImported, dismissImported: () => setLastImported(null),
        batchBlobs, closeBatch: () => setBatchBlobs(null),
        selectImage, selectImages, cropComplete, multiCropComplete, startBatch, submitText, saveQuestion, saveReviewed,
        pendingItems, savingItems, savePendingItems, cancelPending,
    };
}
