import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// index.html at this folder's root; SPA code in web/, Worker code in src/.
// fixtures/ doubles as the public dir so the intake page can load the sample notices.
export default defineConfig({
  publicDir: "../../fixtures",
  plugins: [react(), cloudflare()],
});
