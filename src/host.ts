/** Everything the runtime needs from the outside world. Swap it to run in Node, the browser, or a test. */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export interface HttpInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface Host {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Must NOT follow redirects itself. The runtime checks every hop against the allow list. */
  fetch(url: string, init: HttpInit): Promise<HttpResponse>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  env(name: string): string | undefined;
}
