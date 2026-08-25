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
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new ServiceError(path, res.status, await res.text());
    return (await res.json()) as T;
  }

  async postJSON<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ServiceError(path, res.status, await res.text());
    return (await res.json()) as T;
  }

  async delete(path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, { method: "DELETE" });
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
