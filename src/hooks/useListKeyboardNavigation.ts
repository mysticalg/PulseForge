import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

export function nextListKey(
  keys: readonly string[],
  activeKey: string | null | undefined,
  direction: -1 | 1,
): string | null {
  if (keys.length === 0) return null;
  const currentIndex = activeKey ? keys.indexOf(activeKey) : -1;
  if (currentIndex < 0) return direction === 1 ? keys[0] : keys[keys.length - 1];
  return keys[Math.min(keys.length - 1, Math.max(0, currentIndex + direction))];
}

function isEditingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  const tagName = element?.tagName?.toLowerCase();
  return element?.isContentEditable === true
    || tagName === "input"
    || tagName === "textarea"
    || tagName === "select"
    || tagName === "button"
    || tagName === "a";
}

interface ListKeyboardNavigationOptions {
  keys: readonly string[];
  activeKey?: string | null;
  onActivate: (key: string) => void;
  global?: boolean;
}

export function useListKeyboardNavigation({
  keys,
  activeKey,
  onActivate,
  global = false,
}: ListKeyboardNavigationOptions) {
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const resolvedActiveKey = activeKey && keys.includes(activeKey) ? activeKey : keys[0] ?? null;

  const move = useCallback((direction: -1 | 1) => {
    const nextKey = nextListKey(keys, resolvedActiveKey, direction);
    if (!nextKey) return;
    onActivate(nextKey);
    window.requestAnimationFrame(() => {
      const row = rowRefs.current.get(nextKey);
      row?.scrollIntoView({ block: "nearest" });
      row?.focus({ preventScroll: true });
    });
  }, [keys, onActivate, resolvedActiveKey]);

  const handleKey = useCallback((event: KeyboardEvent | ReactKeyboardEvent<HTMLElement>, rowTarget = false) => {
    if (event.defaultPrevented || (!rowTarget && isEditingTarget(event.target))) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    move(event.key === "ArrowDown" ? 1 : -1);
  }, [move]);

  useEffect(() => {
    if (!global) return;
    const listener = (event: KeyboardEvent) => handleKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [global, handleKey]);

  const rowProps = (key: string) => ({
    ref: (node: HTMLElement | null) => {
      if (node) rowRefs.current.set(key, node);
      else rowRefs.current.delete(key);
    },
    tabIndex: key === resolvedActiveKey ? 0 : -1,
    "aria-keyshortcuts": "ArrowUp ArrowDown",
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => handleKey(event, event.target === event.currentTarget),
  });

  return { resolvedActiveKey, rowProps };
}
