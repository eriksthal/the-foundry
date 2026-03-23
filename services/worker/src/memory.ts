import { prisma } from "@the-foundry/db";

const MEMORY_TOKEN_BUDGET = 2000;

export async function buildMemoryContext(projectId: string): Promise<string> {
  const memories = await prisma.projectMemory.findMany({
    where: {
      projectId,
      isActive: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: [{ confidence: "desc" }, { timesReinforced: "desc" }, { createdAt: "desc" }],
  });

  if (memories.length === 0) return "";

  // Mark memories as used
  const ids = memories.map((m) => m.id);
  await prisma.projectMemory.updateMany({
    where: { id: { in: ids } },
    data: { lastUsedAt: new Date() },
  });

  // Build context with token budget
  let context = "## Project Memory (lessons from previous tasks)\n\n";
  let tokenCount = estimateTokens(context);

  const grouped = {
    MISTAKE: [] as string[],
    CONVENTION: [] as string[],
    PATTERN: [] as string[],
    GOTCHA: [] as string[],
  };

  for (const memory of memories) {
    const entryText = `- ${memory.content}\n`;
    const entryTokens = estimateTokens(entryText);

    if (tokenCount + entryTokens > MEMORY_TOKEN_BUDGET) break;

    grouped[memory.category].push(entryText);
    tokenCount += entryTokens;
  }

  if (grouped.MISTAKE.length > 0) {
    context += "### Known Mistakes — AVOID THESE:\n" + grouped.MISTAKE.join("") + "\n";
  }
  if (grouped.CONVENTION.length > 0) {
    context += "### Project Conventions — FOLLOW THESE:\n" + grouped.CONVENTION.join("") + "\n";
  }
  if (grouped.PATTERN.length > 0) {
    context += "### Established Patterns:\n" + grouped.PATTERN.join("") + "\n";
  }
  if (grouped.GOTCHA.length > 0) {
    context += "### Gotchas:\n" + grouped.GOTCHA.join("") + "\n";
  }

  return context;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}
