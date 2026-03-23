export interface TaskClaimResponse {
  taskId: number | null;
  runId: number | null;
}

export interface RunCompletionInput {
  runId: number;
  ciPassed: boolean;
  reviewPassed: boolean;
  failureReason?: string;
  artifacts?: Array<{
    artifactKey: string;
    location: string;
  }>;
}

export interface WorkerApiClient {
  claimTask(): Promise<TaskClaimResponse>;
  completeRun(input: RunCompletionInput): Promise<void>;
}

interface HttpClientDependencies {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface RequestInitLike {
  method: "POST";
  headers: Record<string, string>;
  body?: string;
}

async function postJson<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const init: RequestInitLike = {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  };

  const response = await fetchImpl(`${baseUrl}${path}`, init);
  if (!response.ok) {
    throw new Error(`http_${response.status}_${path}`);
  }

  return (await response.json()) as T;
}

export function createHttpWorkerApiClient(
  dependencies: HttpClientDependencies = {},
): WorkerApiClient {
  const baseUrl = (dependencies.baseUrl ?? "http://localhost:3000").replace(/\/$/, "");
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  return {
    async claimTask(): Promise<TaskClaimResponse> {
      return postJson<TaskClaimResponse>(fetchImpl, baseUrl, "/api/tasks/claim");
    },
    async completeRun(input: RunCompletionInput): Promise<void> {
      await postJson<Record<string, unknown>>(fetchImpl, baseUrl, `/api/runs/${input.runId}/complete`, {
        ciPassed: input.ciPassed,
        reviewPassed: input.reviewPassed,
        failureReason: input.failureReason,
        artifacts: input.artifacts ?? [],
      });
    },
  };
}