import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';

export type ComposerChoice = {
  value: string;
  label: string;
  detail?: string;
};

const MENU_WIDTH = 260;
const FLYOUT_WIDTH = 200;
const MENU_GAP = 8;
const VIEW_PAD = 8;

function viewportSize() {
  const vv = window.visualViewport;
  return {
    width: vv?.width ?? window.innerWidth,
    height: vv?.height ?? window.innerHeight,
    offsetTop: vv?.offsetTop ?? 0,
    offsetLeft: vv?.offsetLeft ?? 0,
  };
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

/** Outer panel: open above the composer controls, right-aligned. */
function placePanelUp(el: HTMLElement, anchor: DOMRect, width: number) {
  const vp = viewportSize();
  let left = anchor.right - width;
  left = clamp(left, vp.offsetLeft + VIEW_PAD, vp.offsetLeft + vp.width - VIEW_PAD - width);
  const maxHeight = Math.max(160, anchor.top - VIEW_PAD - MENU_GAP);
  const bottom = vp.offsetTop + vp.height - anchor.top + MENU_GAP;
  el.style.position = 'fixed';
  el.style.left = `${left}px`;
  el.style.right = 'auto';
  el.style.top = 'auto';
  el.style.bottom = `${bottom}px`;
  el.style.width = `${width}px`;
  el.style.maxHeight = `${maxHeight}px`;
  el.style.overflowY = 'auto';
  el.style.visibility = 'visible';
}

/** Nested options: always open to the right of the field (or left if no room). */
function placeFlyoutRight(el: HTMLElement, anchor: DOMRect, width: number) {
  const vp = viewportSize();
  let left = anchor.right + 6;
  if (left + width > vp.offsetLeft + vp.width - VIEW_PAD) {
    left = anchor.left - 6 - width;
  }
  left = clamp(left, vp.offsetLeft + VIEW_PAD, vp.offsetLeft + vp.width - VIEW_PAD - width);

  let top = anchor.top;
  const maxHeight = Math.max(120, vp.offsetTop + vp.height - VIEW_PAD - top);
  el.style.position = 'fixed';
  el.style.left = `${left}px`;
  el.style.right = 'auto';
  el.style.top = `${top}px`;
  el.style.bottom = 'auto';
  el.style.width = `${width}px`;
  el.style.maxHeight = `${maxHeight}px`;
  el.style.overflowY = 'auto';
  el.style.visibility = 'visible';

  // If the list is shorter than remaining space but would still hang past the
  // bottom after layout, nudge it up so every option stays on-screen.
  requestAnimationFrame(() => {
    const h = el.offsetHeight;
    const limit = vp.offsetTop + vp.height - VIEW_PAD;
    if (top + h > limit) {
      top = Math.max(vp.offsetTop + VIEW_PAD, limit - h);
      el.style.top = `${top}px`;
      el.style.maxHeight = `${Math.max(120, limit - top)}px`;
    }
  });
}

function bindPlace(place: () => void) {
  place();
  requestAnimationFrame(place);
  window.addEventListener('resize', place);
  window.visualViewport?.addEventListener('resize', place);
  window.visualViewport?.addEventListener('scroll', place);
  return () => {
    window.removeEventListener('resize', place);
    window.visualViewport?.removeEventListener('resize', place);
    window.visualViewport?.removeEventListener('scroll', place);
  };
}

export function ComposerMenuSurface({
  id,
  label,
  open,
  anchorRef,
  children,
}: {
  id: string;
  label: string;
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const el = surfaceRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    el.style.visibility = 'hidden';
    return bindPlace(() => placePanelUp(el, anchor.getBoundingClientRect(), MENU_WIDTH));
  }, [open, anchorRef, children]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div ref={surfaceRef} className="cmp-surface" id={id} role="dialog" aria-label={label}>
      {children}
    </div>,
    document.body,
  );
}

export function ComposerChoiceList({
  label,
  value,
  items,
  onChange,
}: {
  label?: string;
  value: string;
  items: readonly ComposerChoice[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="cmp-group" role="listbox" aria-label={label}>
      {label ? <span className="cmp-kicker">{label}</span> : null}
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="option"
            className={selected ? 'cmp-option is-selected' : 'cmp-option'}
            aria-label={item.label}
            aria-selected={selected}
            onClick={() => onChange(item.value)}
          >
            <span className="cmp-option-copy">
              <span className="cmp-option-title">{item.label}</span>
              {item.detail ? <span className="cmp-option-detail">{item.detail}</span> : null}
            </span>
            {selected ? <Check size={13} strokeWidth={2.2} /> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Compact field: shows current value. Options open as a flyout to the right
 * of the field — never flips up/down and never grows the parent panel.
 */
export function ComposerDropdownField({
  label,
  value,
  items,
  open,
  onToggle,
  onChange,
}: {
  label: string;
  value: string;
  items: readonly ComposerChoice[];
  open: boolean;
  onToggle: () => void;
  onChange: (value: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const current = items.find((item) => item.value === value)?.label ?? value;

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const flyout = flyoutRef.current;
    if (!trigger || !flyout) return;
    flyout.style.visibility = 'hidden';
    return bindPlace(() =>
      placeFlyoutRight(flyout, trigger.getBoundingClientRect(), FLYOUT_WIDTH),
    );
  }, [open, items, value]);

  return (
    <div className={open ? 'cmp-dd is-open' : 'cmp-dd'}>
      <button
        ref={triggerRef}
        type="button"
        className="cmp-dd-trigger"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={onToggle}
      >
        <span className="cmp-dd-meta">
          <span className="cmp-dd-label">{label}</span>
          <span className="cmp-dd-value">{current}</span>
        </span>
        <ChevronRight size={13} strokeWidth={2} />
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div ref={flyoutRef} className="cmp-flyout" role="presentation">
              <ComposerChoiceList label={label} value={value} items={items} onChange={onChange} />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export function ComposerMenuButton({
  label,
  title,
  open,
  onToggle,
  children,
  trailing,
}: {
  label: string;
  title?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={open ? 'cmp-trigger is-open' : 'cmp-trigger'}
      aria-label={label}
      title={title}
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="cmp-trigger-label">{children}</span>
      {trailing}
      <ChevronDown size={12} strokeWidth={2} />
    </button>
  );
}

export function useComposerMenu(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (ref.current?.contains(target)) return;
      if (target?.closest?.('.cmp-surface, .cmp-flyout')) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', closeOnPointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open, onClose]);
  return ref;
}
