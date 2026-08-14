#!/usr/bin/env node
// Plain JavaScript on purpose. This file must parse on ANY Node version so it
// can explain the floor instead of dying on TypeScript syntax: npm's `engines`
// field only warns, and a .ts bin on Node <23.6 fails with a raw SyntaxError
// before a single line of ours runs. A guard inside src/cli.ts can never fire
// for the users who need it most.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The npm tarball ships compiled JavaScript in dist/ because current Node
// refuses to strip TypeScript types for files under node_modules — which is
// exactly where npx installs this package (KNOWN_LIMITATIONS entry 18). A
// clone has no dist/ and runs the TypeScript directly, which is where the
// 23.6 floor below actually applies. Checked with existsSync rather than
// try/catch so a genuine crash inside dist is a crash, not a silent
// second run of the source.
const dist = new URL("../dist/cli.js", import.meta.url);
if (existsSync(fileURLToPath(dist))) {
  await import(dist.href);
} else {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 23 || (major === 23 && minor < 6)) {
    console.error(
      `chamber requires Node 23.6 or newer (you are running ${process.versions.node}).`,
    );
    console.error(
      "Chamber runs TypeScript directly via Node's built-in type stripping, which shipped in 23.6.",
    );
    process.exit(1);
  }
  await import("../src/cli.ts");
}
