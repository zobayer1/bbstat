// Framework-agnostic tool definitions. Deliberately free of any MCP-SDK type
// so the data logic is unit-testable on its own (commit 2) and the SDK only
// shows up at the server boundary (commit 3), which adapts these into
// `server.registerTool` calls and wraps the return value in MCP content.
//
// Each tool is a pure read over the StatsStore: a zod input shape + a handler
// that returns plain JSON-serialisable data. Adding a tool later is one
// `defineTool({...})` + one line in registry.ts.

import type { z } from 'zod';
import type { StatsStore } from '../../dashboard/stats-store.js';

export interface ToolDef<Shape extends z.ZodRawShape> {
  // Stable identifier the agent calls (snake_case, matches MCP conventions).
  name: string;
  // Short human title for tool listings.
  title: string;
  // Description shown to the model — this is what teaches it when/how to call
  // the tool, including how to resolve ids (see contributors.ts).
  description: string;
  // Zod raw shape (object of field schemas). The server validates incoming
  // arguments against `z.object(inputShape)` before invoking the handler, so
  // the handler always receives parsed, defaulted, typed args.
  inputShape: Shape;
  handler: (store: StatsStore, args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>;
}

// Heterogeneous registry element — the specific Shape is erased once a tool
// lands in the array. Safe because the server re-validates args against the
// tool's own inputShape before calling the handler.
export type AnyToolDef = ToolDef<z.ZodRawShape>;

// Identity helper that preserves per-tool arg typing at the definition site
// while erasing it for the registry array.
export function defineTool<Shape extends z.ZodRawShape>(def: ToolDef<Shape>): AnyToolDef {
  return def as unknown as AnyToolDef;
}

// Expected, user-facing failure (unknown id, untracked repo, …). The server
// maps a ToolError to an MCP `isError` result with this message; any OTHER
// thrown error is treated as an internal fault and logged + masked.
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
