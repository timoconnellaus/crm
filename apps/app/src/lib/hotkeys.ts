// Single-key and modifier shortcuts (Cmd-K, `c`, `/`, `j`/`k`, `e`, `?`). Plain keys are ignored
// while the user is typing in a field or while a dialog or menu is open, so they never steal input.
import { useEffect, useRef } from "react";

export interface HotkeyOptions {
  /** Off while false. */
  enabled?: boolean;
  /** Also fire while typing in a field or with a dialog open (Cmd-K). */
  global?: boolean;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset"].includes(type);
  }
  return target.getAttribute("role") === "combobox";
}

/** True while a modal dialog, popover or menu is open: plain-key shortcuts stay quiet. */
export function overlayOpen(): boolean {
  return Boolean(
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
    ),
  );
}

/**
 * Matches "mod+k", "?", "j", "enter". `mod` is Cmd on macOS and Ctrl elsewhere; both are
 * accepted so tests and non-Mac keyboards behave the same.
 */
export function matchesHotkey(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">,
  combo: string,
): boolean {
  const parts = combo.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  const mod = parts.includes("mod");
  if (mod !== (event.metaKey || event.ctrlKey)) return false;
  if (event.altKey) return false;
  return event.key.toLowerCase() === key;
}

/** Calls `handler` when `combo` (or any of several) is pressed anywhere on the page. */
export function useHotkey(
  combo: string | string[],
  handler: (event: KeyboardEvent) => void,
  { enabled = true, global = false }: HotkeyOptions = {},
): void {
  const ref = useRef(handler);
  ref.current = handler;
  const key = (Array.isArray(combo) ? combo : [combo]).join("|");

  useEffect(() => {
    if (!enabled) return;
    const list = key.split("|");
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (!list.some((c) => matchesHotkey(event, c))) return;
      if (!global && (isTypingTarget(event.target) || overlayOpen())) return;
      event.preventDefault();
      ref.current(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, enabled, global]);
}
