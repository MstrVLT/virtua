import {
  getCurrentDocument,
  getCurrentWindow,
  isIOSWebKit,
  isRTLDocument,
  isSmoothScrollSupported,
} from "./environment";
import {
  ACTION_SCROLL,
  VirtualStore,
  ACTION_SCROLL_END,
  UPDATE_SIZE_STATE,
  ACTION_MANUAL_SCROLL,
  SCROLL_IDLE,
  ACTION_BEFORE_MANUAL_SMOOTH_SCROLL,
} from "./store";
import { ScrollToIndexOpts } from "./types";
import { debounce, timeout, clamp } from "./utils";

/**
 * scrollLeft is negative value in rtl direction.
 *
 * left  right
 * 0     100    spec compliant (ltr)
 * -100  0      spec compliant (rtl)
 * https://github.com/othree/jquery.rtl-scroll-type
 */
const normalizeOffset = (offset: number, isHorizontal: boolean): number => {
  if (isHorizontal && isRTLDocument()) {
    return -offset;
  } else {
    return offset;
  }
};

const createScrollObserver = (
  store: VirtualStore,
  viewport: HTMLElement | Window,
  isHorizontal: boolean,
  getScrollOffset: () => number,
  updateScrollOffset: (value: number, isMomentumScrolling: boolean) => void
) => {
  const now = Date.now;

  let lastScrollTime = 0;
  let wheeling = false;
  let touching = false;
  let justTouchEnded = false;
  let stillMomentumScrolling = false;

  const onScrollEnd = debounce(() => {
    if (wheeling || touching) {
      wheeling = false;

      // Wait while wheeling or touching
      onScrollEnd();
      return;
    }

    justTouchEnded = false;

    store._update(ACTION_SCROLL_END);
  }, 150);

  const onScroll = () => {
    lastScrollTime = now();

    if (justTouchEnded) {
      stillMomentumScrolling = true;
    }

    store._update(ACTION_SCROLL, getScrollOffset());
    onScrollEnd();
  };

  // Infer scroll state also from wheel events
  // Sometimes scroll events do not fire when frame dropped even if the visual have been already scrolled
  const onWheel = ((e: WheelEvent) => {
    if (
      wheeling ||
      // Scroll start should be detected with scroll event
      store._getScrollDirection() === SCROLL_IDLE ||
      // Probably a pinch-to-zoom gesture
      e.ctrlKey
    ) {
      return;
    }

    const timeDelta = now() - lastScrollTime;
    if (
      // Check if wheel event occurs some time after scrolling
      150 > timeDelta &&
      50 < timeDelta &&
      // Get delta before checking deltaMode for firefox behavior
      // https://github.com/w3c/uievents/issues/181#issuecomment-392648065
      // https://bugzilla.mozilla.org/show_bug.cgi?id=1392460#c34
      (isHorizontal ? e.deltaX : e.deltaY)
    ) {
      wheeling = true;
    }
  }) as (e: Event) => void; // FIXME type error. why only here?

  const onTouchStart = () => {
    touching = true;
    justTouchEnded = stillMomentumScrolling = false;
  };
  const onTouchEnd = () => {
    touching = false;
    if (isIOSWebKit()) {
      justTouchEnded = true;
    }
  };

  viewport.addEventListener("scroll", onScroll);
  viewport.addEventListener("wheel", onWheel, { passive: true });
  viewport.addEventListener("touchstart", onTouchStart, { passive: true });
  viewport.addEventListener("touchend", onTouchEnd, { passive: true });

  return {
    _dispose: () => {
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("touchstart", onTouchStart);
      viewport.removeEventListener("touchend", onTouchEnd);
      onScrollEnd._cancel();
    },
    _fixScrollJump: (jump: number) => {
      updateScrollOffset(jump, stillMomentumScrolling);
      stillMomentumScrolling = false;
    },
  };
};

type ScrollObserver = ReturnType<typeof createScrollObserver>;

/**
 * @internal
 */
export type Scroller = {
  _observe: (viewportElement: HTMLElement) => void;
  _dispose(): void;
  _scrollTo: (offset: number) => void;
  _scrollBy: (offset: number) => void;
  _scrollToIndex: (index: number, opts?: ScrollToIndexOpts) => void;
  _fixScrollJump: (jump: number) => void;
};

/**
 * @internal
 */
export const createScroller = (
  store: VirtualStore,
  isHorizontal: boolean
): Scroller => {
  let viewportElement: HTMLElement | undefined;
  let scrollObserver: ScrollObserver | undefined;
  let cancelScroll: (() => void) | undefined;
  const scrollToKey = isHorizontal ? "scrollLeft" : "scrollTop";
  const overflowKey = isHorizontal ? "overflowX" : "overflowY";

  // The given offset will be clamped by browser
  // https://drafts.csswg.org/cssom-view/#dom-element-scrolltop
  const scheduleImperativeScroll = async (
    getTargetOffset: () => number,
    smooth?: boolean
  ) => {
    if (!viewportElement) return;

    if (cancelScroll) {
      // Cancel waiting scrollTo
      cancelScroll();
    }

    const waitForMeasurement = (): [Promise<void>, () => void] => {
      // Wait for the scroll destination items to be measured.
      // The measurement will be done asynchronously and the timing is not predictable so we use promise.
      // For example, ResizeObserver may not fire when window is not visible.
      let queue: (() => void) | undefined;
      return [
        new Promise<void>((resolve, reject) => {
          queue = resolve;
          // Reject when items around scroll destination completely measured
          timeout((cancelScroll = reject), 150);
        }),
        store._subscribe(UPDATE_SIZE_STATE, () => {
          queue && queue();
        }),
      ];
    };

    if (smooth && isSmoothScrollSupported()) {
      while (true) {
        store._update(ACTION_BEFORE_MANUAL_SMOOTH_SCROLL, getTargetOffset());

        if (!store._hasUnmeasuredItemsInFrozenRange()) {
          break;
        }

        const [promise, unsubscribe] = waitForMeasurement();

        try {
          await promise;
        } catch (e) {
          // canceled
          return;
        } finally {
          unsubscribe();
        }
      }

      viewportElement.scrollTo({
        [isHorizontal ? "left" : "top"]: normalizeOffset(
          getTargetOffset(),
          isHorizontal
        ),
        behavior: "smooth",
      });
    } else {
      while (true) {
        const [promise, unsubscribe] = waitForMeasurement();

        try {
          viewportElement[scrollToKey] = normalizeOffset(
            getTargetOffset(),
            isHorizontal
          );
          store._update(ACTION_MANUAL_SCROLL);

          await promise;
        } catch (e) {
          // canceled or finished
          return;
        } finally {
          unsubscribe();
        }
      }
    }
  };

  return {
    _observe(viewport) {
      viewportElement = viewport;

      scrollObserver = createScrollObserver(
        store,
        viewport,
        isHorizontal,
        () => normalizeOffset(viewport[scrollToKey], isHorizontal),
        (jump, isMomentumScrolling) => {
          // If we update scroll position while touching on iOS, the position will be reverted.
          // However iOS WebKit fires touch events only once at the beginning of momentum scrolling.
          // That means we have no reliable way to confirm still touched or not if user touches more than once during momentum scrolling...
          // This is a hack for the suspectable situations, inspired by https://github.com/prud/ios-overflow-scroll-to-top
          if (isMomentumScrolling) {
            const style = viewport.style;
            const prev = style[overflowKey];
            style[overflowKey] = "hidden";
            timeout(() => {
              style[overflowKey] = prev;
            });
          }

          viewport[scrollToKey] += normalizeOffset(jump, isHorizontal);
        }
      );
    },
    _dispose() {
      scrollObserver && scrollObserver._dispose();
    },
    _scrollTo(offset) {
      scheduleImperativeScroll(() => offset);
    },
    _scrollBy(offset) {
      offset += store._getScrollOffset();
      scheduleImperativeScroll(() => offset);
    },
    _scrollToIndex(index, { align, smooth } = {}) {
      index = clamp(index, 0, store._getItemsLength() - 1);

      if (align === "nearest") {
        const itemOffset = store._getItemOffset(index);
        const scrollOffset = store._getScrollOffset();

        if (itemOffset < scrollOffset) {
          align = "start";
        } else if (
          itemOffset + store._getItemSize(index) >
          scrollOffset + store._getViewportSize()
        ) {
          align = "end";
        } else {
          // already completely visible
          return;
        }
      }

      scheduleImperativeScroll(() => {
        return (
          store._getStartSpacerSize() +
          (align === "end"
            ? store._getItemOffset(index) +
              store._getItemSize(index) -
              store._getViewportSize()
            : align === "center"
            ? store._getItemOffset(index) +
              (store._getItemSize(index) - store._getViewportSize()) / 2
            : store._getItemOffset(index))
        );
      }, smooth);
    },
    _fixScrollJump: (jump) => {
      if (!scrollObserver) return;
      scrollObserver._fixScrollJump(jump);
    },
  };
};

/**
 * @internal
 */
export type WindowScroller = {
  _observe(containerElement: HTMLElement): void;
  _dispose(): void;
  _fixScrollJump: (jump: number) => void;
};

/**
 * @internal
 */
export const createWindowScroller = (
  store: VirtualStore,
  isHorizontal: boolean
): WindowScroller => {
  let scrollObserver: ScrollObserver | undefined;

  return {
    _observe(container) {
      const scrollToKey = isHorizontal ? "scrollX" : "scrollY";

      const document = getCurrentDocument(container);
      const window = getCurrentWindow(document);
      const documentBody = document.body;

      const calcOffsetToViewport = (
        node: HTMLElement,
        viewport: HTMLElement,
        isHorizontal: boolean,
        offset: number = 0
      ): number => {
        // TODO calc offset only when it changes (maybe impossible)
        const offsetKey = isHorizontal ? "offsetLeft" : "offsetTop";
        const offsetSum =
          offset +
          (isHorizontal && isRTLDocument()
            ? window.innerWidth - node[offsetKey] - node.offsetWidth
            : node[offsetKey]);

        const parent = node.offsetParent;
        if (node === viewport || !parent) {
          return offsetSum;
        }

        return calcOffsetToViewport(
          parent as HTMLElement,
          viewport,
          isHorizontal,
          offsetSum
        );
      };

      scrollObserver = createScrollObserver(
        store,
        window,
        isHorizontal,
        () =>
          normalizeOffset(window[scrollToKey], isHorizontal) -
          calcOffsetToViewport(container, documentBody, isHorizontal),
        (jump) => {
          // TODO support case two window scrollers exist in the same view
          window.scrollBy(
            isHorizontal ? normalizeOffset(jump, isHorizontal) : 0,
            isHorizontal ? 0 : jump
          );
        }
      );
    },
    _dispose() {
      scrollObserver && scrollObserver._dispose();
    },
    _fixScrollJump: (jump) => {
      if (!scrollObserver) return;
      scrollObserver._fixScrollJump(jump);
    },
  };
};
