// src/acp/client.ts — ACP JSON-RPC 2.0 client over the dsh stdio transport.
//
// No runtime dependency: the wire format is newline-delimited JSON-RPC and the
// surface we need is small and fully characterised (see types.ts). Pulling in an
// SDK would buy framing we can write in ~40 lines, at the cost of a supply chain.
//
// Transport invariant the agent guarantees: stdout carries protocol frames only,
// so every stdout line is a frame and every diagnostic goes to stderr.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

/** A JSON-RPC id we issued and are still awaiting. */
interface Pending {
  resolve(result: unknown): void;
  reject(err: Error): void;
}

/** Handler for an agent → client request; its return value becomes the RPC result. */
export type ReverseHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

export interface AcpClientOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Diagnostics sink (agent stderr, lifecycle, protocol errors). */
  log(line: string): void;
}

/**
 * Owns one `dsh --profile acp` child process and the JSON-RPC conversation with it.
 *
 * Events:
 *   'notification' (method, params) — agent → client, no id (e.g. session/update)
 *   'exit'         (code)           — the child died; every pending call is rejected
 */
export class AcpClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private stdoutBuf = '';
  private reverse: ReverseHandler | null = null;
  private exited = false;

  constructor(private readonly opts: AcpClientOptions) {
    super();
  }

  /** Registers the handler for agent → client requests (permission prompts, etc.). */
  onRequest(handler: ReverseHandler): void {
    this.reverse = handler;
  }

  get running(): boolean {
    return this.child !== null && !this.exited;
  }

  /**
   * Spawns the agent. Rejects synchronously-detectable failures (ENOENT) via the
   * 'error' event rather than throwing, so callers see one consistent failure path.
   */
  start(): void {
    if (this.child) return;
    this.exited = false;
    const child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // No shell: argv is passed as an array so nothing in cwd or config is ever
      // interpreted by a shell.
      shell: false,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.opts.log(`[agent stderr] ${chunk.trimEnd()}`));

    child.on('error', (err) => {
      this.opts.log(`[agent error] ${err.message}`);
      this.failAll(err);
    });
    child.on('exit', (code) => {
      this.exited = true;
      this.child = null;
      this.opts.log(`[agent exit] code=${code ?? 'null'}`);
      this.failAll(new Error(`dsh agent exited (code ${code ?? 'unknown'})`));
      this.emit('exit', code);
    });
  }

  /** Splits the stdout stream into newline-delimited frames and dispatches each. */
  private consume(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line === '') continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A non-JSON stdout line breaks the transport contract; surface it rather
        // than silently dropping, since it usually means a plugin polluted stdout.
        this.opts.log(`[protocol] non-JSON stdout frame: ${line.slice(0, 200)}`);
        continue;
      }
      void this.dispatch(frame);
    }
  }

  private async dispatch(frame: Record<string, unknown>): Promise<void> {
    const id = frame.id as number | undefined;
    const method = frame.method as string | undefined;

    // Agent → client request: has both a method and an id, and needs a reply.
    if (method !== undefined && id !== undefined) {
      let result: unknown = {};
      try {
        result = this.reverse ? await this.reverse(method, frame.params) : {};
      } catch (err) {
        this.write({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err) } });
        return;
      }
      this.write({ jsonrpc: '2.0', id, result });
      return;
    }

    // Agent → client notification: a method with no id.
    if (method !== undefined) {
      this.emit('notification', method, frame.params);
      return;
    }

    // Response to something we sent.
    if (id !== undefined) {
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      if (frame.error) {
        const e = frame.error as { code?: number; message?: string };
        waiter.reject(new Error(`ACP error ${e.code ?? '?'}: ${e.message ?? 'unknown'}`));
      } else {
        waiter.resolve(frame.result);
      }
    }
  }

  /** Issues a request and resolves with its result. */
  request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.child) return Promise.reject(new Error('dsh agent is not running'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      this.write({ jsonrpc: '2.0', id, method, params: params ?? {} });
    });
  }

  /** Fire-and-forget notification (client → agent). */
  notify(method: string, params?: unknown): void {
    if (!this.child) return;
    this.write({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  private write(frame: unknown): void {
    this.child?.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private failAll(err: Error): void {
    for (const [, waiter] of this.pending) waiter.reject(err);
    this.pending.clear();
  }

  /**
   * Closes stdin, which the agent binds to a bounded graceful shutdown, then
   * escalates if it does not exit. SIGKILL only after SIGTERM has had a chance.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // stdin may already be closed; the signals below still apply.
    }
    const exited = await this.waitForExit(1500);
    if (exited) return;
    child.kill('SIGTERM');
    if (await this.waitForExit(1500)) return;
    child.kill('SIGKILL');
  }

  private waitForExit(ms: number): Promise<boolean> {
    if (!this.child) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
