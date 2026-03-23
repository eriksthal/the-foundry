import { type CodexTransport, createCodexAdapter } from "../adapters/codex/codex-adapter.js";
import {
  type CopilotTransport,
  createCopilotAdapter,
} from "../adapters/copilot/copilot-adapter.js";
import { type ProviderRegistry } from "./provider-interface.js";

export type ProviderDependencies = {
  codexTransport?: CodexTransport;
  copilotTransport?: CopilotTransport;
};

const notImplementedCodexTransport: CodexTransport = async function unresolvedCodexTransport(
  _request,
) {
  return {
    success: false,
    error: {
      code: "NOT_IMPLEMENTED",
      message: "codex transport is not configured",
    },
  };
};

const notImplementedCopilotTransport: CopilotTransport = async function unresolvedCopilotTransport(
  _request,
) {
  return {
    success: false,
    error: {
      code: "NOT_IMPLEMENTED",
      message: "copilot transport is not configured",
    },
  };
};

export function createDefaultProviderRegistry(
  dependencies: ProviderDependencies = {},
): ProviderRegistry {
  return {
    codex: createCodexAdapter({
      transport: dependencies.codexTransport ?? notImplementedCodexTransport,
    }),
    copilot: createCopilotAdapter({
      transport: dependencies.copilotTransport ?? notImplementedCopilotTransport,
    }),
  };
}