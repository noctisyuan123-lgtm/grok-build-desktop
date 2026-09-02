import { describe, expect, it, beforeEach } from 'vitest';
import {
  attachTableScroll,
  persistTableWrapScroll,
  restoreTableWrapScroll,
  steerWheelToTable,
  __resetTableScrollForTests,
} from '../tableScroll';

function tableRoot(
  scrollWidth = 800,
  clientWidth = 200,
): { root: HTMLDivElement; wrap: HTMLDivElement } {
  const root = document.createElement('div');
  const wrap = document.createElement('div');
  wrap.className = 'md-table-wrap';
  wrap.innerHTML = '<table><thead><tr><th>Name</th></tr></thead></table>';
  Object.defineProperty(wrap, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(wrap, 'clientWidth', { configurable: true, value: clientWidth });
  root.appendChild(wrap);
  document.body.appendChild(root);
  return { root, wrap };
}

beforeEach(() => {
  __resetTableScrollForTests();
  document.body.innerHTML = '';
});

describe('tableScroll', () => {
  it('restores a saved horizontal offset after the wrap is recreated', () => {
    const first = tableRoot();
    first.wrap.scrollLeft = 140;
    persistTableWrapScroll('run-a', first.root);
    first.root.remove();

    const second = tableRoot();
    expect(second.wrap.scrollLeft).toBe(0);
    restoreTableWrapScroll('run-a', second.root);
    expect(second.wrap.scrollLeft).toBe(140);
  });

  it('turns a vertical wheel into table horizontal scroll', () => {
    const { root, wrap } = tableRoot();
    wrap.scrollLeft = 10;
    const event = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: wrap });
    expect(steerWheelToTable(event, root)).toBe(true);
    expect(wrap.scrollLeft).toBe(50);
  });

  it('leaves native horizontal swipes and non-overflowing tables alone', () => {
    const wide = tableRoot();
    const swipe = new WheelEvent('wheel', {
      deltaX: 30,
      deltaY: 4,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(swipe, 'target', { value: wide.wrap });
    expect(steerWheelToTable(swipe, wide.root)).toBe(false);

    const narrow = tableRoot(200, 200);
    const vertical = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    Object.defineProperty(vertical, 'target', { value: narrow.wrap });
    expect(steerWheelToTable(vertical, narrow.root)).toBe(false);
  });

  it('does not treat a layout-reset to 0 as the saved position', () => {
    const { root, wrap } = tableRoot();
    wrap.scrollLeft = 140;
    persistTableWrapScroll('run-a', root);
    wrap.scrollLeft = 0;
    restoreTableWrapScroll('run-a', root);
    expect(wrap.scrollLeft).toBe(140);
  });

  it('reapplies the saved offset after the conversation scroller moves', async () => {
    const scroller = document.createElement('div');
    scroller.setAttribute('data-virtuoso-scroller', '');
    const { root, wrap } = tableRoot();
    scroller.appendChild(root);
    document.body.appendChild(scroller);
    wrap.scrollLeft = 90;
    persistTableWrapScroll('run-a', root);
    const detach = attachTableScroll('run-a', root);
    wrap.scrollLeft = 0;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(wrap.scrollLeft).toBe(90);
    detach();
  });
});
