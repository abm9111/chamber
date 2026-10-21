/**
 * The package version, read from package.json the way `chamber --version`
 * does. `../package.json` resolves from src/ in a clone and from dist/ in the
 * published tarball alike, so a second hand-typed copy of the number cannot
 * drift from the one npm publishes.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function readPackageVersion(): string {
  const path = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version === "") {
    throw new Error(`${path} has no version`);
  }
  return pkg.version;
}
