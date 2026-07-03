import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, "..");
const src = resolve(serverRoot, "src/onboarding-assets");
const dest = resolve(serverRoot, "dist/onboarding-assets");

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });

console.log(`Copied onboarding assets: ${src} -> ${dest}`);
