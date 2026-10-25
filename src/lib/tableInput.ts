export interface TableOrbitView {
  rotation: number;
  tilt: number;
}

export interface TablePointer {
  x: number;
  y: number;
}

export interface TableViewport {
  width: number;
  height: number;
}

export interface TableOrbitDrag<View extends TableOrbitView = TableOrbitView> {
  readonly view: Readonly<View>;
  readonly pointer: Readonly<TablePointer>;
  readonly viewport: Readonly<TableViewport>;
}

export const TABLE_TILT_MIN = 28;
export const TABLE_TILT_MAX = 78;

/** Snapshot a fresh mouse/touch anchor, including after a pinch or view reset. */
export function createOrbitDrag<View extends TableOrbitView>(view: View, pointer: TablePointer, viewport: TableViewport): TableOrbitDrag<View> {
  return {
    view: { ...view },
    pointer: { ...pointer },
    viewport: { width: Math.max(1, viewport.width), height: Math.max(1, viewport.height) },
  };
}

/**
 * Screen-space gestures have the same direction at every board orientation.
 * Right swivels the far edge right; up raises the view toward overhead. Using
 * the full drag from its anchor avoids event-rate drift and stale incremental
 * React state. Yaw stays continuous across a full turn instead of wrapping.
 */
export function orbitFromDrag<View extends TableOrbitView>(drag: TableOrbitDrag<View>, pointer: TablePointer): View {
  const horizontal = (pointer.x - drag.pointer.x) / drag.viewport.width;
  const vertical = (pointer.y - drag.pointer.y) / drag.viewport.height;
  return {
    ...drag.view,
    rotation: drag.view.rotation + horizontal * Math.PI,
    tilt: Math.max(TABLE_TILT_MIN, Math.min(TABLE_TILT_MAX, drag.view.tilt - vertical * 60)),
  } as View;
}

/** A small tap/click remains a selection, never an unintended orbit. */
export function isTableDrag(start: TablePointer, pointer: TablePointer, pointerType = 'mouse'): boolean {
  const threshold = pointerType === 'touch' ? 8 : 5;
  return (pointer.x - start.x) ** 2 + (pointer.y - start.y) ** 2 > threshold ** 2;
}
