/** Persist / restore horizontal scroll on markdown table wraps, and steer
 *  vertical wheel into that axis while the pointer is over a table.
 *
 *  Virtuoso positions rows with transforms. WebKit then zeros nested
 *  `overflow` scrollLeft; a naive scroll listener would persist that 0 and
 *  the next restore would look like the table "snapped back". Only persist
 *  from real pointer/wheel interaction on the wrap, and re-apply the saved
 *  offset after the conversation scroller moves. */

export const TABLE_WRAP_SELECTOR = '.md-table-wrap';

const positions = new Map<string, number>();
const interacting = new WeakSet<Element>();

function wrapHint(wrap: Element): string {
  return wrap.querySelector('th, td')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 48) ?? '';
}

export function tableWrapKey(owner: string, wrap: Element, index: number): string {
  return `${owner}:${index}:${wrapHint(wrap)}`;
}

function eachWrap(root: ParentNode, fn: (wrap: HTMLElement, index: number) => void): void {
  root.querySelectorAll(TABLE_WRAP_SELECTOR).forEach((node, index) => {
    if (node instanceof HTMLElement) fn(node, index);
  });
}

function isTableWrap(node: EventTarget | null): node is HTMLElement {
  return node instanceof HTMLElement && node.matches(TABLE_WRAP_SELECTOR);
}

export function persistTableWrapScroll(owner: string, root: ParentNode): void {
  eachWrap(root, (wrap, index) => {
    positions.set(tableWrapKey(owner, wrap, index), wrap.scrollLeft);
  });
}

export function restoreTableWrapScroll(owner: string, root: ParentNode): void {
  eachWrap(root, (wrap, index) => {
    const left = positions.get(tableWrapKey(owner, wrap, index));
    if (left == null || wrap.scrollLeft === left) return;
    wrap.scrollLeft = left;
  });
}

/** True when the wheel was consumed as table horizontal scroll. */
export function steerWheelToTable(event: WheelEvent, root: ParentNode): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const wrap = target.closest(TABLE_WRAP_SELECTOR);
  if (!(wrap instanceof HTMLElement) || !root.contains(wrap)) return false;
  if (wrap.scrollWidth <= wrap.clientWidth + 1) return false;
  // Trackpads already emit deltaX for a horizontal swipe — leave those native.
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return false;
  if (event.deltaY === 0) return false;
  wrap.scrollLeft += event.deltaY;
  return true;
}

function overflowingWrapFromEvent(event: Event, root: ParentNode): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const wrap = target.closest(TABLE_WRAP_SELECTOR);
  if (!(wrap instanceof HTMLElement) || !root.contains(wrap)) return null;
  if (wrap.scrollWidth <= wrap.clientWidth + 1) return null;
  return wrap;
}

/**
 * Bind wheel-to-horizontal, user-driven persist, and ancestor-scroll restore.
 * Returns an unbind function.
 */
export function attachTableScroll(owner: string, root: HTMLElement): () => void {
  restoreTableWrapScroll(owner, root);

  const onWheel = (event: WheelEvent) => {
    const wrap = overflowingWrapFromEvent(event, root);
    const steered = steerWheelToTable(event, root);
    if (steered) event.preventDefault();
    if (wrap || steered) persistTableWrapScroll(owner, root);
  };

  const onPointerDown = (event: PointerEvent) => {
    const wrap = overflowingWrapFromEvent(event, root);
    if (wrap) interacting.add(wrap);
  };

  const clearInteracting = () => {
    eachWrap(root, (wrap) => interacting.delete(wrap));
  };

  const onWrapScroll = (event: Event) => {
    if (!isTableWrap(event.target) || !interacting.has(event.target)) return;
    persistTableWrapScroll(owner, root);
  };

  let raf = 0;
  const restoreSoon = () => {
    if (raf !== 0) return;
    raf = window.requestAnimationFrame(() => {
      raf = 0;
      restoreTableWrapScroll(owner, root);
    });
  };

  const onAncestorScroll = (event: Event) => {
    if (isTableWrap(event.target)) return;
    restoreSoon();
  };

  const scroller =
    root.closest('[data-conversation-scroller]') ??
    root.closest('[data-virtuoso-scroller]') ??
    root.closest('.conversation-scroll');

  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('scroll', onWrapScroll, true);
  window.addEventListener('pointerup', clearInteracting);
  window.addEventListener('pointercancel', clearInteracting);
  scroller?.addEventListener('scroll', onAncestorScroll, { capture: true, passive: true });

  return () => {
    if (raf !== 0) window.cancelAnimationFrame(raf);
    root.removeEventListener('wheel', onWheel);
    root.removeEventListener('pointerdown', onPointerDown);
    root.removeEventListener('scroll', onWrapScroll, true);
    window.removeEventListener('pointerup', clearInteracting);
    window.removeEventListener('pointercancel', clearInteracting);
    scroller?.removeEventListener('scroll', onAncestorScroll, true);
  };
}

export function __resetTableScrollForTests(): void {
  positions.clear();
}
