import { PassThrough } from "node:stream";
import { deepStrictEqual, strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runCiCommandStep, type CiCommandStepDependencies } from "../src/steps/ci-step.js";

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.emit("close", null, signal);
    return true;
  }
}

function withFakeSpawn(
  configure: (child: FakeChildProcess) => void,
): CiCommandStepDependencies {
  return {
    spawnImpl: () => {
      const child = new FakeChildProcess();
      configure(child);
      return child;
    },
  };
}

test("runCiCommandStep succeeds when command exits with code 0", async () => {
  const result = await runCiCommandStep(
    {
      command: "echo ok",
      timeoutMs: 200,
      maxLogChars: 200,
    },
    withFakeSpawn((child) => {
      queueMicrotask(() => {
        child.stdout.write("lint ok\n");
        child.stderr.write("build ok\n");
        child.emit("close", 0, null);
      });
    }),
  );

  strictEqual(result.ok, true);
  strictEqual(result.failureReason, undefined);
  strictEqual(result.artifacts?.[0]?.artifactKey, "ci.command.log");
  strictEqual(result.artifacts?.[0]?.data.type, "ci.command.log.v1");
  strictEqual(result.artifacts?.[0]?.data.exitCode, 0);
  strictEqual(result.artifacts?.[0]?.data.timedOut, false);
  strictEqual(result.artifacts?.[0]?.data.logTail, "lint ok\nbuild ok\n");
  strictEqual(result.artifacts?.[0]?.data.logTailTruncated, false);
});

test("runCiCommandStep fails when command exits non-zero", async () => {
  const result = await runCiCommandStep(
    {
      command: "exit 2",
      timeoutMs: 200,
      maxLogChars: 200,
    },
    withFakeSpawn((child) => {
      queueMicrotask(() => {
        child.stderr.write("typecheck failed\n");
        child.emit("close", 2, null);
      });
    }),
  );

  strictEqual(result.ok, false);
  strictEqual(result.failureReason, "ci_exit_2");
  strictEqual(result.artifacts?.[0]?.data.exitCode, 2);
  strictEqual(result.artifacts?.[0]?.data.timedOut, false);
});

test("runCiCommandStep fails with timeout and marks artifact", async () => {
  const result = await runCiCommandStep(
    {
      command: "sleep forever",
      timeoutMs: 5,
      maxLogChars: 200,
    },
    withFakeSpawn((child) => {
      queueMicrotask(() => {
        child.stdout.write("running checks\n");
      });
    }),
  );

  strictEqual(result.ok, false);
  strictEqual(result.failureReason, "ci_timeout");
  strictEqual(result.artifacts?.[0]?.data.timedOut, true);
  strictEqual(result.artifacts?.[0]?.data.signal, "SIGTERM");
});

test("runCiCommandStep stores bounded tail when output exceeds max size", async () => {
  const result = await runCiCommandStep(
    {
      command: "print long output",
      timeoutMs: 200,
      maxLogChars: 20,
    },
    withFakeSpawn((child) => {
      queueMicrotask(() => {
        child.stdout.write("0123456789");
        child.stderr.write("abcdefghij");
        child.stdout.write("KLMNOP");
        child.emit("close", 0, null);
      });
    }),
  );

  strictEqual(result.ok, true);
  strictEqual(result.artifacts?.[0]?.data.logTailTruncated, true);
  strictEqual(result.artifacts?.[0]?.data.logTail.length, 20);
  strictEqual(result.artifacts?.[0]?.data.logTail, "6789abcdefghijKLMNOP");
});

test("runCiCommandStep captures spawn errors as failed result", async () => {
  const result = await runCiCommandStep(
    {
      command: "bad-cmd",
      timeoutMs: 200,
      maxLogChars: 200,
    },
    withFakeSpawn((child) => {
      queueMicrotask(() => {
        child.emit("error", new Error("spawn ENOENT"));
      });
    }),
  );

  strictEqual(result.ok, false);
  strictEqual(result.failureReason, "ci_exit_-1");
  strictEqual(
    typeof result.artifacts?.[0]?.data.logTail === "string" &&
      result.artifacts?.[0]?.data.logTail.includes("spawn ENOENT"),
    true,
  );
});

test("runCiCommandStep artifact payload remains deterministic", async () => {
  const result = await runCiCommandStep(
    {
      command: "echo stable",
      timeoutMs: 200,
      maxLogChars: 64,
      cwd: "/tmp",
    },
    withFakeSpawn((child) => {
      queueMicrotask(() => {
        child.stdout.write("stable\n");
        child.emit("close", 0, null);
      });
    }),
  );

  deepStrictEqual(
    {
      artifactKey: result.artifacts?.[0]?.artifactKey,
      type: result.artifacts?.[0]?.data.type,
      command: result.artifacts?.[0]?.data.command,
      cwd: result.artifacts?.[0]?.data.cwd,
      timeoutMs: result.artifacts?.[0]?.data.timeoutMs,
      maxLogChars: result.artifacts?.[0]?.data.maxLogChars,
      exitCode: result.artifacts?.[0]?.data.exitCode,
      signal: result.artifacts?.[0]?.data.signal,
      timedOut: result.artifacts?.[0]?.data.timedOut,
      logTail: result.artifacts?.[0]?.data.logTail,
      logTailTruncated: result.artifacts?.[0]?.data.logTailTruncated,
    },
    {
      artifactKey: "ci.command.log",
      type: "ci.command.log.v1",
      command: "echo stable",
      cwd: "/tmp",
      timeoutMs: 200,
      maxLogChars: 64,
      exitCode: 0,
      signal: null,
      timedOut: false,
      logTail: "stable\n",
      logTailTruncated: false,
    },
  );
});