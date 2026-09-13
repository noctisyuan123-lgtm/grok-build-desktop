/** Persist / restore horizontal scroll on markdown table wraps and code
 *  blocks, and steer vertical wheel into that axis while the pointer is over
 *  an overflowing target.
 *
 *  Virtuoso positions rows with transforms. WebKit then zeros nested
 *  `overflow` scrollLeft; a naive scroll listener would persist that 0 and
 *  the next restore would look like the block "snapped back". Only persist
 *  from real pointer/wheel interaction on the target, and re-apply the saved
 *  offset after the conversation scroller moves. */

export const TABLE_WRAP_SELECTOR = '.md-table-wrap';
export const CODE_SCROLL_SELECTOR = '.md-code-shell > pre';
export const OVERFLOW_SCROLL_SELECTOR = `${TABLE_WRAP_SELECTOR}, ${CODE_SCROLL_SELECTOR}`;

const positions = new Map<string, number>();
const interacting = new WeakSet<Element>();

function scrollHint(target: Element): string {
  if (target.matches(TABLE_WRAP_SELECTOR)) {
    return target.querySelector('th, td')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 48) ?? '';
  }
  return target.textContent?.replace(/\s+/g, ' ').trim().slice(0, 48) ?? '';
}

export function tableWrapKey(owner: string, wrap: Element, index: number): string {
  return `${owner}:${index}:${scrollHint(wrap)}`;
}

function eachScrollTarget(root: ParentNode, fn: (target: HTMLElement, index: number) => void): void {
  root.querySelectorAll(OVERFLOW_SCROLL_SELECTOR).forEach((node, index) => {
    if (node instanceof HTMLElement) fn(node, index);
  });
}

function isOverflowScrollTarget(node: EventTarget | null): node is HTMLElement {
  return node instanceof HTMLElement && node.matches(OVERFLOW_SCROLL_SELECTOR);
}

export function persistTableWrapScroll(owner: string, root: ParentNode): void {
  eachScrollTarget(root, (target, index) => {
    positions.set(tableWrapKey(owner, target, index), target.scrollLeft);
  });
}

export function restoreTableWrapScroll(owner: string, root: ParentNode): void {
  eachScrollTarget(root, (target, index) => {
    const left = positions.get(tableWrapKey(owner, target, index));
    if (left == null || target.scrollLeft === left) return;
    target.scrollLeft = left;
  });
}

/** True when the wheel was consumed as horizontal scroll on a table/code block. */
export function steerWheelToTable(event: WheelEvent, root: ParentNode): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const scrollTarget = target.closest(OVERFLOW_SCROLL_SELECTOR);
  if (!(scrollTarget instanceof HTMLElement) || !root.contains(scrollTarget)) return false;
  if (scrollTarget.scrollWidth <= scrollTarget.clientWidth + 1) return false;
  // Trackpads already emit deltaX for a horizontal swipe — leave those native.
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return false;
  if (event.deltaY === 0) return false;
  scrollTarget.scrollLeft += event.deltaY;
  return true;
}

function overflowingTargetFromEvent(event: Event, root: ParentNode): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const scrollTarget = target.closest(OVERFLOW_SCROLL_SELECTOR);
  if (!(scrollTarget instanceof HTMLElement) || !root.contains(scrollTarget)) return null;
  if (scrollTarget.scrollWidth <= scrollTarget.clientWidth + 1) return null;
  return scrollTarget;
}

/**
 * Bind wheel-to-horizontal, user-driven persist, and ancestor-scroll restore.
 * Returns an unbind function.
 */
export function attachTableScroll(owner: string, root: HTMLElement): () => void {
  restoreTableWrapScroll(owner, root);

  const onWheel = (event: WheelEvent) => {
    const scrollTarget = overflowingTargetFromEvent(event, root);
    const steered = steerWheelToTable(event, root);
    if (steered) event.preventDefault();
    if (scrollTarget || steered) persistTableWrapScroll(owner, root);
  };

  const onPointerDown = (event: PointerEvent) => {
    const scrollTarget = overflowingTargetFromEvent(event, root);
    if (scrollTarget) interacting.add(scrollTarget);
  };

  const clearInteracting = () => {
    eachScrollTarget(root, (target) => interacting.delete(target));
  };

  const onTargetScroll = (event: Event) => {
    if (!isOverflowScrollTarget(event.target) || !interacting.has(event.target)) return;
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
    if (isOverflowScrollTarget(event.target)) return;
    restoreSoon();
  };

  const scroller =
    root.closest('[data-conversation-scroller]') ??
    root.closest('[data-virtuoso-scroller]') ??
    root.closest('.conversation-scroll');

  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('scroll', onTargetScroll, true);
  window.addEventListener('pointerup', clearInteracting);
  window.addEventListener('pointercancel', clearInteracting);
  scroller?.addEventListener('scroll', onAncestorScroll, { capture: true, passive: true });

  return () => {
    if (raf !== 0) window.cancelAnimationFrame(raf);
    root.removeEventListener('wheel', onWheel);
    root.removeEventListener('pointerdown', onPointerDown);
    root.removeEventListener('scroll', onTargetScroll, true);
    window.removeEventListener('pointerup', clearInteracting);
    window.removeEventListener('pointercancel', clearInteracting);
    scroller?.removeEventListener('scroll', onAncestorScroll, true);
  };
}

export function __resetTableScrollForTests(): void {
  positions.clear();
}
