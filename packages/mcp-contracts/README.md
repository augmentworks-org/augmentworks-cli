# AugmentWorks MCP read contracts

This package defines the three existing workspace reads used by the AugmentWorks Cursor plugin. A local stdio adapter and an authenticated hosted adapter can use the same input validation and result projections. It has no runtime dependencies and makes no network requests.

| Tool | Input | Projected result |
| --- | --- | --- |
| `list_applications` | Empty object | Application/environment pairs and pinned baselines, including source run IDs |
| `get_run_report` | `run_id` | Saved run status, outcome, bounded failed requirement IDs, coverage and dashboard link |
| `compare_runs` | `candidate_run_id` and exactly one of `baseline_run_id` or `baseline_id` | Comparability, coverage changes and a bounded list of changed or flagged cases |

Use `createReadToolDefinitions(z)` with your MCP SDK's Zod v4 namespace when registering tools. Validate input before I/O, authorize and fetch the saved document in your adapter, then return the projection as MCP `structuredContent` and as JSON text for compatible clients:

```js
import { parseReadToolArgs, projectReadToolResult } from "@augmentworks/mcp-contracts";

const args = parseReadToolArgs(toolName, input);
const document = await readFromAuthorizedWorkspace(toolName, args);
const result = projectReadToolResult(toolName, args, document);
return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
```

The adapter owns credentials, tenant and resource authorization, request timeouts, response byte limits and error handling. Validate candidate and baseline access before comparing. The projection accepts only non-billable read envelopes and exposes counts and bounded summaries; raw transcripts are excluded. Treat names and identifiers as untrusted workspace text.

A hosted adapter can pass `{ expectedWorkspaceId, portalOrigin }` as the fourth argument to `projectReadToolResult`. Take both from trusted deployment and authorization context. A missing or contradictory workspace identity fails the guard. Some legacy comparison documents and empty lists carry no workspace ID. To project those with the guard, the authorized service must establish the workspace independently for **all** resources and pass that verified identity on the result envelope. Client input is never proof of access.

The [synthetic fixture corpus](fixtures/read-v1.json) supplies API inputs and the expected projections for both adapters. Run `npm --prefix packages/mcp-contracts test` in the CLI checkout to exercise the contracts and the packed package. No registry credentials or AugmentWorks account are required. The package is versioned independently from the CLI. Publishing a new CLI release does not publish this package.
