import { readFileSync } from "fs";

const env = readFileSync(".env", "utf8");
const copilotToken = env.match(/COPILOT_GITHUB_TOKEN=(.+)/)?.[1]?.trim();
const githubToken = env.match(/GITHUB_TOKEN=(.+)/)?.[1]?.trim();

// 1. GitHub AI catalog (models.github.ai)
console.log("=== models.github.ai/catalog/models ===");
try {
  const r = await fetch("https://models.github.ai/catalog/models", {
    headers: { Accept: "application/json", Authorization: `Bearer ${copilotToken}`, "User-Agent": "the-foundry" },
  });
  const data = await r.json();
  const items = Array.isArray(data) ? data : [];
  console.log(`Total: ${items.length}`);
  for (const m of items) {
    const caps = m.capabilities?.join(",") ?? "";
    console.log(`  ${m.id} | ${m.name} | caps: ${caps}`);
  }
} catch (e) {
  console.log("ERR", e.message);
}

// 2. Try Copilot API with GitHub PAT (get Copilot token first)
console.log("\n=== api.githubcopilot.com/models (via session token) ===");
try {
  // Get a Copilot session token from the GitHub API
  const tokenResp = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: { Authorization: `token ${githubToken}`, "User-Agent": "the-foundry", Accept: "application/json" },
  });
  if (tokenResp.ok) {
    const tokenData = await tokenResp.json();
    const copilotSessionToken = tokenData.token;
    const r = await fetch("https://api.githubcopilot.com/models", {
      headers: { Authorization: `Bearer ${copilotSessionToken}`, "User-Agent": "the-foundry", Accept: "application/json" },
    });
    if (r.ok) {
      const data = await r.json();
      const items = data.data ?? data.models ?? (Array.isArray(data) ? data : []);
      console.log(`Total: ${items.length}`);
      for (const m of items) {
        console.log(`  ${m.id} | ${m.name ?? ""} | ${m.version ?? ""}`);
      }
    } else {
      console.log(`Status: ${r.status}`, await r.text().then(t => t.substring(0, 200)));
    }
  } else {
    console.log(`Token endpoint: ${tokenResp.status}`, await tokenResp.text().then(t => t.substring(0, 200)));
  }
} catch (e) {
  console.log("ERR", e.message);
}
