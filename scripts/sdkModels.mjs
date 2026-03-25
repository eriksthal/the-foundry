import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient();
await client.start();

const models = await client.listModels();
console.log("Available models:", models.length);
for (const m of models) {
  console.log(`  ${m.id} | ${m.name} | reasoning: ${m.capabilities?.supports?.reasoningEffort ?? false}`);
}

await client.stop();
