/** Browser API for the diagram store. The dev server proxies these paths to Hono. */

export type LockState = { holder: "agent"; expiresAt: string } | null;

export type ProcessSummary = {
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lock: LockState;
  userActive: boolean;
};

export type ProcessDetails = ProcessSummary & { xml: string };

export type LintIssue = {
  rule: string;
  severity: "error" | "warning" | "info";
  message: string;
  elementId?: string;
};

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : response.statusText;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

export const api = {
  list: () => request<ProcessSummary[]>("/api/processes"),
  get: (id: string) => request<ProcessDetails>(`/api/processes/${id}`),
  create: (name: string) => request<ProcessDetails>("/api/processes", {
    method: "POST",
    body: JSON.stringify({ name }),
  }),
  save: (id: string, xml: string, expectedRevision: number) => request<ProcessDetails>(`/api/processes/${id}`, {
    method: "PUT",
    body: JSON.stringify({ xml, expectedRevision }),
  }),
  rename: (id: string, name: string, expectedRevision: number) => request<ProcessDetails>(`/api/processes/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name, expectedRevision }),
  }),
  remove: (id: string) => request<{ ok: boolean }>(`/api/processes/${id}`, { method: "DELETE" }),
  layout: (id: string, expectedRevision: number) => request<ProcessDetails>(`/api/processes/${id}/layout`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  }),
  validate: (id: string) => request<{ issues: LintIssue[] }>(`/api/processes/${id}/validate`, {
    method: "POST",
    body: JSON.stringify({ profile: "deploy" }),
  }),
  presence: (id: string) => request<{ ok: boolean }>(`/api/processes/${id}/presence`, { method: "POST" }),
};
