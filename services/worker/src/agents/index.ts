import { orchestrator } from "./orchestrator.js";
import { planner } from "./planner.js";
import { implementer } from "./implementer.js";
import { reviewer } from "./reviewer.js";

export function loadAgents() {
  return [orchestrator, planner, implementer, reviewer];
}
