import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/widget",
    emptyOutDir: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: "src/widget/index.html",
      output: {
        entryFileNames: "app.js",
        assetFileNames: "app.[ext]",
      },
    },
  },
});
