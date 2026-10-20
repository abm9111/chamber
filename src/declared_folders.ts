import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export interface DeclaredFolder {
  /** Absolute path, ~ expanded, realpath when the directory resolves. */
  root: string;
  exclude: string[];
}

function expand(p: string): string {
  const full =
    p === "~" ? homedir() : p.startsWith("~/") ? `${homedir()}${p.slice(1)}` : p;
  const abs = isAbsolute(full) ? full : resolve(full);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

export function parseNotesArgs(
  argv: readonly string[],
): { ok: true; folders: DeclaredFolder[] } | { ok: false; error: string } {
  const args = argv[0] === "mcp" ? argv.slice(1) : argv;
  const folders: DeclaredFolder[] = [];
  let current: DeclaredFolder | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--notes") {
      const value = args[i + 1];
      if (value === undefined || value === "" || value.startsWith("-")) {
        return { ok: false, error: "--notes requires a path" };
      }
      current = { root: expand(value), exclude: [] };
      folders.push(current);
      i += 1;
      continue;
    }
    if (arg === "--exclude" || arg.startsWith("--exclude=")) {
      if (!current) return { ok: false, error: "--exclude before any --notes" };
      const value = arg.startsWith("--exclude=") ? arg.slice("--exclude=".length) : args[i + 1];
      if (value === undefined || value === "" || (!arg.startsWith("--exclude=") && value.startsWith("-"))) {
        return { ok: false, error: "--exclude requires a value" };
      }
      current.exclude.push(value);
      if (!arg.startsWith("--exclude=")) i += 1;
      continue;
    }
    if (arg.startsWith("-")) return { ok: false, error: `unknown flag: ${arg}` };
    return { ok: false, error: `unexpected argument ${JSON.stringify(arg)}` };
  }
  return { ok: true, folders: mergeDeclaredFolders(folders) };
}

export function mergeDeclaredFolders(folders: readonly DeclaredFolder[]): DeclaredFolder[] {
  const byRoot = new Map<string, DeclaredFolder>();
  for (const folder of folders) {
    const key = folder.root;
    const existing = byRoot.get(key);
    if (!existing) {
      byRoot.set(key, { root: folder.root, exclude: [...folder.exclude] });
      continue;
    }
    for (const pattern of folder.exclude) {
      if (!existing.exclude.includes(pattern)) existing.exclude.push(pattern);
    }
  }
  return [...byRoot.values()];
}
