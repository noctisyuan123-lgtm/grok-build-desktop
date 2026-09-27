import {
  cloneElement,
  useEffect,
  useRef,
  useState,
  type FocusEventHandler,
  type MouseEventHandler,
  type ReactElement,
  type Ref,
} from 'react';

type AnchorProps = {
  ref?: Ref<HTMLElement>;
  onMouseEnter?: MouseEventHandler;
  onMouseLeave?: MouseEventHandler;
  onFocus?: FocusEventHandler;
  onBlur?: FocusEventHandler;
};

/**
 * Delayed hover bubble, matching DeepSeek Harness sidebar tips:
 * 500ms, placed to the right of the control, no native title popup.
 */
export function HoverTip({
  label,
  delayMs = 500,
  disabled = false,
  children,
}: {
  label: string;
  delayMs?: number;
  disabled?: boolean;
  children: ReactElement<AnchorProps>;
}) {
  const anchor = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [box, setBox] = useState<{ x: number; y: number } | null>(null);

  const clearTimer = () => {
    if (timer.current == null) return;
    clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => () => clearTimer(), []);

  useEffect(() => {
    if (!disabled) return;
    clearTimer();
    setBox(null);
  }, [disabled]);

  const show = () => {
    const el = anchor.current;
    if (!el || disabled) return;
    const rect = el.getBoundingClientRect();
    setBox({ x: rect.right + 10, y: rect.top + rect.height / 2 });
  };

  const childRef = (children as ReactElement<AnchorProps> & { ref?: Ref<HTMLElement> }).ref;

  return (
    <>
      {cloneElement(children, {
        ref: (el: HTMLElement | null) => {
          anchor.current = el;
          if (typeof childRef === 'function') childRef(el);
          else if (childRef && typeof childRef === 'object') childRef.current = el;
        },
        onMouseEnter: (event) => {
          children.props.onMouseEnter?.(event);
          if (disabled) return;
          clearTimer();
          timer.current = setTimeout(() => {
            timer.current = null;
            show();
          }, delayMs);
        },
        onMouseLeave: (event) => {
          children.props.onMouseLeave?.(event);
          clearTimer();
          setBox(null);
        },
        onFocus: (event) => {
          children.props.onFocus?.(event);
          if (!disabled) show();
        },
        onBlur: (event) => {
          children.props.onBlur?.(event);
          clearTimer();
          setBox(null);
        },
      })}
      {box && !disabled ? (
        <span className="dsh-hover-tip" role="tooltip" style={{ left: box.x, top: box.y }}>
          {label}
        </span>
      ) : null}
    </>
  );
}
