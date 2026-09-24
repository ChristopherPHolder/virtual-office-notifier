import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/main.ts",
  platform: "node",
  // discord.js loads these optional native add-ons only if they are installed.
  external: ["zlib-sync", "bufferutil", "utf-8-validate"],
  transform: { target: "node26" },
  output: {
    file: "dist/main.js",
    format: "esm",
    sourcemap: true,
    // discord.js and undici use dynamic imports; keep everything in one file.
    codeSplitting: false,
  },
});
