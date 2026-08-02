/**
 * Error-chain rendering — shared by the CLI and anything else that has to
 * print a thrown value it did not construct.
 *
 * Node's `fetch` reports every transport failure as the useless
 * `Error: fetch failed` and hides the real reason — ECONNREFUSED, DNS
 * failure, TLS error — in `err.cause` (or, when several addresses were
 * tried, in an AggregateError's `errors`). Printing only `err.message`
 * throws away the one diagnostic this handler exists to surface.
 *
 * Structural property reads are used instead of `instanceof AggregateError`
 * / typed `.cause` so this stays correct without an ES2021+ lib setting.
 *
 * Two hard rules, because the only caller is a last-chance handler that
 * also sets the process exit code:
 *
 *  1. It must never throw. A thrown value is arbitrary — `throw await
 *     res.json()` is realistic — and `String(Object.create(null))` throws
 *     `TypeError: Cannot convert object to primitive value`, as does an
 *     `Error` whose `message` is a throwing getter. If the formatter
 *     escaped its caller's `.catch`, the exit code would never be set and
 *     a failed run would report success.
 *  2. It must never render `[object Object]`. A plain object thrown by an
 *     HTTP/JSON layer carries the whole diagnostic; `String(value)` erases
 *     it. Non-Error values are rendered with `util.inspect`.
 */

import { inspect } from "node:util";

/** Read a property without letting a throwing getter escape. */
function safeProp(target: object, key: string): unknown {
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Render an arbitrary value as a diagnostic string, without throwing and
 * without collapsing objects to `[object Object]`.
 */
function render(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    if (typeof value === "object" && value !== null) {
      // inspect() does not invoke getters and handles null-prototype
      // objects, cycles, and symbols — all of which defeat String().
      return inspect(value, {
        depth: 3,
        breakLength: Infinity,
        compact: true,
        getters: false,
      });
    }
    return String(value);
  } catch {
    try {
      return inspect(value);
    } catch {
      return `[unrenderable ${typeof value}]`;
    }
  }
}

function chain(err: unknown, depth: number, seen: Set<object>): string[] {
  const prefix = depth === 0 ? "" : `${"  ".repeat(depth)}caused by: `;

  if (typeof err === "object" && err !== null) {
    if (seen.has(err)) return [`${prefix}[circular error reference]`];
    seen.add(err);
  }
  if (!(err instanceof Error)) return [`${prefix}${render(err)}`];

  const rawName = safeProp(err, "name");
  const name = typeof rawName === "string" ? rawName : "Error";
  const rawMessage = safeProp(err, "message");
  const message =
    rawMessage === undefined || rawMessage === null ? "" : render(rawMessage);

  const code = safeProp(err, "code");
  const suffix = typeof code === "string" ? ` (${code})` : "";
  const lines = [`${prefix}${name}: ${message}${suffix}`];

  const nested: unknown[] = [];
  const aggregated = safeProp(err, "errors");
  if (Array.isArray(aggregated)) nested.push(...(aggregated as unknown[]));
  const cause = safeProp(err, "cause");
  if (cause !== undefined && cause !== null) nested.push(cause);

  for (const inner of nested) {
    lines.push(...formatErrorChain(inner, depth + 1, seen));
  }
  return lines;
}

/**
 * Render an error together with its underlying cause chain.
 *
 * Total: every input, including hostile ones, produces lines rather than a
 * throw. Each recursion level is guarded independently, so one
 * unformattable link degrades to a placeholder instead of losing the
 * whole chain.
 */
export function formatErrorChain(
  err: unknown,
  depth = 0,
  seen = new Set<object>(),
): string[] {
  try {
    return chain(err, depth, seen);
  } catch (formatterFailure) {
    const prefix = depth === 0 ? "" : `${"  ".repeat(depth)}caused by: `;
    let why = "unknown";
    try {
      why =
        formatterFailure instanceof Error
          ? formatterFailure.message
          : typeof formatterFailure === "string"
            ? formatterFailure
            : "non-error throw";
    } catch {
      /* even reading .message failed — keep the placeholder */
    }
    return [`${prefix}[unformattable error: ${why}]`];
  }
}
