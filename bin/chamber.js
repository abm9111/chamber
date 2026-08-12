#!/usr/bin/env node
// Plain JavaScript on purpose. This file must parse on ANY Node version so it
// can explain the floor instead of dying on TypeScript syntax: npm's `engines`
// field only warns, and a .ts bin on Node <23.6 fails with a raw SyntaxError
// before a single line of ours runs. A guard inside src/cli.ts can never fire
// for the users who need it most.
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
