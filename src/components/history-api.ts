export class HistoryApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function historyApi<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new HistoryApiError(value.error || "Не удалось выполнить запрос", response.status);
  return value as T;
}
