import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// index.html at this folder's root; SPA code in web/, Worker code in src/.
export default defineConfig({
  plugins: [react(), cloudflare()],
});
