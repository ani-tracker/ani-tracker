import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState
} from "react";

/** 计算虚拟列表在共享滚动容器中的真实起点，并持续跟踪布局变化。 */
export function useVirtualizerScrollMargin(
  scrollContainerRef: MutableRefObject<HTMLElement | null>,
  listRef: MutableRefObject<HTMLElement | null>
): number {
  const [scrollMargin, setScrollMargin] = useState(0);

  const updateScrollMargin = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    const list = listRef.current;
    if (!scrollContainer || !list) return;
    const nextMargin = Math.max(
      0,
      list.getBoundingClientRect().top
        - scrollContainer.getBoundingClientRect().top
        + scrollContainer.scrollTop
    );
    setScrollMargin((current) => Math.abs(current - nextMargin) < 0.5 ? current : nextMargin);
  }, [listRef, scrollContainerRef]);

  useLayoutEffect(updateScrollMargin);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    const list = listRef.current;
    if (!scrollContainer || !list) return;

    const observer = new ResizeObserver(updateScrollMargin);
    observer.observe(scrollContainer);
    observer.observe(list.parentElement ?? list);
    window.addEventListener("resize", updateScrollMargin);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateScrollMargin);
    };
  }, [listRef, scrollContainerRef, updateScrollMargin]);

  return scrollMargin;
}
