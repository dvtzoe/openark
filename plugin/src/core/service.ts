// The service's own LLM-backed calls (extraction/reflection/distillation/
// persona_update) default to a 60s timeout (core/llm.py's TaskRunner) — this
// ceiling must stay comfortably above that so a legitimate slow LLM call
// isn't mistaken for a hang. Every request other than health() (which has
// its own short, separate timeout) shares this one, per MODULE_SPEC.md's
// "failures degrade to no-op, never a broken session": without it, a wedged
// service or stalled connection leaves the awaited fetch promise unsettled
// forever, and the calling hook (e.g. the system-prompt injection on every
// turn) never returns.
const REQUEST_TIMEOUT_MS = 90_000;

export class ServiceClient {
  constructor(private baseUrl: string) {}

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getJSON<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new ServiceError(path, res.status, await res.text());
    return (await res.json()) as T;
  }

  async postJSON<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new ServiceError(path, res.status, await res.text());
    return (await res.json()) as T;
  }

  async delete(path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new ServiceError(path, res.status, await res.text());
  }
}

export class ServiceError extends Error {
  constructor(
    public path: string,
    public status: number,
    public body: string,
  ) {
    super(`service ${path} failed: ${status} ${body.slice(0, 200)}`);
  }
}
