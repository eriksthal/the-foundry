# Agent Contracts

## Purpose

Define implementation requirements for LLM integration in this repository.

## Scope

- This contract applies to all runtime code that issues LLM requests.
- This contract is implementation-focused only (no product behavior or UX requirements).

## Allowed Providers

- Allowed providers are exactly: `codex`, `copilot`.
- No other provider names are permitted in adapter requests.

## Required Routing Through Adapters

- All LLM calls MUST route through adapter modules.
- Approved adapter entrypoints are:
  - `adapters/codex/*`
  - `adapters/copilot/*`
- Direct provider SDK/API usage is explicitly forbidden outside adapter modules.
- Application or shared modules MUST call adapter interfaces, not provider SDK clients.

## Context Payload Contract (Small, Structured)

Adapter calls MUST receive a small, structured context object.

### Context Schema

```ts
interface AdapterContext {
  taskId: string;
  userIntent: string;
  constraints: string[];
  files?: Array<{
    path: string;
    summary: string;
  }>;
  metadata?: Record<string, string | number | boolean>;
}
```

### Context Rules

- Context MUST be JSON-serializable.
- Context MUST avoid raw, large blobs (full transcripts, entire source trees, or binary data).
- `files` entries MUST contain summaries, not full file contents.
- Keep context minimal and relevant to the current request.

## Adapter Request Schema (Required Fields)

Every adapter call MUST include all required fields below.

```ts
interface AdapterRequest {
  provider: "codex" | "copilot";
  model: string;
  prompt: string;
  context: AdapterContext;
  requestId: string;
  timestamp: string; // ISO-8601 UTC
  maxTokens: number;
  temperature: number;
}
```

Required field semantics:

- `provider`: must be `codex` or `copilot`.
- `model`: adapter-supported model identifier.
- `prompt`: final prompt string sent by adapter.
- `context`: structured payload defined above.
- `requestId`: stable trace id for observability.
- `timestamp`: request creation time in ISO-8601 UTC format.
- `maxTokens`: positive integer limit.
- `temperature`: numeric sampling value.

## Adapter Response Schema (Required Fields)

Every adapter response MUST include all required fields below.

```ts
interface AdapterResponse {
  provider: "codex" | "copilot";
  model: string;
  requestId: string;
  outputText: string;
  finishReason: "stop" | "length" | "error";
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  latencyMs: number;
  timestamp: string; // ISO-8601 UTC
}
```

Required field semantics:

- `provider`, `model`, `requestId`: must map to the originating request.
- `outputText`: normalized assistant output.
- `finishReason`: normalized completion status.
- `usage`: token accounting reported by adapter.
- `latencyMs`: end-to-end adapter latency in milliseconds.
- `timestamp`: response completion time in ISO-8601 UTC format.

## Enforcement Requirements

- Code review must reject any direct provider SDK usage outside adapter modules.
- New LLM integration points must use adapter request/response schemas defined in this contract.
- Provider allowlist validation (`codex`, `copilot`) must be enforced before dispatch.
