import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildTaskUrl,
  parseGitHubRepoUrl,
} from "./github.js";

describe("parseGitHubRepoUrl", () => {
  it("parses https GitHub URLs", () => {
    expect(parseGitHubRepoUrl("https://github.com/openai/the-foundry.git")).toEqual({
      owner: "openai",
      repo: "the-foundry",
    });
  });

  it("parses ssh GitHub URLs", () => {
    expect(parseGitHubRepoUrl("git@github.com:openai/the-foundry.git")).toEqual({
      owner: "openai",
      repo: "the-foundry",
    });
  });

  it("returns null for unsupported URLs", () => {
    expect(parseGitHubRepoUrl("https://example.com/openai/the-foundry")).toBeNull();
  });
});

describe("buildTaskUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the configured Foundry app URL", () => {
    vi.stubEnv("FOUNDRY_APP_URL", "https://foundry.example.com/app");
    expect(buildTaskUrl("task-123")).toBe("https://foundry.example.com/tasks/task-123");
  });

  it("falls back to localhost", () => {
    vi.stubEnv("FOUNDRY_APP_URL", "");
    expect(buildTaskUrl("task-123")).toBe("http://localhost:3000/tasks/task-123");
  });
});
