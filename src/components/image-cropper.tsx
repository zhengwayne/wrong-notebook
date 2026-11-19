"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import type { CSSProperties } from "react";
import { Eraser, Trash2, Undo2 } from "lucide-react";
import ReactCrop from "react-image-crop";
import type { Crop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RegionSelector } from "@/components/region-selector";
import { ZoomControls } from "@/components/zoom-controls";
import { useLanguage } from "@/contexts/LanguageContext";
import { applyEraseStrokes, cropImageRegions, toSafeImageSrc } from "@/lib/image-crop";
import type { EraseStroke, ImageRegion } from "@/lib/image-crop";
import { frontendLogger } from "@/lib/frontend-logger";
import { useImageZoom } from "@/lib/use-image-zoom";

// 未缩放时图片适应弹窗的尺寸
const FIT_STYLE: Record<"single" | "multi", CSSProperties> = {
    single: { maxHeight: "70vh", maxWidth: "100%", objectFit: "contain" },
    multi: { maxHeight: "65vh", maxWidth: "100%", objectFit: "contain" },
};

// 擦除画笔按屏幕像素定义，涂抹时换算为相对图片宽度的半径，缩放后仍保持手感一致
const BRUSH_SIZES = [
    { key: "thin", pixels: 3 },
    { key: "medium", pixels: 7 },
    { key: "thick", pixels: 14 },
] as const;
type BrushSize = (typeof BRUSH_SIZES)[number]["key"];

interface ImageCropperProps {
    imageSrc: string;
    open: boolean;
    onClose: () => void;
    onCropComplete: (croppedImageBlob: Blob) => void;
    /** 提供时显示「多题框选」模式，返回每个框裁剪出的图片 */
    onMultiCropComplete?: (croppedImageBlobs: Blob[]) => void;
    /** 提供「擦除做题痕迹」画笔（单题模式），裁剪结果一并擦除；默认提供 */
    eraseEnabled?: boolean;
    /** 标题后缀，如多张图片排队裁剪时的「第 1/3 张」 */
    titleSuffix?: string;
    /** 多图排队裁剪时提供，允许一次放弃整个队列（onClose 则跳过当前张） */
    onCancelQueue?: () => void;
}

export function ImageCropper({ imageSrc, open, onClose, onCropComplete, onMultiCropComplete, eraseEnabled = true, titleSuffix, onCancelQueue }: ImageCropperProps) {
    const { t } = useLanguage();
    const safeImageSrc = toSafeImageSrc(imageSrc);
    // 始终保存百分比坐标，缩放改变图片显示尺寸后仍然准确
    const [crop, setCrop] = useState<Crop>();
    const imgRef = useRef<HTMLImageElement>(null);
    const [mode, setModeState] = useState<"single" | "multi">("single");
    const { containerRef, zoom, imageStyle, measureImage, zoomIn, zoomOut, reset: resetZoom } = useImageZoom(FIT_STYLE[mode]);
    // 换图后回到 100%
    useEffect(() => {
        resetZoom();
    }, [imageSrc, resetZoom]);
    const setMode = (next: "single" | "multi") => {
        resetZoom();
        setModeState(next);
        if (next === "multi") {
            setErasing(false);
            setStrokes([]);
        }
    };
    // 框选结果与图片绑定，换图后自动清空
    const [regionState, setRegionState] = useState<{ src: string; regions: ImageRegion[] }>({ src: imageSrc, regions: [] });
    const regions = regionState.src === imageSrc ? regionState.regions : [];
    const setRegions = (next: ImageRegion[]) => setRegionState({ src: imageSrc, regions: next });
    const multiImgRef = useRef<HTMLImageElement>(null);

    // 擦除笔画与图片绑定，换图后清空；坐标相对整张图片（Ported from margrop/wrong-notebook 35431618, MIT）
    const [eraseState, setEraseState] = useState<{ src: string; strokes: EraseStroke[] }>({ src: imageSrc, strokes: [] });
    const strokes = useMemo(() => (eraseState.src === imageSrc ? eraseState.strokes : []), [eraseState, imageSrc]);
    const setStrokes = (next: EraseStroke[] | ((current: EraseStroke[]) => EraseStroke[])) =>
        setEraseState((current) => ({ src: imageSrc, strokes: typeof next === "function" ? next(current.src === imageSrc ? current.strokes : []) : next }));
    const [erasingState, setErasingState] = useState<{ src: string; on: boolean }>({ src: imageSrc, on: false });
    const erasing = erasingState.src === imageSrc && erasingState.on;
    const setErasing = (on: boolean) => setErasingState({ src: imageSrc, on });
    const [brushSize, setBrushSize] = useState<BrushSize>("medium");
    const [imageReady, setImageReady] = useState(0);
    const eraseCanvasRef = useRef<HTMLCanvasElement>(null);
    const strokeIndexRef = useRef<number | null>(null);

    // 预览画布按显示尺寸重绘擦除笔画；缩放或换图后坐标仍按图片宽高归一化
    useEffect(() => {
        if (!eraseEnabled || mode === "multi") return;
        const canvas = eraseCanvasRef.current;
        const image = imgRef.current;
        if (!canvas || !image || image.clientWidth === 0) return;
        canvas.width = image.clientWidth;
        canvas.height = image.clientHeight;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.clearRect(0, 0, canvas.width, canvas.height);
        applyEraseStrokes(context, strokes, { width: canvas.width, height: canvas.height },
            { sx: 0, sy: 0, sw: canvas.width, sh: canvas.height }, { width: canvas.width, height: canvas.height });
    }, [eraseEnabled, mode, strokes, imageReady, zoom, imageSrc]);

    const brushPixels = BRUSH_SIZES.find((size) => size.key === brushSize)?.pixels ?? 7;

    const erasePoint = (event: React.PointerEvent) => {
        const rect = eraseCanvasRef.current!.getBoundingClientRect();
        return {
            x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
            y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
        };
    };

    const handleEraseDown = (event: React.PointerEvent) => {
        if (!erasing || event.button !== 0) return;
        event.preventDefault();
        eraseCanvasRef.current?.setPointerCapture?.(event.pointerId);
        const canvas = eraseCanvasRef.current;
        strokeIndexRef.current = strokes.length;
        const width = canvas?.clientWidth || canvas?.getBoundingClientRect().width || 0;
        setStrokes([...strokes, { points: [erasePoint(event)], radius: width > 0 ? brushPixels / width : 0.006 }]);
    };

    const handleEraseMove = (event: React.PointerEvent) => {
        const index = strokeIndexRef.current;
        if (index === null) return;
        const point = erasePoint(event);
        setStrokes((current) => current.map((stroke, i) => {
            if (i !== index) return stroke;
            const last = stroke.points[stroke.points.length - 1];
            if (last && Math.abs(last.x - point.x) < 0.0005 && Math.abs(last.y - point.y) < 0.0005) return stroke;
            return { ...stroke, points: [...stroke.points, point] };
        }));
    };

    const handleEraseUp = () => {
        strokeIndexRef.current = null;
    };

    const brushLabel: Record<BrushSize, string> = { thin: t.common.cropper.brushThin, medium: t.common.cropper.brushMedium, thick: t.common.cropper.brushThick };

    const handleMultiConfirm = async () => {
        if (!multiImgRef.current || regions.length === 0 || !onMultiCropComplete) return;
        try {
            onMultiCropComplete(await cropImageRegions(multiImgRef.current, regions));
            setRegions([]);
        } catch (e) {
            frontendLogger.error('[ImageCropper]', 'Multi-image crop failed', { error: e });
        }
    };

    function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
        // 默认框选整张图片，不拖动直接确认即为整图
        setCrop({ unit: '%', x: 0, y: 0, width: 100, height: 100 });
        measureImage(e.currentTarget);
        setImageReady((value) => value + 1);
    }

    const handleConfirm = async () => {
        if (!imgRef.current) return;
        // 没有有效选框（如只点了一下）时使用整张图片
        const base: ImageRegion = crop && crop.width > 0 && crop.height > 0
            ? { x: crop.x / 100, y: crop.y / 100, width: crop.width / 100, height: crop.height / 100 }
            : { x: 0, y: 0, width: 1, height: 1 };
        const region: ImageRegion = eraseEnabled && strokes.length ? { ...base, erase: strokes } : base;
        try {
            const [croppedBlob] = await cropImageRegions(imgRef.current, [region]);
            onCropComplete(croppedBlob);
        } catch (e) {
            frontendLogger.error('[ImageCropper]', 'Crop failed', { error: e });
        }
    };

    return (
        <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
            <DialogContent className="max-w-3xl h-[90vh] flex flex-col p-0 gap-0">
                <DialogHeader className="p-4 border-b shrink-0">
                    <DialogTitle>{t.common.cropper?.title || "Crop Image"}{titleSuffix ? ` · ${titleSuffix}` : ""}</DialogTitle>
                </DialogHeader>

                <div className="relative min-h-0 flex-1 bg-black">
                    {/* m-auto 居中：图片放大超出容器后仍能滚动到左上角 */}
                    <div ref={containerRef} className="flex h-full w-full overflow-auto p-4">
                        <div className="m-auto">
                            {mode === "multi" ? (
                                <RegionSelector
                                    ref={multiImgRef}
                                    imageSrc={safeImageSrc}
                                    regions={regions}
                                    onChange={setRegions}
                                    imageStyle={imageStyle}
                                    onImageLoad={(e) => measureImage(e.currentTarget)}
                                />
                            ) : (
                                <div className="relative inline-block select-none">
                                    <ReactCrop crop={crop} onChange={(_, percentCrop) => setCrop(percentCrop)} disabled={erasing}>
                                        <img
                                            ref={imgRef}
                                            alt="Crop me"
                                            src={safeImageSrc}
                                            onLoad={onImageLoad}
                                            style={imageStyle}
                                            className="block"
                                        />
                                    </ReactCrop>
                                    {eraseEnabled && (
                                        <canvas
                                            ref={eraseCanvasRef}
                                            data-testid="erase-canvas"
                                            aria-hidden
                                            className={`absolute inset-0 h-full w-full ${erasing ? "cursor-crosshair" : "pointer-events-none"}`}
                                            style={{ touchAction: "none" }}
                                            onPointerDown={handleEraseDown}
                                            onPointerMove={handleEraseMove}
                                            onPointerUp={handleEraseUp}
                                            onPointerCancel={handleEraseUp}
                                        />
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="absolute right-3 top-3">
                        <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} />
                    </div>
                </div>

                <div className="p-4 border-t bg-background shrink-0 space-y-3">
                    {onMultiCropComplete && (
                        <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1 sm:w-80">
                            {(["single", "multi"] as const).map((value) => (
                                <button
                                    key={value}
                                    type="button"
                                    onClick={() => setMode(value)}
                                    className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${mode === value ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                                >
                                    {value === "single" ? t.batchImport.singleMode : t.batchImport.multiMode}
                                </button>
                            ))}
                        </div>
                    )}
                    {eraseEnabled && mode !== "multi" && (
                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                variant={erasing ? "secondary" : "outline"}
                                size="sm"
                                aria-pressed={erasing}
                                onClick={() => {
                                    setErasing(!erasing);
                                    strokeIndexRef.current = null;
                                }}
                                className="flex items-center gap-2"
                            >
                                <Eraser className="h-4 w-4" />
                                {erasing ? t.common.cropper.eraseDone : t.common.cropper.erase}
                            </Button>
                            {erasing && (
                                <div role="group" aria-label={t.common.cropper.brushSize} className="flex gap-1 rounded-md bg-muted p-1">
                                    {BRUSH_SIZES.map(({ key }) => (
                                        <button
                                            key={key}
                                            type="button"
                                            aria-pressed={brushSize === key}
                                            onClick={() => setBrushSize(key)}
                                            className={`rounded px-2 py-1 text-xs font-medium ${brushSize === key ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                                        >
                                            {brushLabel[key]}
                                        </button>
                                    ))}
                                </div>
                            )}
                            {strokes.length > 0 && (
                                <>
                                    <Button variant="ghost" size="sm" onClick={() => setStrokes(strokes.slice(0, -1))} className="flex items-center gap-1.5">
                                        <Undo2 className="h-4 w-4" />
                                        {t.common.cropper.undoErase}
                                    </Button>
                                    <Button variant="ghost" size="sm" onClick={() => setStrokes([])} className="flex items-center gap-1.5">
                                        <Trash2 className="h-4 w-4" />
                                        {t.common.cropper.clearErase}
                                    </Button>
                                </>
                            )}
                        </div>
                    )}
                    <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
                        <p className="text-sm text-muted-foreground">
                            {mode === "multi"
                                ? `${t.batchImport.hint} ${t.batchImport.regionCount.replace("{count}", String(regions.length))}`
                                : erasing ? t.common.cropper.eraseHint
                                : (t.common.cropper?.hint || "💡 Drag to adjust crop area")}
                        </p>
                        <div className="flex gap-2 justify-end">
                            {mode === "multi" && regions.length > 0 && (
                                <Button variant="ghost" onClick={() => setRegions([])}>
                                    {t.batchImport.clear}
                                </Button>
                            )}
                            {onCancelQueue && (
                                <Button variant="ghost" onClick={onCancelQueue}>
                                    {t.upload.cancelAllImages}
                                </Button>
                            )}
                            <Button variant="outline" onClick={onClose}>
                                {onCancelQueue ? t.upload.skipImage : (t.common.cancel || "Cancel")}
                            </Button>
                            {mode === "multi" ? (
                                <Button onClick={handleMultiConfirm} disabled={regions.length === 0}>
                                    {t.batchImport.start.replace("{count}", String(regions.length))}
                                </Button>
                            ) : (
                                <Button onClick={handleConfirm}>
                                    {t.common.confirm || "Confirm"}
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
