// The hero demo: five steps that replay the real app. Vanilla, no framework runtime.
//
// One clock drives everything. Each step schedules its beats as cues on the step's own timeline
// (`later`), typing is derived from the same elapsed time, and the tab's progress bar is that time
// over STEP_MS. The clock only runs while the demo is playing, on screen, in a visible tab, not
// hovered (with a fine pointer) and without keyboard focus inside it, so pausing freezes the
// step mid-beat and resuming carries on from there.
//
// Reduced motion: nothing autoplays and every step shows its end state at once (the CSS keeps
// short opacity fades and drops movement). The Play button still starts it on request.
import { DEMO_STEPS } from "./demo-steps.ts";

const STEP_MS = 7000;
/** Typing speed for chat messages and the widget description, in ms per character. */
const TYPE_MS = 26;
const DESCRIBE_TYPE_MS = 34;

interface Cue {
  at: number;
  run: () => void;
}
interface Typing {
  el: HTMLElement;
  text: string;
  start: number;
  speed: number;
}

function must<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`demo: missing ${selector}`);
  return el;
}

/** Adds `in` on the frame after next, so a just-inserted element transitions in. */
function enter(el: Element) {
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("in")));
}

export function startDemo(root: HTMLElement) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;

  const tablist = must<HTMLElement>(root, '[role="tablist"]');
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const bars = tabs.map((tab) => must<HTMLElement>(tab, ".prog"));
  const screen = must<HTMLElement>(root, '[role="tabpanel"]');
  const frameEl = must<HTMLElement>(root, ".chrome");
  const stage = must<HTMLElement>(root, "[data-stage]");
  const panel = must<HTMLElement>(root, "[data-panel]");
  const messages = must<HTMLElement>(root, "[data-messages]");
  const toast = must<HTMLElement>(root, "[data-toast]");
  const badge = must<HTMLElement>(root, "[data-badge]");
  const cursor = must<SVGElement>(root, "[data-cursor]");
  const live = must<HTMLElement>(root, "[data-live]");
  const playButton = must<HTMLButtonElement>(root, "[data-playpause]");
  const orgTable = must<HTMLElement>(root, "[data-orgtable]");
  const chart = must<HTMLElement>(root, "[data-bars]");
  const widget = must<HTMLElement>(root, "[data-widget]");
  const describe = must<HTMLElement>(root, "[data-describe]");
  const runTest = must<HTMLElement>(root, "[data-runtest]");
  const testRun = must<HTMLElement>(root, ".testrun");
  const approval = must<HTMLElement>(root, "[data-approval]");
  const approve = must<HTMLElement>(root, "[data-approve]");
  const nodes = [...root.querySelectorAll<HTMLElement>(".node")];
  const scenes = [...root.querySelectorAll<HTMLElement>("[data-scene]")];
  const navItems = [...root.querySelectorAll<HTMLElement>(".a-side .it")];

  // The clock and the current step's timeline.
  let current = 0;
  let elapsed = 0;
  let base = 0;
  let cues: Cue[] = [];
  let typing: Typing[] = [];
  let raf = 0;
  let last = 0;
  // Why the clock may be stopped.
  let playing = !reduce;
  let onScreen = true;
  let pageVisible = !document.hidden;
  let hovered = false;
  let focused = false;

  /** Schedules `run` `ms` after the current beat (or the step's start). */
  function later(ms: number, run: () => void) {
    cues.push({ at: base + ms, run });
    cues.sort((a, b) => a.at - b.at);
  }

  /** Runs every cue due by `to` and brings typing up to date. `Infinity` shows the end state. */
  function advance(to: number) {
    for (let cue = cues[0]; cue && cue.at <= to; cue = cues[0]) {
      cues.shift();
      base = cue.at;
      cue.run();
    }
    base = to;
    for (const t of typing) {
      const chars = Math.floor((to - t.start) / t.speed) + 1;
      t.el.textContent = t.text.slice(0, Math.max(0, chars));
    }
  }

  function typeInto(el: HTMLElement, text: string, speed: number, done?: () => void) {
    const t: Typing = { el, text, start: base, speed };
    typing.push(t);
    el.textContent = "";
    el.classList.add("caret");
    later(text.length * speed, () => {
      typing = typing.filter((other) => other !== t);
      el.textContent = text;
      el.classList.remove("caret");
      done?.();
    });
  }

  function bubble(kind: "u" | "a", content: string, opts: { type?: boolean } = {}) {
    const el = document.createElement("div");
    el.className = `bub ${kind}`;
    messages.append(el);
    enter(el);
    if (opts.type) typeInto(el, content, TYPE_MS);
    else el.innerHTML = content;
    return el;
  }

  function thinking(ms: number, then: () => void) {
    const el = bubble("a", '<span class="thinking"><i></i><i></i><i></i></span>');
    el.classList.add("wait");
    later(ms, () => {
      el.remove();
      then();
    });
  }

  function moveCursor(target: HTMLElement, click: () => void) {
    if (reduce) {
      click();
      return;
    }
    const s = stage.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    cursor.classList.add("in");
    const x = r.left - s.left + r.width * 0.55;
    const y = r.top - s.top + r.height * 0.55;
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    later(750, () => {
      target.classList.add("pressed");
      later(140, () => {
        target.classList.remove("pressed");
        click();
      });
    });
  }

  const nav = (key: string) => {
    for (const item of navItems) item.classList.toggle("on", item.dataset.nav === key);
  };
  const scene = (key: string) => {
    for (const el of scenes) el.classList.toggle("on", el.dataset.scene === key);
  };

  function reset() {
    cues = [];
    typing = [];
    messages.replaceChildren();
    panel.classList.remove("open");
    toast.classList.remove("in");
    orgTable.classList.remove("show");
    chart.classList.remove("grow");
    widget.classList.remove("in");
    for (const node of nodes) node.classList.remove("in");
    testRun.classList.remove("in");
    describe.textContent = "";
    describe.classList.remove("caret");
    approval.classList.remove("done");
    badge.textContent = "3";
    cursor.classList.remove("in");
    cursor.style.transform = "translate(70%, 110%)";
  }

  const steps: Array<() => void> = [
    // Ask
    () => {
      nav("org");
      scene("org");
      later(250, () => panel.classList.add("open"));
      later(600, () =>
        bubble("u", "Which customers haven't heard from us in 60 days?", { type: true }),
      );
      later(2300, () =>
        thinking(700, () =>
          bubble(
            "a",
            'Four organisations, oldest first:<div class="mini"><div><span>Marlow Studios</span><small>94 days · email</small></div><div><span>Juniper Outdoor</span><small>81 days · call</small></div><div><span>Northwind Dental</span><small>67 days · meeting</small></div><div><span>Corvid Analytics</span><small>62 days · email</small></div></div>',
          ),
        ),
      );
    },
    // Shape
    () => {
      nav("org");
      scene("org");
      panel.classList.add("open");
      later(300, () => bubble("u", "Add a renewal date to organisations.", { type: true }));
      later(1600, () =>
        thinking(600, () =>
          bubble(
            "a",
            "Drafted a <b>Renewal date</b> field and filled it from your contract notes. It is waiting for your approval, and you can see it as a preview now.",
          ),
        ),
      );
      later(3600, () => {
        panel.classList.remove("open");
        later(200, () => orgTable.classList.add("show"));
      });
    },
    // See
    () => {
      nav("dash");
      scene("dash");
      later(300, () =>
        typeInto(describe, "Open deal value by stage, this quarter", DESCRIBE_TYPE_MS, () =>
          later(350, () => {
            widget.classList.add("in");
            later(200, () => chart.classList.add("grow"));
          }),
        ),
      );
    },
    // Automate
    () => {
      nav("auto");
      scene("auto");
      nodes.forEach((node, j) => {
        later(300 + j * 450, () => node.classList.add("in"));
      });
      later(1900, () => moveCursor(runTest, () => testRun.classList.add("in")));
    },
    // Approve
    () => {
      nav("appr");
      scene("appr");
      later(1200, () =>
        moveCursor(approve, () => {
          approval.classList.add("done");
          toast.classList.add("in");
          badge.textContent = "0";
        }),
      );
    },
  ];

  /** Keeps the selected tab in view when the tablist scrolls sideways (narrow screens). */
  function revealTab(tab: HTMLElement) {
    if (tablist.scrollWidth <= tablist.clientWidth) return;
    const t = tab.getBoundingClientRect();
    const l = tablist.getBoundingClientRect();
    if (t.left >= l.left && t.right <= l.right) return;
    tablist.scrollTo({
      left: tablist.scrollLeft + t.left - l.left,
      behavior: reduce ? "auto" : "smooth",
    });
  }

  /**
   * Shows step `i` from its start. A step the visitor picked is announced; while autoplaying the
   * live region stays quiet so it doesn't talk over them every few seconds.
   */
  function select(i: number, opts: { focus?: boolean; user?: boolean } = {}) {
    const tab = tabs[i];
    const step = steps[i];
    if (!tab || !step) return;
    reset();
    current = i;
    elapsed = 0;
    base = 0;
    tabs.forEach((other, j) => {
      const on = j === i;
      other.setAttribute("aria-selected", String(on));
      other.tabIndex = on ? 0 : -1;
    });
    for (const bar of bars) bar.style.transform = "scaleX(0)";
    if (opts.focus) tab.focus();
    screen.setAttribute("aria-labelledby", tab.id);
    live.setAttribute("aria-live", opts.user || !playing ? "polite" : "off");
    live.textContent = DEMO_STEPS[i]?.description ?? "";
    revealTab(tab);
    step();
    if (reduce) advance(Number.POSITIVE_INFINITY);
  }

  const running = () => playing && onScreen && pageVisible && !hovered && !focused;

  function frame(now: number) {
    if (!running()) {
      raf = 0;
      return;
    }
    // Clamp the step so a long frame (a busy main thread) doesn't skip beats.
    const dt = last ? Math.min(now - last, 100) : 0;
    last = now;
    elapsed += dt;
    const bar = bars[current];
    if (bar) bar.style.transform = `scaleX(${Math.min(1, elapsed / STEP_MS)})`;
    if (elapsed >= STEP_MS) select((current + 1) % steps.length);
    else advance(elapsed);
    raf = requestAnimationFrame(frame);
  }

  /** Starts the clock if nothing is holding it. */
  function update() {
    if (running() && !raf) {
      last = 0;
      raf = requestAnimationFrame(frame);
    }
  }

  function setPlaying(next: boolean) {
    playing = next;
    playButton.setAttribute("aria-label", next ? "Pause the demo" : "Play the demo");
    playButton.querySelector("use")?.setAttribute("href", next ? "#i-pause" : "#i-play");
    const label = playButton.querySelector("span");
    if (label) label.textContent = next ? "Pause" : "Play";
    update();
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(i, { user: true }));
    tab.addEventListener("keydown", (event) => {
      const n = steps.length;
      const to =
        event.key === "ArrowRight"
          ? (i + 1) % n
          : event.key === "ArrowLeft"
            ? (i - 1 + n) % n
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? n - 1
                : -1;
      if (to < 0) return;
      event.preventDefault();
      select(to, { focus: true, user: true });
    });
  });

  if (finePointer) {
    frameEl.addEventListener("mouseenter", () => {
      hovered = true;
    });
    frameEl.addEventListener("mouseleave", () => {
      hovered = false;
      update();
    });
  }

  // Keyboard focus in the tabs or the screen holds the demo still (WAI-ARIA carousel pattern).
  // A mouse click on a tab doesn't: it isn't :focus-visible.
  for (const el of [tablist, screen]) {
    el.addEventListener("focusin", (event) => {
      if (event.target instanceof Element && event.target.matches(":focus-visible")) {
        focused = true;
      }
    });
    el.addEventListener("focusout", (event) => {
      const next = event.relatedTarget;
      if (next instanceof Node && (tablist.contains(next) || screen.contains(next))) return;
      focused = false;
      update();
    });
  }

  // Any part on screen counts: on a laptop only the tabs show above the fold, and their progress
  // bars should already be moving.
  new IntersectionObserver(([entry]) => {
    onScreen = entry?.isIntersecting ?? true;
    update();
  }).observe(root);

  document.addEventListener("visibilitychange", () => {
    pageVisible = !document.hidden;
    update();
  });

  playButton.addEventListener("click", () => setPlaying(!playing));

  root.dataset.ready = "true";
  select(0);
  setPlaying(playing);
}
