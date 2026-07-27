import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { logger } from '../utils/logger';

/**
 * Registers two tools:
 *
 * 1. `_instructions` — a meta-tool (underscore prefix so it sorts first alphabetically)
 *    that the AI reads on every session. It contains mandatory behavioral rules,
 *    most importantly: ALWAYS use bulk_execute when doing 2+ independent operations.
 *
 * 2. `bulk_execute` — batches up to 20 tool calls into one MCP request, returning
 *    all results in a single response. Essential for clients with per-session tool-call
 *    limits (e.g. Perplexity: max 20 calls/request).
 */
export function registerBulkTools(server: McpServer): void {

    // -----------------------------------------------------------------------
    // _instructions  (sorts first — AI reads this before any other tool)
    // -----------------------------------------------------------------------
    server.tool(
        '_instructions',
        `## MANDATORY RULES — read before every session

⚠️  THIS CLIENT HAS A HARD LIMIT OF 20 TOOL CALLS PER SESSION.
    Every wasted call brings you closer to the limit and degrades the user experience.

════════════════════════════════════════════════════════
 RULE #1 — ALWAYS USE bulk_execute FOR 2+ INDEPENDENT OPS
════════════════════════════════════════════════════════

Whenever you need to perform TWO OR MORE operations that do NOT depend on
each other's results, you MUST batch them into a single bulk_execute call.

DO THIS:
  bulk_execute({ calls: [
    { tool: "read_file_code",  args: { path: "src/index.ts" } },
    { tool: "read_file_code",  args: { path: "src/utils.ts" } },
    { tool: "list_files_code", args: { path: "src", recursive: false } }
  ]})
  → 1 tool call, 3 results

NOT THIS:
  read_file_code({ path: "src/index.ts" })   ← 1st call
  read_file_code({ path: "src/utils.ts" })   ← 2nd call  (WASTEFUL)
  list_files_code({ path: "src" })           ← 3rd call  (WASTEFUL)
  → 3 tool calls wasted

════════════════════════════════════════════════════════
 RULE #2 — PLAN BEFORE CALLING
════════════════════════════════════════════════════════

Before making ANY tool call, ask yourself:
  "Do I need more than one thing right now?"
  If YES → use bulk_execute.
  If NO  → use the individual tool.

Common patterns that MUST use bulk_execute:
  - Reading multiple files                  → bulk_execute
  - Checking if multiple files/paths exist  → bulk_execute
  - Getting diagnostics + reading a file    → bulk_execute
  - Listing files + reading a file          → bulk_execute
  - Running unrelated shell commands        → NOT supported (shell is interactive, run individually)

════════════════════════════════════════════════════════
 RULE #3 — DO NOT CALL THIS TOOL AGAIN
════════════════════════════════════════════════════════

This tool (_instructions) is informational only. It returns no useful data.
Call it ONCE at session start if you need a reminder. Never call it again.

════════════════════════════════════════════════════════
 AVAILABLE TOOLS SUMMARY
════════════════════════════════════════════════════════

  _instructions       — These rules (this tool). Read once.
  bulk_execute        — Batch up to 20 tool calls. USE THIS.
  read_file_code      — Read a workspace file
  list_files_code     — List files/directories
  move_file_code      — Move a file
  rename_file_code    — Rename a file
  copy_file_code      — Copy a file
  edit tools          — write_file, apply_diff, etc.
  shell tools         — run_in_terminal (interactive, not batchable)
  diagnostics tools   — get_diagnostics, etc.
  symbol tools        — find symbols, references, etc.

All of the above EXCEPT shell tools can be batched inside bulk_execute.`,
        {},
        async (): Promise<CallToolResult> => {
            return {
                content: [{
                    type: 'text',
                    text: 'Instructions acknowledged. Remember: use bulk_execute for all independent multi-step operations to conserve your tool-call budget.'
                }]
            };
        }
    );

    // -----------------------------------------------------------------------
    // bulk_execute
    // -----------------------------------------------------------------------
    server.tool(
        'bulk_execute',
        `Executes up to 20 tool calls in a single request and returns all results.

⚠️  MANDATORY USAGE — See _instructions tool for full rules.

Short version:
  ANY time you need 2+ independent operations, use THIS tool.
  One bulk_execute = one tool call consumed, regardless of how many sub-calls.

EXAMPLE:
  bulk_execute({ calls: [
    { tool: "read_file_code", args: { path: "a.ts" } },
    { tool: "read_file_code", args: { path: "b.ts" } },
    { tool: "list_files_code", args: { path: "src" } }
  ]})
  → Returns array of 3 results in one shot.

LIMITS:
  - min 1, max 20 calls per invocation
  - Each entry: { tool: "<tool_name>", args: { ...params } }
  - Failed sub-calls return { error: "..." } and do NOT abort the rest
  - Shell tools (run_in_terminal) are interactive and cannot be batched

RETURNS:
  JSON array: [ { tool, index, result? } | { tool, index, error? } ]`,
        {
            calls: z
                .array(
                    z.object({
                        tool: z.string().describe('Tool name, e.g. "read_file_code", "list_files_code"'),
                        args: z.record(z.unknown()).describe('Arguments object for that tool')
                    })
                )
                .min(1)
                .max(20)
                .describe('Array of { tool, args } objects to execute. Max 20.')
        },
        async ({ calls }): Promise<CallToolResult> => {
            logger.info(`[bulk_execute] Received ${calls.length} sub-call(s)`);

            const registeredTools: Map<string, { inputSchema: unknown; handler: (args: unknown) => Promise<CallToolResult> }> =
                (server as any)._registeredTools;

            const results: Array<{ tool: string; index: number; result?: unknown; error?: string }> = [];

            for (let i = 0; i < calls.length; i++) {
                const { tool, args } = calls[i];
                logger.info(`[bulk_execute] Executing sub-call ${i + 1}/${calls.length}: ${tool}`);

                if (!registeredTools || !registeredTools.has(tool)) {
                    logger.warn(`[bulk_execute] Tool not found: ${tool}`);
                    results.push({
                        tool,
                        index: i,
                        error: `Tool "${tool}" is not registered or not available. Check _instructions for valid tool names.`
                    });
                    continue;
                }

                try {
                    const toolEntry = registeredTools.get(tool)!;
                    const callResult = await toolEntry.handler(args);
                    results.push({ tool, index: i, result: callResult });
                    logger.info(`[bulk_execute] Sub-call ${i + 1} (${tool}) succeeded`);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    logger.error(`[bulk_execute] Sub-call ${i + 1} (${tool}) failed: ${message}`);
                    results.push({ tool, index: i, error: message });
                }
            }

            logger.info(`[bulk_execute] All ${calls.length} sub-calls complete`);

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(results, null, 2)
                }]
            };
        }
    );
}
