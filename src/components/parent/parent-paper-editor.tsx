"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Camera, Crop, Images, RotateCw, Trash2 } from "lucide-react";
import { ImageCropper } from "@/components/image-cropper";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { HEIC_UNSUPPORTED } from "@/lib/heic";
import { moveItem, withChildParam } from "@/lib/current-child";
import { getApiErrorMessage, getErrorMessage } from "@/lib/error-message";
import { toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import { MAX_PARENT_PAPER_PAGES } from "@/lib/parent-papers";
import { blobToDataUrl, rotateDataUrl } from "@/lib/paper-page-edit";
import { compressPaperImages } from "@/lib/use-paper-images";

const ACCEPT = "image/*,.heic,.heif,image/heic,image/heif";

interface DraftPage {
    id: string;
    image: string;
}

interface ParentPaperEditorProps {
    learnerId: string;
    childName?: string;
}

function isHeicUnsupported(error: unknown): boolean {
    return getErrorMessage(error) === HEIC_UNSUPPORTED || (error instanceof Error && error.name === HEIC_UNSUPPORTED);
}

export function ParentPaperEditor({ learnerId, childName }: ParentPaperEditorProps) {
    const { t, language } = useLanguage();
    const copy = t.parentPapers;
    const router = useRouter();
    const cameraRef = useRef<HTMLInputElement>(null);
    const pickRef = useRef<HTMLInputElement>(null);
    const answerKeyRef = useRef<HTMLInputElement>(null);
    const counter = useRef(0);
    const dragIndex = useRef<number | null>(null);
    const [pages, setPages] = useState<DraftPage[]>([]);
    const [answerKeys, setAnswerKeys] = useState<DraftPage[]>([]);
    const [title, setTitle] = useState(childName || "");
    const [cropIndex, setCropIndex] = useState<number | null>(null);
    const [saving, setSaving] = useState(false);
    const [adding, setAdding] = useState(false);

    const addFiles = async (files: FileList | null, input: HTMLInputElement | null) => {
        if (!files?.length) return;
        const remaining = MAX_PARENT_PAPER_PAGES - pages.length;
        if (remaining <= 0) {
            toast.error(copy.maxPages.replace("{count}", String(MAX_PARENT_PAPER_PAGES)));
            if (input) input.value = "";
            return;
        }
        const selected = [...files].slice(0, remaining);
        setAdding(true);
        try {
            const images = await compressPaperImages(selected);
            setPages((prev) => [
                ...prev,
                ...images.map((image) => ({ id: `p${++counter.current}`, image })),
            ]);
        } catch (error) {
            frontendLogger.error("[ParentPaper]", "Failed to add pages", { error });
            toast.error(isHeicUnsupported(error) ? copy.heicUnsupported : (copy.compressError || getErrorMessage(error)));
        } finally {
            setAdding(false);
            if (input) input.value = "";
        }
        if (files.length > remaining) {
            toast.error(copy.maxPages.replace("{count}", String(MAX_PARENT_PAPER_PAGES)));
        }
    };

    const addAnswerKeyFiles = async (files: FileList | null, input: HTMLInputElement | null) => {
        if (!files?.length) return;
        const remaining = MAX_PARENT_PAPER_PAGES - answerKeys.length;
        if (remaining <= 0) {
            toast.error(copy.maxPages.replace("{count}", String(MAX_PARENT_PAPER_PAGES)));
            if (input) input.value = "";
            return;
        }
        const selected = [...files].slice(0, remaining);
        setAdding(true);
        try {
            const images = await compressPaperImages(selected);
            setAnswerKeys((prev) => [
                ...prev,
                ...images.map((image) => ({ id: `k${++counter.current}`, image })),
            ]);
        } catch (error) {
            frontendLogger.error("[ParentPaper]", "Failed to add answer key", { error });
            toast.error(isHeicUnsupported(error) ? copy.heicUnsupported : (copy.compressError || getErrorMessage(error)));
        } finally {
            setAdding(false);
            if (input) input.value = "";
        }
    };

    const move = (from: number, to: number) => {
        setPages((prev) => moveItem(prev, from, to));
    };

    const rotate = async (index: number) => {
        try {
            const next = await rotateDataUrl(pages[index].image, 90);
            setPages((prev) => prev.map((page, i) => (i === index ? { ...page, image: next } : page)));
        } catch (error) {
            toast.error(copy.compressError || getErrorMessage(error));
        }
    };

    const finishCrop = async (blob: Blob) => {
        if (cropIndex == null) return;
        const image = await blobToDataUrl(blob);
        setPages((prev) => prev.map((page, i) => (i === cropIndex ? { ...page, image } : page)));
        setCropIndex(null);
    };

    const save = async () => {
        if (!pages.length) {
            toast.error(copy.addPages);
            return;
        }
        setSaving(true);
        try {
            const paper = await apiClient.post<{ id: string }>("/api/parent/papers", {
                learnerId,
                title: title.trim() || childName || undefined,
                pages: pages.map((page) => ({ imageUrl: page.image })),
                answerKeyImages: answerKeys.map((page) => page.image),
            });
            try {
                await apiClient.post(`/api/parent/papers/${paper.id}/recognize`, { language });
            } catch (recognizeError) {
                frontendLogger.error("[ParentPaper]", "Failed to start recognition", { error: recognizeError });
                toast.error(getApiErrorMessage(recognizeError) || copy.recognizeError);
            }
            toast.success(copy.saved);
            router.push(withChildParam(`/parent/papers/${paper.id}`, learnerId));
        } catch (error) {
            frontendLogger.error("[ParentPaper]", "Failed to save paper", { error });
            toast.error(getApiErrorMessage(error) || copy.saveError);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-5">
            <input
                ref={cameraRef}
                type="file"
                accept={ACCEPT}
                capture="environment"
                className="hidden"
                onChange={(event) => void addFiles(event.target.files, cameraRef.current)}
            />
            <input
                ref={pickRef}
                type="file"
                accept={ACCEPT}
                multiple
                className="hidden"
                onChange={(event) => void addFiles(event.target.files, pickRef.current)}
            />
            <input
                ref={answerKeyRef}
                type="file"
                accept={ACCEPT}
                multiple
                className="hidden"
                onChange={(event) => void addAnswerKeyFiles(event.target.files, answerKeyRef.current)}
            />

            <label className="block space-y-1.5">
                <span className="text-sm font-medium">{copy.titleLabel}</span>
                <input
                    type="text"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={120}
                    placeholder={copy.titlePlaceholder}
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-base"
                />
            </label>

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <Button type="button" size="lg" className="w-full justify-center sm:w-auto" onClick={() => cameraRef.current?.click()} disabled={adding || saving}>
                    <Camera className="h-5 w-5" aria-hidden="true" />
                    {pages.length ? copy.takeAnother : copy.takePhoto}
                </Button>
                <Button type="button" size="lg" variant="outline" className="w-full justify-center sm:w-auto" onClick={() => pickRef.current?.click()} disabled={adding || saving}>
                    <Images className="h-5 w-5" aria-hidden="true" />
                    {copy.pickPhotos}
                </Button>
            </div>
            <p className="text-sm text-muted-foreground">{copy.continueHint}</p>

            {pages.length > 0 && (
                <ol className="space-y-3">
                    {pages.map((page, index) => (
                        <li
                            key={page.id}
                            className="flex gap-3 rounded-2xl border border-border bg-card p-3"
                            draggable
                            onDragStart={() => { dragIndex.current = index; }}
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={() => {
                                if (dragIndex.current == null) return;
                                move(dragIndex.current, index);
                                dragIndex.current = null;
                            }}
                        >
                            <img src={page.image} alt="" className="h-28 w-20 shrink-0 rounded-lg border object-cover" />
                            <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
                                <div className="text-sm font-medium">{copy.pageN.replace("{index}", String(index + 1))}</div>
                                <div className="flex flex-wrap gap-1">
                                    <Button type="button" variant="outline" size="icon-sm" aria-label={copy.moveUp} disabled={index === 0} onClick={() => move(index, index - 1)}>
                                        <ArrowUp className="h-4 w-4" />
                                    </Button>
                                    <Button type="button" variant="outline" size="icon-sm" aria-label={copy.moveDown} disabled={index === pages.length - 1} onClick={() => move(index, index + 1)}>
                                        <ArrowDown className="h-4 w-4" />
                                    </Button>
                                    <Button type="button" variant="outline" size="icon-sm" aria-label={copy.rotate} onClick={() => void rotate(index)}>
                                        <RotateCw className="h-4 w-4" />
                                    </Button>
                                    <Button type="button" variant="outline" size="icon-sm" aria-label={copy.crop} onClick={() => setCropIndex(index)}>
                                        <Crop className="h-4 w-4" />
                                    </Button>
                                    <Button type="button" variant="ghost" size="icon-sm" className="text-destructive" aria-label={copy.remove} onClick={() => setPages((prev) => prev.filter((item) => item.id !== page.id))}>
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            </div>
                        </li>
                    ))}
                </ol>
            )}

            <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
                <div className="space-y-1">
                    <h2 className="text-sm font-medium">{copy.answerKey}</h2>
                    <p className="text-sm text-muted-foreground">{copy.answerKeyHint}</p>
                </div>
                <Button type="button" variant="outline" className="w-full justify-center sm:w-auto" onClick={() => answerKeyRef.current?.click()} disabled={adding || saving}>
                    {copy.addAnswerKey}
                </Button>
                {answerKeys.length > 0 && (
                    <ul className="flex flex-wrap gap-2">
                        {answerKeys.map((page) => (
                            <li key={page.id} className="relative">
                                <img src={page.image} alt="" className="h-20 w-14 rounded-lg border object-cover" />
                                <button
                                    type="button"
                                    className="absolute -right-1 -top-1 rounded-full border border-border bg-background p-1 text-destructive"
                                    aria-label={copy.removeAnswerKey}
                                    onClick={() => setAnswerKeys((prev) => prev.filter((item) => item.id !== page.id))}
                                >
                                    <Trash2 className="h-3 w-3" />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <Button type="button" size="lg" className="w-full sm:w-auto" onClick={() => void save()} loading={saving} disabled={!pages.length || adding} loadingText={copy.saving}>
                {copy.startRecognition}
            </Button>

            {cropIndex != null && (
                <ImageCropper
                    imageSrc={pages[cropIndex].image}
                    open
                    onClose={() => setCropIndex(null)}
                    onCropComplete={(blob) => void finishCrop(blob)}
                />
            )}
        </div>
    );
}
