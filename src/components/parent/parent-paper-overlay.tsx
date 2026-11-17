"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { ZoomControls } from "@/components/zoom-controls";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { regionFromPoints } from "@/lib/image-crop";
import { frontendLogger } from "@/lib/frontend-logger";
import { OVERLAY_COLORS, renderAnnotatedPagePng, shareOrDownloadPng } from "@/lib/parent-paper-annotate";
import { regionToBBox, resizeNormalizedBox, type BoxHandle } from "@/lib/parent-paper-box-edit";
import { badgePlacements, layoutParentPaperBBoxes } from "@/lib/parent-paper-box-layout";
import type { ParentPaperQuestionView } from "@/lib/parent-papers";
import type { QuestionBBox } from "@/lib/parent-paper-review";
import { toast } from "@/lib/feedback";
import { getApiErrorMessage } from "@/lib/error-message";
import { useImageZoom } from "@/lib/use-image-zoom";

const HANDLES: Array<Exclude<BoxHandle, "move">> = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

const HANDLE_STYLE: Record<Exclude<BoxHandle, "move">, string> = {
    n: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize",
    s: "left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-ns-resize",
    e: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
    w: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
    ne: "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize",
    nw: "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize",
    se: "right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize",
    sw: "left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize",
};

export interface ParentPaperOverlayProps {
    title: string;
    pages: Array<{ id: string; position: number; imageUrl: string }>;
    questions: ParentPaperQuestionView[];
    activeQuestionId: string | null;
    revealToken?: number;
    onSelectQuestion: (id: string) => void;
    canEdit: boolean;
    onSaveBbox: (questionId: string, bbox: QuestionBBox) => Promise<void>;
}

export function ParentPaperOverlay({
    title,
    pages,
    questions,
    activeQuestionId,
    revealToken = 0,
    onSelectQuestion,
    canEdit,
    onSaveBbox,
}: ParentPaperOverlayProps) {
    const { t } = useLanguage();
    const copy = t.parentPapers;
    const [manualPage, setManualPage] = useState<{ page: number; reveal: number } | null>(null);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState<QuestionBBox | null>(null);
    const [exporting, setExporting] = useState(false);
    const shellRef = useRef<HTMLDivElement | null>(null);
    const [fitBox, setFitBox] = useState({ width: 0, height: 0 });
    const fitStyle = useMemo(() => ({
        maxWidth: fitBox.width ? `${fitBox.width}px` : "100%",
        maxHeight: fitBox.height ? `${fitBox.height}px` : "100%",
        width: "auto" as const,
        height: "auto" as const,
        display: "block" as const,
    }), [fitBox]);
    const { containerRef, zoom, imageStyle, measureImage, zoomIn, zoomOut, reset, pinchingRef } = useImageZoom(fitStyle);
    const overlayRef = useRef<HTMLDivElement>(null);
    const setShell = (element: HTMLDivElement | null) => {
        shellRef.current = element;
        containerRef(element);
    };
    useLayoutEffect(() => {
        const element = shellRef.current;
        if (!element) return;
        const update = () => setFitBox({ width: element.clientWidth, height: element.clientHeight });
        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    useLayoutEffect(() => {
        const image = shellRef.current?.querySelector("img");
        if (image instanceof HTMLImageElement) measureImage(image);
    }, [fitBox, measureImage]);
    const dragRef = useRef<{ handle: BoxHandle | "draw"; start: { x: number; y: number }; box: { x: number; y: number; width: number; height: number } } | null>(null);

    const orderedPages = useMemo(() => [...pages].sort((a, b) => a.position - b.position), [pages]);
    const laidOutQuestions = useMemo(() => layoutParentPaperBBoxes(questions), [questions]);
    const active = laidOutQuestions.find((question) => question.id === activeQuestionId) ?? null;
    const followActive = !manualPage || manualPage.reveal !== revealToken;
    const rawIndex = followActive && active?.bbox
        ? active.bbox.pageIndex
        : (manualPage?.page ?? 0);
    const safeIndex = Math.min(Math.max(0, rawIndex), Math.max(0, orderedPages.length - 1));
    const page = orderedPages[safeIndex];
    const questionsOnPage = laidOutQuestions.filter((question) => question.bbox?.pageIndex === safeIndex);
    const badges = badgePlacements(questionsOnPage.filter((question) => question.bbox).map((question) => ({ id: question.id, bbox: question.bbox! })));

    const goToPage = (index: number) => {
        setManualPage({ page: index, reveal: revealToken });
        setEditing(false);
        setDraft(null);
        reset();
    };

    const pageKeyRef = useRef(page?.id ?? "");
    if (pageKeyRef.current !== (page?.id ?? "")) {
        pageKeyRef.current = page?.id ?? "";
        if (editing) setEditing(false);
        if (draft) setDraft(null);
        reset();
    }

    if (!page) return null;

    const displayBox = (question: ParentPaperQuestionView): QuestionBBox | null => {
        if (editing && question.id === activeQuestionId) return draft ?? question.bbox;
        return question.bbox;
    };

    const toRelative = (event: ReactPointerEvent) => {
        const rect = overlayRef.current!.getBoundingClientRect();
        return {
            x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
            y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
        };
    };

    const startEdit = (draw: boolean) => {
        if (!active) return;
        setEditing(true);
        setDraft(active.bbox);
        if (draw) setDraft(null);
    };

    const cancelEdit = () => {
        setEditing(false);
        setDraft(null);
        dragRef.current = null;
    };

    const saveEdit = async () => {
        if (!active || !draft) return;
        try {
            await onSaveBbox(active.id, draft);
            setEditing(false);
            setDraft(null);
        } catch (error) {
            frontendLogger.error("[ParentPaperOverlay]", "Failed to save bbox", { error });
            toast.error(getApiErrorMessage(error) || copy.saveError);
        }
    };

    const handlePointerDown = (event: ReactPointerEvent, handle: BoxHandle | "draw", box?: QuestionBBox) => {
        if (!editing || pinchingRef.current || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        overlayRef.current?.setPointerCapture(event.pointerId);
        const point = toRelative(event);
        if (handle === "draw") {
            dragRef.current = { handle: "draw", start: point, box: { x: point.x, y: point.y, width: 0, height: 0 } };
            return;
        }
        if (!box) return;
        dragRef.current = { handle, start: point, box: { x: box.x, y: box.y, width: box.width, height: box.height } };
    };

    const handlePointerMove = (event: ReactPointerEvent) => {
        const drag = dragRef.current;
        if (!drag || pinchingRef.current) return;
        const point = toRelative(event);
        if (drag.handle === "draw") {
            const region = regionFromPoints(drag.start.x, drag.start.y, point.x, point.y);
            setDraft(regionToBBox(region, safeIndex));
            return;
        }
        const resized = resizeNormalizedBox(drag.box, drag.start, point, drag.handle);
        setDraft(regionToBBox(resized, safeIndex));
    };

    const handlePointerUp = () => {
        dragRef.current = null;
    };

    const exportPage = async () => {
        setExporting(true);
        try {
            const boxes = questionsOnPage
                .filter((question) => question.bbox)
                .map((question) => ({
                    number: question.number,
                    verdict: question.effectiveVerdict,
                    bbox: question.bbox!,
                }));
            const blob = await renderAnnotatedPagePng(page.imageUrl, boxes, safeIndex);
            const filename = `${title || copy.untitled}-p${safeIndex + 1}.png`;
            const mode = await shareOrDownloadPng(blob, filename, title || copy.untitled);
            toast.success(mode === "shared" ? copy.shared : copy.exported);
        } catch (error) {
            if ((error as { name?: string }).name === "AbortError") return;
            frontendLogger.error("[ParentPaperOverlay]", "Failed to export annotated page", { error });
            toast.error(copy.exportError);
        } finally {
            setExporting(false);
        }
    };

    return (
        <section id="parent-paper-overlay" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                {orderedPages.length > 1 ? (
                    <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1" role="tablist" aria-label={copy.title}>
                        {orderedPages.map((item, index) => (
                            <Button
                                key={item.id}
                                type="button"
                                size="sm"
                                variant={index === safeIndex ? "default" : "outline"}
                                onClick={() => goToPage(index)}
                            >
                                {copy.pageLabel.replace("{index}", String(index + 1))}
                            </Button>
                        ))}
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground">
                        {copy.pageLabel.replace("{index}", String(safeIndex + 1))}
                    </p>
                )}
                <ZoomControls variant="toolbar" zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={reset} />
            </div>

            <div className="relative overflow-hidden rounded-2xl border border-border bg-[#f5f3ff]">
                <div
                    ref={setShell}
                    className="flex h-[calc(100dvh-16rem-env(safe-area-inset-bottom,0px))] items-center justify-center overflow-auto overscroll-contain md:h-[min(85dvh,calc(100dvh-9rem))]"
                    style={{ touchAction: editing ? "none" : "pan-x pan-y" }}
                >
                    <div className="relative inline-block max-h-full max-w-full">
                        <img
                            src={page.imageUrl}
                            alt={copy.pageLabel.replace("{index}", String(safeIndex + 1))}
                            className="block max-h-full max-w-full"
                            style={imageStyle}
                            draggable={false}
                            onLoad={(event) => measureImage(event.currentTarget)}
                        />
                        <div
                            ref={overlayRef}
                            className="absolute inset-0"
                            style={{ touchAction: editing ? "none" : "auto" }}
                            onPointerMove={handlePointerMove}
                            onPointerUp={handlePointerUp}
                            onPointerCancel={handlePointerUp}
                            onPointerDown={(event) => {
                                if (editing && canEdit && (!active?.bbox && !draft)) {
                                    handlePointerDown(event, "draw");
                                }
                            }}
                        >
                            {laidOutQuestions.filter((question) => displayBox(question)?.pageIndex === safeIndex).map((question) => {
                                const box = displayBox(question);
                                if (!box) return null;
                                const colors = OVERLAY_COLORS[question.effectiveVerdict];
                                const selected = question.id === activeQuestionId;
                                return (
                                    <div
                                        key={question.id}
                                        className="absolute"
                                        style={{
                                            left: `${box.x * 100}%`,
                                            top: `${box.y * 100}%`,
                                            width: `${box.width * 100}%`,
                                            height: `${box.height * 100}%`,
                                            border: `${selected ? 3 : 2}px solid ${colors.stroke}`,
                                            background: colors.fill,
                                            boxShadow: selected ? `0 0 0 2px ${colors.stroke}` : undefined,
                                            zIndex: selected ? 2 : 1,
                                        }}
                                        onPointerDown={(event) => {
                                            if (editing && selected) {
                                                handlePointerDown(event, "move", box);
                                                return;
                                            }
                                            if (!editing) {
                                                event.stopPropagation();
                                                onSelectQuestion(question.id);
                                            }
                                        }}
                                    >
                                        <span
                                            className="absolute z-[3] whitespace-nowrap rounded-sm px-1 py-px text-center text-[10px] font-semibold leading-4 text-white sm:px-1.5 sm:text-[11px]"
                                            style={{
                                                background: colors.stroke,
                                                ...( (badges[question.id]?.side ?? (box.x >= 0.07 ? "left" : "above")) === "left"
                                                    ? {
                                                        right: "100%",
                                                        top: 0,
                                                        marginRight: 2,
                                                        transform: badges[question.id]?.shift ? `translateY(${badges[question.id]!.shift * 1.05}rem)` : undefined,
                                                    }
                                                    : {
                                                        left: 0,
                                                        bottom: "100%",
                                                        marginBottom: 2,
                                                        transform: badges[question.id]?.shift ? `translateX(${badges[question.id]!.shift * 1.15}rem)` : undefined,
                                                    }),
                                            }}
                                        >
                                            {question.number}
                                        </span>
                                        <span
                                            className="absolute right-0.5 top-0.5 text-sm font-bold leading-none sm:text-base"
                                            style={{ color: colors.stroke, textShadow: "0 0 2px #fff, 0 0 2px #fff" }}
                                            aria-hidden="true"
                                        >
                                            {colors.mark}
                                        </span>
                                        {editing && selected && HANDLES.map((handle) => (
                                            <button
                                                key={handle}
                                                type="button"
                                                tabIndex={-1}
                                                aria-hidden="true"
                                                className={`absolute h-4 w-4 rounded-sm border-2 border-white ${HANDLE_STYLE[handle]}`}
                                                style={{ background: colors.stroke }}
                                                onPointerDown={(event) => handlePointerDown(event, handle, box)}
                                            />
                                        ))}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => void exportPage()} loading={exporting} loadingText={copy.exporting}>
                    {copy.exportPage}
                </Button>
                {canEdit && active && !editing && (
                    <Button type="button" variant="outline" size="sm" onClick={() => startEdit(!active.bbox)}>
                        {active.bbox ? copy.editBox : copy.drawBox}
                    </Button>
                )}
                {canEdit && editing && (
                    <>
                        <Button type="button" size="sm" onClick={() => void saveEdit()} disabled={!draft}>
                            {copy.saveBox}
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={cancelEdit}>
                            {copy.cancelEdit}
                        </Button>
                    </>
                )}
            </div>
            {editing && (
                <p className="text-sm text-muted-foreground">
                    {draft || active?.bbox ? copy.boxHint : copy.drawHint}
                </p>
            )}
            {canEdit && active && !active.bbox && !editing && (
                <p className="text-sm text-muted-foreground">{copy.missingBox}</p>
            )}
        </section>
    );
}
