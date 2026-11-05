// Small progressive enhancements for every page. Vanilla, no framework runtime; the site works
// without any of it.
//  - the header's border once the page scrolls
//  - the mobile menu (Escape and link clicks close it)
//  - reveal-on-scroll, once per element
//  - waitlist forms post in the background and show their success message in place

const header = document.querySelector<HTMLElement>("header.site");
if (header) {
  const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

const menuButton = document.querySelector<HTMLButtonElement>(".menu-btn");
const menu = document.getElementById("mm");
if (menuButton && menu) {
  const setOpen = (open: boolean) => {
    menu.classList.toggle("open", open);
    menuButton.setAttribute("aria-expanded", String(open));
    menuButton.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };
  menuButton.addEventListener("click", () => setOpen(!menu.classList.contains("open")));
  for (const link of menu.querySelectorAll("a")) {
    link.addEventListener("click", () => setOpen(false));
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.classList.contains("open")) {
      setOpen(false);
      menuButton.focus();
    }
  });
}

const revealed = document.querySelectorAll(".reveal");
if (revealed.length > 0) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("seen");
        io.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  for (const el of revealed) io.observe(el);
}

const ERRORS: Record<string, string> = {
  invalid: "Please check your email address and try again.",
  rate_limited: "Too many tries just now. Please wait a minute and try again.",
};

for (const form of document.querySelectorAll<HTMLFormElement>("form[data-waitlist]")) {
  const error = document.getElementById(form.getAttribute("aria-describedby") ?? "");
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  const done = form.querySelector<HTMLElement>(".done");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button?.getAttribute("aria-busy") === "true") return;
    button?.setAttribute("aria-busy", "true");
    if (error) error.textContent = "";
    try {
      const response = await fetch(form.action, {
        method: "POST",
        body: new FormData(form),
        headers: { accept: "application/json" },
      });
      const result = (await response.json()) as { ok: boolean; error?: string };
      if (result.ok) {
        form.classList.add("sent");
        done?.focus();
      } else if (error) {
        error.textContent = ERRORS[result.error ?? ""] ?? ERRORS.invalid ?? "";
      }
    } catch {
      // Offline or an unexpected reply: fall back to a normal post, which works without JS.
      HTMLFormElement.prototype.submit.call(form);
    } finally {
      button?.removeAttribute("aria-busy");
    }
  });
}
