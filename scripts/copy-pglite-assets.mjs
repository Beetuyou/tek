import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const src = join(root, "node_modules/@electric-sql/pglite/dist");
const dest = join(root, ".vercel/output/functions/__server.func/_libs");
if (!existsSync(dest)) {
  console.log("[pglite] server bundle not present, skip asset copy");
  process.exit(0);
}
for (const name of ["pglite.data", "pglite.wasm", "initdb.wasm"]) {
  copyFileSync(join(src, name), join(dest, name));
}
console.log("[pglite] copied wasm assets next to the server bundle");
