"use client";

import { useEffect, useState } from "react";
import { Crop, Loader2 } from "lucide-react";
import { ImageCropper } from "@/components/image-cropper";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { confirmDialog, toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import { processImageFile } from "@/lib/image-utils";

const DATA_IMAGE_URL = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([\s\S]+)$/i;

/** 把已保存的原图 data URL 还原为 Blob，供裁剪框按原图分辨率解码；格式不符时返回 null */
export function blobFromDataUrl(dataUrl: string | null | undefined): Blob | null {
    const match = dataUrl?.match(DATA_IMAGE_URL);
    if (!match) return null;
    try {
        const binary = atob(match[2].replace(/\s+/g, ""));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        return new Blob([bytes], { type: match[1].toLowerCase() });
    } catch {
        return null;
    }
}

interface CropFromOriginalImageButtonProps {
    errorItemId: string;
    imageUrl: string;
    onDone: (originalImageUrl: string) => void;
}

/**
 * 从当前原题图片重新裁剪：可框选题目区域并擦除做题痕迹，与替换原图一样压缩后保存，覆盖原图。
 * Ported from margrop/wrong-notebook 35431618 (MIT).
 */
export function CropFromOriginalImageButton({ errorItemId, imageUrl, onDone }: CropFromOriginalImageButtonProps) {
    const { t } = useLanguage();
    const [busy, setBusy] = useState(false);
    // 待裁剪原图的 object URL，关闭裁剪框时释放
    const [croppingImage, setCroppingImage] = useState<string | null>(null);

    useEffect(() => () => {
        if (croppingImage) URL.revokeObjectURL(croppingImage);
    }, [croppingImage]);

    const handleClick = async () => {
        const blob = blobFromDataUrl(imageUrl);
        if (!blob) {
            toast.error(t.replaceImage.cropNoImage);
            return;
        }
        if (!(await confirmDialog(t.replaceImage.cropConfirm))) return;
        setCroppingImage(URL.createObjectURL(blob));
    };

    const handleCropComplete = async (croppedBlob: Blob) => {
        setCroppingImage(null);
        setBusy(true);
        try {
            const file = new File([croppedBlob], "question-image.jpg", { type: croppedBlob.type || "image/jpeg" });
            const imageDataUrl = await processImageFile(file);
            const result = await apiClient.put<{ originalImageUrl: string }>(`/api/error-items/${errorItemId}/image`, { imageDataUrl });
            onDone(result.originalImageUrl);
            toast.success(t.replaceImage.cropDone);
        } catch (error) {
            const code = (error as { data?: { message?: string } })?.data?.message || "";
            frontendLogger.error("[CropOriginal]", "Failed to crop original image", { code });
            toast.error(code === "INVALID_IMAGE" ? t.replaceImage.invalid : t.replaceImage.cropFailed);
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            {croppingImage && (
                <ImageCropper
                    imageSrc={croppingImage}
                    open
                    onClose={() => setCroppingImage(null)}
                    onCropComplete={handleCropComplete}
                />
            )}
            <Button variant="outline" size="sm" onClick={handleClick} disabled={busy} className="flex items-center gap-2" data-testid="crop-from-original">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Crop className="h-4 w-4" />}
                {busy ? t.replaceImage.uploading : t.replaceImage.crop}
            </Button>
        </>
    );
}
