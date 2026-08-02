/**
 * Import Hermes-style skill markdown (YAML frontmatter + body) into registry.
 * Imported skills are never auto-activated.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { registerSkill } from "./skills_registry.ts";

export interface ImportedSkillMeta {
  name: string;
  description?: string;
  trigger?: string;
  body: string;
  file: string;
}

/** Parse optional YAML-ish frontmatter between --- lines. */
export function parseSkillMarkdown(
  raw: string,
  fallbackName: string,
): ImportedSkillMeta {
  let name = fallbackName;
  let description: string | undefined;
  let trigger: string | undefined;
  let body = raw;

  if (raw.startsWith("---")) {
    const end = raw.indexOf("---", 3);
    if (end > 0) {
      const fm = raw.slice(3, end).trim();
      body = raw.slice(end + 3).trim();
      for (const line of fm.split("\n")) {
        const m = line.match(/^(\w+)\s*:\s*(.*)$/);
        if (!m) continue;
        const k = m[1]!.toLowerCase();
        const v = m[2]!.trim().replace(/^["']|["']$/g, "");
        if (k === "name") name = v;
        if (k === "description") description = v;
        if (k === "trigger" || k === "triggers") trigger = v;
      }
    }
  }
  return { name, description, trigger, body, file: fallbackName };
}

export function importSkillFile(
  db: DatabaseSync,
  filePath: string,
): { ok: boolean; id?: string; status: string; name: string } {
  const raw = readFileSync(filePath, "utf8");
  const base = basename(filePath).replace(/\.(md|markdown|skill)$/i, "");
  const meta = parseSkillMarkdown(raw, base);
  const r = registerSkill(db, {
    name: meta.name,
    body: meta.body,
    description: meta.description,
    triggerPattern: meta.trigger,
    source: "imported",
    activate: true, // queues pending approval
  });
  return {
    ok: r.ok,
    id: r.id,
    status: r.status,
    name: meta.name,
  };
}

export function importSkillDirectory(
  db: DatabaseSync,
  dir: string,
): { imported: number; results: ReturnType<typeof importSkillFile>[] } {
  if (!existsSync(dir)) return { imported: 0, results: [] };
  const results: ReturnType<typeof importSkillFile>[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isFile()) continue;
    if (!/\.(md|markdown|skill)$/i.test(name)) continue;
    results.push(importSkillFile(db, p));
  }
  return { imported: results.filter((r) => r.ok).length, results };
}
