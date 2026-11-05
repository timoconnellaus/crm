// A fully static build (no adapter): dist/ is served by the ros-marketing Worker as static assets.
// Tailwind runs with the shared theme from @relationship-os/ui, so the page uses the app's tokens.
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://relationshiposcrm.com",
  output: "static",
  trailingSlash: "ignore",
  // No Astro dev toolbar or telemetry-backed extras in the page.
  devToolbar: { enabled: false },
  vite: { plugins: [tailwindcss()] },
});
