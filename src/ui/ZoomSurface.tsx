import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { wheelZoom } from './zoom';

type Anchor = {
  element: Element;
  clientX: number;
  clientY: number;
  u: number | null;
  v: number | null;
  stickyY: boolean;
};

function hasStickyAncestor(element: Element, stopAt: Element) {
  for (let el: Element | null = element; el && el !== stopAt; el = el.parentElement) {
    if (getComputedStyle(el).position === 'sticky') return true;
  }
  return false;
}

// Capture Ctrl/Cmd + wheel across the active canvas scroll pane so zooming out never
// drops off a shrinking SVG into native scrolling, and anchor only inside the diagram's scrollers.
export function ZoomSurface({
  zoom,
  change,
  children,
  reflow = false,
}: {
  zoom: number;
  change: (zoom: number) => void;
  children: React.ReactNode;
  reflow?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const changeRef = useRef(change);
  changeRef.current = change;
  const pendingZoom = useRef(zoom);
  const anchor = useRef<Anchor | null>(null);

  useEffect(() => {
    const root = ref.current!;
    const container = root.closest<HTMLElement>('.panel-scroll') ?? root;
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.deltaY) return;
      const target = event.target instanceof Element ? event.target : null;
      const surface = target?.closest('[data-zoom-surface]') ?? root.querySelector('[data-zoom-surface]');
      if (!surface) return;
      event.preventDefault();
      const current = pendingZoom.current;
      const next = wheelZoom(current, event.deltaY, event.deltaMode);
      if (next === current) return;
      pendingZoom.current = next;
      if (!anchor.current || Math.abs(event.clientX - anchor.current.clientX) > 1 || Math.abs(event.clientY - anchor.current.clientY) > 1) {
        const element =
          target?.closest('[data-zoom-anchor]') ??
          target?.closest('[data-zoom-sticky]') ??
          surface.querySelector('[data-zoom-content]') ??
          surface;
        const box = element.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) {
          const insideX = event.clientX >= box.left && event.clientX <= box.right;
          const insideY = event.clientY >= box.top && event.clientY <= box.bottom;
          anchor.current = {
            element,
            clientX: event.clientX,
            clientY: event.clientY,
            u: insideX ? (event.clientX - box.left) / box.width : null,
            v: insideY ? (event.clientY - box.top) / box.height : null,
            stickyY: hasStickyAncestor(element, root),
          };
        }
      }
      changeRef.current(next);
    };
    container.addEventListener('wheel', wheel, { passive: false });
    return () => container.removeEventListener('wheel', wheel);
  }, []);

  useLayoutEffect(() => {
    pendingZoom.current = zoom;
    const a = anchor.current;
    anchor.current = null;
    if (!a || !a.element.isConnected) return;
    let handledX = a.u === null;
    let handledY = a.v === null || a.stickyY;
    for (let el = a.element.parentElement; el && (!handledX || !handledY); el = el.parentElement) {
      const style = getComputedStyle(el);
      const isSurface = el.hasAttribute('data-zoom-surface');
      const canX = !handledX && /(auto|scroll)/.test(style.overflowX) && (el.scrollWidth > el.clientWidth || el.scrollLeft > 0 || isSurface);
      const canY =
        !handledY &&
        /(auto|scroll)/.test(style.overflowY) &&
        (el.scrollHeight > el.clientHeight || el.scrollTop > 0 || (isSurface && style.maxHeight !== 'none'));
      if (!canX && !canY) continue;
      const box = a.element.getBoundingClientRect();
      if (canX && a.u !== null) {
        el.scrollLeft += box.left + a.u * box.width - a.clientX;
        handledX = true;
      }
      if (canY && a.v !== null) {
        el.scrollTop += box.top + a.v * box.height - a.clientY;
        handledY = true;
      }
    }
  }, [zoom]);

  // Reserve trailing pan space as the diagram grows. Without it a diagram that
  // initially fits the pane cannot scroll far enough to keep the cursor anchor.
  return (
    <div ref={ref} className="zoom-surface" style={{ width: '100%', boxSizing: 'content-box', paddingRight: reflow ? 0 : Math.max(0, zoom - 1) * 650 }}>
      {children}
    </div>
  );
}
