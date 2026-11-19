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
    const sessionKey = open ? imageSrc : "";
    // 始终保存百分比坐标，换图或重开弹窗后自动重置，缩放改变图片显示尺寸后仍然准确
    const [cropState, setCropState] = useState<{ key: string; crop: Crop | undefined }>({ key: sessionKey, crop: undefined });
    const crop = cropState.key === sessionKey ? cropState.crop : undefined;
    const setCrop = (next: Crop | undefined) => setCropState({ key: sessionKey, crop: next });
    const imgRef = useRef<HTMLImageElement>(null);
    const [modeState, setModeState] = useState<{ key: string; mode: "single" | "multi" }>({ key: sessionKey, mode: "single" });
    const mode = modeState.key === sessionKey ? modeState.mode : "single";
    const { containerRef, zoom, imageStyle, measureImage, zoomIn, zoomOut, reset: resetZoom } = useImageZoom(FIT_STYLE[mode]);
    // 换图或重开后回到 100%
    useEffect(() => {
        resetZoom();
    }, [sessionKey, resetZoom]);
    const setMode = (next: "single" | "multi") => {
        resetZoom();
        setModeState({ key: sessionKey, mode: next });
        if (next === "multi") {
            setErasing(false);
            setStrokes([]);
            activeStrokeRef.current = null;
            activePointersRef.current.clear();
        }
    };
    // 框选结果与图片绑定，换图或重开后自动清空
    const [regionState, setRegionState] = useState<{ src: string; regions: ImageRegion[] }>({ src: sessionKey, regions: [] });
    const regions = regionState.src === sessionKey ? regionState.regions : [];
    const setRegions = (next: ImageRegion[]) => setRegionState({ src: sessionKey, regions: next });
    const multiImgRef = useRef<HTMLImageElement>(null);

    // 擦除笔画与图片绑定，换图后清空；坐标相对整张图片（Ported from margrop/wrong-notebook 35431618, MIT）
    const [eraseState, setEraseState] = useState<{ src: string; strokes: EraseStroke[] }>({ src: sessionKey, strokes: [] });
    const strokes = useMemo(() => (eraseState.src === sessionKey ? eraseState.strokes : []), [eraseState, sessionKey]);
    const setStrokes = (next: EraseStroke[] | ((current: EraseStroke[]) => EraseStroke[])) =>
        setEraseState((current) => ({ src: sessionKey, strokes: typeof next === "function" ? next(current.src === sessionKey ? current.strokes : []) : next }));
    const [erasingState, setErasingState] = useState<{ src: string; on: boolean }>({ src: sessionKey, on: false });
    const erasing = erasingState.src === sessionKey && erasingState.on;
    const setErasing = (on: boolean) => setErasingState({ src: sessionKey, on });
    const [brushSize, setBrushSize] = useState<BrushSize>("medium");
    const [confirming, setConfirming] = useState(false);
    const [canvasLayoutVersion, setCanvasLayoutVersion] = useState(0);
    const eraseCanvasRef = useRef<HTMLCanvasElement>(null);
    const activeStrokeRef = useRef<EraseStroke | null>(null);
    const activePointersRef = useRef<Set<number>>(new Set());

    // 监听图片显示尺寸变化（旋转、窗口缩放等），及时同步高清预览画布
    useEffect(() => {
        if (!eraseEnabled || mode === "multi" || typeof ResizeObserver === "undefined") return;
        const image = imgRef.current;
        if (!image) return;
        const observer = new ResizeObserver(() => {
            setCanvasLayoutVersion((value) => value + 1);
        });
        observer.observe(image);
        return () => observer.disconnect();
    }, [eraseEnabled, mode, sessionKey]);

    // 预览画布按 DPR 高清重绘已提交擦除笔画；缩放或换图后坐标仍按图片宽高归一化
    useEffect(() => {
        if (!eraseEnabled || mode === "multi") return;
        const canvas = eraseCanvasRef.current;
        const image = imgRef.current;
        if (!canvas || !image || image.clientWidth === 0 || image.clientHeight === 0) return;
        const dpr = Math.min(typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1, 2);
        const targetWidth = Math.max(1, Math.round(image.clientWidth * dpr));
        const targetHeight = Math.max(1, Math.round(image.clientHeight * dpr));
        if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
            canvas.width = targetWidth;
            canvas.height = targetHeight;
        }
        const context = canvas.getContext("2d");
        if (!context) return;
        context.clearRect(0, 0, canvas.width, canvas.height);
        applyEraseStrokes(context, strokes, { width: canvas.width, height: canvas.height },
            { sx: 0, sy: 0, sw: canvas.width, sh: canvas.height }, { width: canvas.width, height: canvas.height });
    }, [eraseEnabled, mode, strokes, canvasLayoutVersion, zoom, sessionKey]);

    const brushPixels = BRUSH_SIZES.find((size) => size.key === brushSize)?.pixels ?? 7;

    const erasePoint = (event: React.PointerEvent) => {
        const canvas = eraseCanvasRef.current;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return {
            x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
            y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
        };
    };

    const drawIncrementalStroke = (stroke: EraseStroke) => {
        const canvas = eraseCanvasRef.current;
        if (!canvas || canvas.width <= 0 || canvas.height <= 0) return;
        const context = canvas.getContext("2d");
        if (!context) return;
        const tail = stroke.points.length >= 2 ? stroke.points.slice(-2) : stroke.points;
        applyEraseStrokes(
            context,
            [{ points: tail, radius: stroke.radius }],
            { width: canvas.width, height: canvas.height },
            { sx: 0, sy: 0, sw: canvas.width, sh: canvas.height },
            { width: canvas.width, height: canvas.height },
        );
    };

    const redrawCommittedStrokes = () => {
        const canvas = eraseCanvasRef.current;
        if (!canvas || canvas.width <= 0 || canvas.height <= 0) return;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.clearRect(0, 0, canvas.width, canvas.height);
        applyEraseStrokes(context, strokes, { width: canvas.width, height: canvas.height },
            { sx: 0, sy: 0, sw: canvas.width, sh: canvas.height }, { width: canvas.width, height: canvas.height });
    };

    const handleEraseDown = (event: React.PointerEvent) => {
        if (!erasing || event.button !== 0) return;
        const pointerId = event.pointerId ?? 0;
        activePointersRef.current.add(pointerId);
        // 检测到双指/多指缩放手势或非主指针时取消当前临时笔画，避免留下误触白点
        if (event.isPrimary === false || activePointersRef.current.size > 1) {
            if (activeStrokeRef.current) {
                activeStrokeRef.current = null;
                redrawCommittedStrokes();
            }
            return;
        }
        const point = erasePoint(event);
        if (!point) return;
        event.preventDefault();
        eraseCanvasRef.current?.setPointerCapture?.(event.pointerId);
        const canvas = eraseCanvasRef.current;
        const width = canvas?.clientWidth || canvas?.getBoundingClientRect().width || 0;
        const nextStroke: EraseStroke = { points: [point], radius: width > 0 ? brushPixels / width : 0.006 };
        activeStrokeRef.current = nextStroke;
        drawIncrementalStroke(nextStroke);
    };

    const handleEraseMove = (event: React.PointerEvent) => {
        const active = activeStrokeRef.current;
        if (!active || event.isPrimary === false || activePointersRef.current.size > 1) return;
        const point = erasePoint(event);
        if (!point) return;
        const last = active.points[active.points.length - 1];
        if (last && Math.abs(last.x - point.x) < 0.0005 && Math.abs(last.y - point.y) < 0.0005) return;
        active.points.push(point);
        drawIncrementalStroke(active);
    };

    const handleEraseUp = (event: React.PointerEvent) => {
        const pointerId = event.pointerId ?? 0;
        activePointersRef.current.delete(pointerId);
        const finished = activeStrokeRef.current;
        activeStrokeRef.current = null;
        if (finished && finished.points.length > 0) {
            setStrokes((current) => [...current, finished]);
        }
    };

    const handleEraseCancel = (event: React.PointerEvent) => {
        const pointerId = event.pointerId ?? 0;
        activePointersRef.current.delete(pointerId);
        if (activeStrokeRef.current) {
            activeStrokeRef.current = null;
            redrawCommittedStrokes();
        }
    };

    const brushLabel: Record<BrushSize, string> = { thin: t.common.cropper.brushThin, medium: t.common.cropper.brushMedium, thick: t.common.cropper.brushThick };

    const handleMultiConfirm = async () => {
        if (confirming || !multiImgRef.current || regions.length === 0 || !onMultiCropComplete) return;
        setConfirming(true);
        try {
            onMultiCropComplete(await cropImageRegions(multiImgRef.current, regions));
            setRegions([]);
        } catch (e) {
            frontendLogger.error('[ImageCropper]', 'Multi-image crop failed', { error: e });
        } finally {
            setConfirming(false);
        }
    };

    function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
        // 默认框选整张图片，不拖动直接确认即为整图
        setCrop({ unit: '%', x: 0, y: 0, width: 100, height: 100 });
        measureImage(e.currentTarget);
        setCanvasLayoutVersion((value) => value + 1);
    }

    const handleConfirm = async () => {
        if (confirming || !imgRef.current) return;
        // 没有有效选框（如只点了一下）时使用整张图片
        const base: ImageRegion = crop && crop.width > 0 && crop.height > 0
            ? { x: crop.x / 100, y: crop.y / 100, width: crop.width / 100, height: crop.height / 100 }
            : { x: 0, y: 0, width: 1, height: 1 };
        const finalStrokes = activeStrokeRef.current ? [...strokes, activeStrokeRef.current] : strokes;
        activeStrokeRef.current = null;
        const region: ImageRegion = eraseEnabled && finalStrokes.length ? { ...base, erase: finalStrokes } : base;
        setConfirming(true);
        try {
            const [croppedBlob] = await cropImageRegions(imgRef.current, [region]);
            onCropComplete(croppedBlob);
        } catch (e) {
            frontendLogger.error('[ImageCropper]', 'Crop failed', { error: e });
        } finally {
            setConfirming(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !confirming && onClose()}>
            <DialogContent className="max-w-3xl h-[90vh] overflow-hidden flex flex-col p-0 gap-0">
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
                                            onPointerCancel={handleEraseCancel}
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
                                    activeStrokeRef.current = null;
                                    activePointersRef.current.clear();
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
                                <Button onClick={handleMultiConfirm} disabled={regions.length === 0 || confirming}>
                                    {t.batchImport.start.replace("{count}", String(regions.length))}
                                </Button>
                            ) : (
                                <Button onClick={handleConfirm} disabled={confirming}>
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
