import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { logger } from '../utils/logger';

/**
 * Registers the bulk_execute tool with the MCP server.
 *
 * This tool allows an AI to batch up to 20 tool calls into a single MCP request,
 * receiving all results in one response. This is especially useful for clients
 * (e.g. Perplexity) that have a hard limit on the number of tool calls per session.
 *
 * Usage example (AI perspective):
 *   bulk_execute({
 *     calls: [
 *       { tool: "read_file_code", args: { path: "src/index.ts" } },
 *       { tool: "list_files_code", args: { path: "src", recursive: false } }
 *     ]
 *   })
 */
export function registerBulkTools(server: McpServer): void {
    server.tool(
        'bulk_execute',
        `Executes multiple tool calls in a single request and returns all results.

        USE THIS TOOL to save tool-call budget. Instead of calling N separate tools,
        pack them all here and get N results back in one shot.

        WHEN TO USE:
        - Checking existence / reading multiple files at once
        - Running several independent operations that don't depend on each other
        - Any situation where you would make 2+ consecutive tool calls with unrelated inputs

        LIMITS:
        - Maximum 20 calls per bulk_execute invocation
        - Each call must specify a valid "tool" name (same names as the normal tools)
        - Each call must include an "args" object matching that tool's expected parameters

        RETURNS: A JSON array where each element is the result (or error) for the
        corresponding call, in the same order as the input.

        IMPORTANT: Results for failed sub-calls contain an "error" field instead of
        "content", but will NOT abort the remaining calls.`,
        {
            calls: z
                .array(
                    z.object({
                        tool: z.string().describe('The name of the tool to call (e.g. "read_file_code")'),
                        args: z.record(z.unknown()).describe('The arguments object for that tool')
                    })
                )
                .min(1)
                .max(20)
                .describe('Array of tool calls to execute. Maximum 20 entries.')
        },
        async ({ calls }): Promise<CallToolResult> => {
            logger.info(`[bulk_execute] Received ${calls.length} sub-call(s)`);

            // We need access to the McpServer's registered tool handlers.
            // The MCP SDK exposes them via (server as any)._registeredTools which is
            // an internal map of { name -> { handler, inputSchema } }.
            // This is the only way to dispatch calls without a separate HTTP round-trip.
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
                        error: `Tool "${tool}" is not registered or not available.`
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
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(results, null, 2)
                    }
                ]
            };
        }
    );
}
