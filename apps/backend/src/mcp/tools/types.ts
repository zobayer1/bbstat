// Framework-agnostic tool definitions, deliberately free of any MCP-SDK type so
// the data logic is unit-testable on its own; the SDK only shows up at the
// server boundary (server.ts), which adapts these into registerTool calls.
//
// Each tool is a pure read over the StatsStore: a zod input shape + a handler
// returning JSON-serialisable data.

import type { z } from 'zod';
import type { StatsStore } from '../../dashboard/stats-store.js';

export interface ToolDef<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  // Description shown to the model — teaches it when/how to call the tool,
  // including how to resolve ids (see contributors.ts).
  description: string;
  // The server validates args against z.object(inputShape) before invoking the
  // handler, so the handler always receives parsed, defaulted, typed args.
  inputShape: Shape;
  handler: (store: StatsStore, args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>;
}

// Heterogeneous registry element — the specific Shape is erased once a tool
// lands in the array. Safe because the server re-validates args against the
// tool's own inputShape before calling the handler.
export type AnyToolDef = ToolDef<z.ZodRawShape>;

// Preserves per-tool arg typing at the definition site while erasing it for the
// registry array.
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
