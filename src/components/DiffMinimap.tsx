import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent
} from "react";

export interface DiffMinimapLine {
  type: "context" | "add" | "delete" | "replace";
}

interface DiffMinimapProps {
  lines: DiffMinimapLine[];
  scrollContainerRef: RefObject<HTMLElement>;
  scrollContainerId: string;
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  reserveBottom?: boolean;
}

interface DragState {
  pointerId: number;
  sliderOffset: number;
}

const MIN_VIEWPORT_HEIGHT = 18;

export function DiffMinimap({
  lines,
  scrollContainerRef,
  scrollContainerId,
  scrollTop,
  scrollHeight,
  viewportHeight,
  reserveBottom = false
}: DiffMinimapProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const trackHeight = Math.max(0, viewportHeight - (reserveBottom ? 14 : 0));
  const scrollableHeight = Math.max(0, scrollHeight - viewportHeight);
  const sliderHeight = scrollHeight <= 0 || scrollHeight <= viewportHeight
    ? trackHeight
    : Math.min(trackHeight, Math.max(MIN_VIEWPORT_HEIGHT, (trackHeight * viewportHeight) / scrollHeight));
  const sliderTravel = Math.max(0, trackHeight - sliderHeight);
  const sliderTop = scrollableHeight > 0 ? (scrollTop / scrollableHeight) * sliderTravel : 0;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) {
      return;
    }

    const draw = () => drawOverviewRuler(canvas, root, lines, scrollHeight);
    draw();

    const resizeObserver = new ResizeObserver(draw);
    const themeObserver = new MutationObserver(draw);
    const themeRoot = root.closest(".app-shell") ?? document.documentElement;
    resizeObserver.observe(root);
    themeObserver.observe(themeRoot, { attributes: true, attributeFilter: ["class", "style"] });
    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
    };
  }, [lines, scrollHeight]);

  function setScrollTop(nextScrollTop: number) {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }
    scrollContainer.scrollTop = clampNumber(nextScrollTop, 0, Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight));
  }

  function scrollFromPointer(clientY: number, sliderOffset: number) {
    const root = rootRef.current;
    if (!root) {
      return;
    }

    const bounds = root.getBoundingClientRect();
    const availableTravel = Math.max(0, bounds.height - sliderHeight);
    if (availableTravel === 0 || scrollableHeight === 0) {
      setScrollTop(0);
      return;
    }

    const nextSliderTop = clampNumber(clientY - bounds.top - sliderOffset, 0, availableTravel);
    setScrollTop((nextSliderTop / availableTravel) * scrollableHeight);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    const root = event.currentTarget;
    const bounds = root.getBoundingClientRect();
    const pointerY = event.clientY - bounds.top;
    const pointerHitsViewport = pointerY >= sliderTop && pointerY <= sliderTop + sliderHeight;
    const sliderOffset = pointerHitsViewport ? pointerY - sliderTop : sliderHeight / 2;
    dragStateRef.current = { pointerId: event.pointerId, sliderOffset };
    root.setPointerCapture(event.pointerId);
    scrollFromPointer(event.clientY, sliderOffset);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    scrollFromPointer(event.clientY, dragState.sliderOffset);
  }

  function endPointerDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setScrollTop(scrollContainer.scrollTop + event.deltaY);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }

    let nextScrollTop = scrollContainer.scrollTop;
    if (event.key === "ArrowUp") {
      nextScrollTop -= 3 * 24;
    } else if (event.key === "ArrowDown") {
      nextScrollTop += 3 * 24;
    } else if (event.key === "PageUp") {
      nextScrollTop -= scrollContainer.clientHeight;
    } else if (event.key === "PageDown") {
      nextScrollTop += scrollContainer.clientHeight;
    } else if (event.key === "Home") {
      nextScrollTop = 0;
    } else if (event.key === "End") {
      nextScrollTop = scrollContainer.scrollHeight;
    } else {
      return;
    }

    event.preventDefault();
    setScrollTop(nextScrollTop);
  }

  return (
    <div
      ref={rootRef}
      className={`diff-minimap ${reserveBottom ? "reserve-bottom" : ""}`}
      role="scrollbar"
      tabIndex={0}
      aria-label="文件差异概览"
      aria-controls={scrollContainerId}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={Math.round(scrollableHeight)}
      aria-valuenow={Math.round(clampNumber(scrollTop, 0, scrollableHeight))}
      aria-valuetext={scrollableHeight > 0 ? `已滚动 ${Math.round((scrollTop / scrollableHeight) * 100)}%` : "全部内容可见"}
      title="点击或拖动以定位文件差异"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointerDrag}
      onPointerCancel={endPointerDrag}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
    >
      <canvas ref={canvasRef} className="diff-minimap-canvas" aria-hidden="true" />
      <span
        className="diff-minimap-viewport"
        style={{
          height: `${Math.max(0, Math.min(trackHeight, sliderHeight))}px`,
          transform: `translateY(${Math.max(0, sliderTop)}px)`
        }}
        aria-hidden="true"
      />
    </div>
  );
}

function drawOverviewRuler(canvas: HTMLCanvasElement, root: HTMLDivElement, lines: DiffMinimapLine[], scrollHeight: number) {
  const width = root.clientWidth;
  const height = root.clientHeight;
  if (width <= 0 || height <= 0) {
    return;
  }

  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const styles = window.getComputedStyle(root);
  const background = styles.getPropertyValue("--sunken").trim() || "#0d1116";
  const addColor = styles.getPropertyValue("--success").trim() || "#7bd88f";
  const deleteColor = styles.getPropertyValue("--danger").trim() || "#ef6b73";
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  if (lines.length === 0) {
    return;
  }

  const overviewWidth = Math.min(40, width);
  const overviewGap = 1;
  const overviewStart = width - overviewWidth;
  const overviewLaneWidth = (overviewWidth - overviewGap) / 2;
  const contentScale = height / Math.max(height, scrollHeight);
  const estimatedRowHeight = 24;
  const markerHeight = Math.max(3, estimatedRowHeight * contentScale);

  lines.forEach((line, index) => {
    const markerY = Math.min(height - markerHeight, index * estimatedRowHeight * contentScale);

    if (line.type === "delete" || line.type === "replace") {
      context.globalAlpha = 0.9;
      context.fillStyle = deleteColor;
      context.fillRect(overviewStart, markerY, overviewLaneWidth, markerHeight);
    }
    if (line.type === "add" || line.type === "replace") {
      context.globalAlpha = 0.9;
      context.fillStyle = addColor;
      context.fillRect(overviewStart + overviewLaneWidth + overviewGap, markerY, overviewLaneWidth, markerHeight);
    }
  });

  context.globalAlpha = 1;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
