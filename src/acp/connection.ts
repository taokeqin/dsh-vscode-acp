// src/acp/connection.ts — one dsh agent process, many concurrent ACP sessions.
//
// Replaces the earlier one-session-per-process model. ACP allows it explicitly:
// "One connection can run several sessions at once, each independent." Each editor
// tab binds one sessionId; this class multiplexes them over a single child process
// and routes session/update notifications to whoever subscribed to that id.
import { realpathSync } from 'node:fs';
import { AcpClient } from './client';
import { childPathFor, locateDsh, notFoundMessage } from './locate';
import type {
  ConfigOption,
  InitializeResult,
  ListSessionsResult,
  NewSessionResult,
  PromptResult,
  SessionSummary,
  SessionUpdate,
} from './types';

/** ACP protocol version this client implements. */
const PROTOCOL_VERSION = 1;

/**
 * Compares absolute paths by physical identity where possible, matching how the
 * agent's own cwd filter behaves. Falls back to string equality when a path no
 * longer resolves (a deleted or unmounted workspace).
 */
function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export interface AcpConnectionOptions {
  /** `dshAgent.executablePath`; empty means "find dsh yourself". */
  command: string;
  profile: string;
  /** Workspace root; every session is created against this absolute cwd. */
  cwd: string;
  log(line: string): void;
  /** The agent process died; all bound sessions are gone. */
  onExit(): void;
  /**
   * Answer a permission prompt: resolve to an optionId, or null to reject.
   * Rarely fires — the shipped acp profile auto-approves tool use.
   */
  onPermission(params: unknown): Promise<string | null>;
}

/** Per-session state the connection tracks on behalf of its subscribers. */
interface SessionState {
  configOptions: ConfigOption[];
  busy: boolean;
}

export class AcpConnection {
  private client: AcpClient | null = null;
  private initResult: InitializeResult | null = null;
  private starting: Promise<void> | null = null;
  private readonly listeners = new Map<string, Set<(u: SessionUpdate) => void>>();
  private readonly states = new Map<string, SessionState>();

  constructor(private readonly opts: AcpConnectionOptions) {}

  get running(): boolean {
    return this.client !== null;
  }

  get agentName(): string {
    const info = this.initResult?.agentInfo;
    return info ? `${info.name} ${info.version}` : 'dsh acp';
  }

  /** True when the configured model route accepts image prompts. */
  get supportsImages(): boolean {
    return this.initResult?.agentCapabilities?.promptCapabilities?.image === true;
  }

  /** Boots the agent and completes the ACP handshake. Idempotent and concurrency-safe. */
  ensureStarted(): Promise<void> {
    if (this.client && this.initResult) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    // Resolve the executable rather than relying on spawn's PATH lookup: a
    // Dock-launched VS Code inherits the system PATH, which excludes nvm/fnm/volta
    // shims, so a bare 'dsh' fails with ENOENT even when `which dsh` works.
    const found = locateDsh(this.opts.command);
    if (found === null) throw new Error(notFoundMessage(this.opts.command));
    this.opts.log(`[acp] using ${found.path} (found via ${found.via})`);

    // dsh's shebang resolves `node` through the child's own PATH, so the child needs
    // one that reaches the runtime — not the bare system PATH we inherited.
    const childPath = childPathFor(found.path);
    const client = new AcpClient({
      command: found.path,
      args: ['--profile', this.opts.profile],
      cwd: this.opts.cwd,
      env: { ...process.env, PATH: childPath },
      log: this.opts.log,
    });

    client.on('notification', (method: string, params: unknown) => {
      if (method !== 'session/update') return;
      const p = params as { sessionId?: string; update?: SessionUpdate };
      if (!p.sessionId || !p.update) return;
      // Track config changes centrally so a tab opened later still sees them.
      if (p.update.sessionUpdate === 'config_option_update') {
        const opts = (p.update as { configOptions?: ConfigOption[] }).configOptions;
        if (opts) this.stateFor(p.sessionId).configOptions = opts;
      }
      for (const fn of this.listeners.get(p.sessionId) ?? []) fn(p.update);
    });

    client.on('exit', () => {
      this.client = null;
      this.initResult = null;
      this.states.clear();
      this.opts.onExit();
    });

    client.onRequest(async (method, params) => {
      if (method !== 'session/request_permission') return {};
      const optionId = await this.opts.onPermission(params);
      return optionId === null
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId } };
    });

    client.start();
    this.client = client;
    try {
      this.initResult = await client.request<InitializeResult>('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });
    } catch (err) {
      // A failed handshake must not leave a half-live connection behind.
      this.client = null;
      await client.stop();
      throw err;
    }
    this.opts.log(
      `[acp] handshake ok — ${this.agentName}, protocol v${this.initResult.protocolVersion}, ` +
        `images=${this.supportsImages}`,
    );
  }

  private stateFor(sessionId: string): SessionState {
    let s = this.states.get(sessionId);
    if (!s) {
      s = { configOptions: [], busy: false };
      this.states.set(sessionId, s);
    }
    return s;
  }

  /** Subscribes to one session's updates. Returns an unsubscribe function. */
  subscribe(sessionId: string, fn: (u: SessionUpdate) => void): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(sessionId);
    };
  }

  configOptions(sessionId: string): ConfigOption[] {
    return this.states.get(sessionId)?.configOptions ?? [];
  }

  busy(sessionId: string): boolean {
    return this.states.get(sessionId)?.busy === true;
  }

  /** Creates a session bound to the workspace root. */
  async newSession(): Promise<string> {
    await this.ensureStarted();
    const res = await this.request<NewSessionResult>('session/new', {
      cwd: this.opts.cwd,
      mcpServers: [],
    });
    this.stateFor(res.sessionId).configOptions = res.configOptions ?? [];
    this.opts.log(`[acp] new session ${res.sessionId}`);
    return res.sessionId;
  }

  /**
   * Reattaches a persisted session.
   *
   * Resuming an already-active session is an error agent-side, which is expected
   * when a tab for it is already open; callers should reveal that tab instead.
   */
  async resume(sessionId: string): Promise<void> {
    await this.ensureStarted();
    const res = await this.request<NewSessionResult>('session/resume', {
      sessionId,
      cwd: this.opts.cwd,
      mcpServers: [],
    });
    this.stateFor(sessionId).configOptions = res.configOptions ?? [];
    this.opts.log(`[acp] resumed ${sessionId} (no transcript replay)`);
  }

  /**
   * Lists resumable sessions for this workspace.
   *
   * The `cwd` argument matters: without it the agent returns sessions for EVERY
   * workspace it has ever served — 27 across 11 directories on this machine — which
   * would fill the sidebar with other projects' conversations. The result is also
   * filtered client-side, so a build that ignores the parameter cannot leak them.
   *
   * Measured agent behaviour: only INACTIVE sessions are returned. Sessions with an
   * open tab are active and therefore absent — callers must merge them back in.
   */
  async listSessions(): Promise<SessionSummary[]> {
    await this.ensureStarted();
    const res = await this.request<ListSessionsResult>('session/list', { cwd: this.opts.cwd });
    return (res.sessions ?? []).filter((s) => typeof s.cwd !== 'string' || samePath(s.cwd, this.opts.cwd));
  }

  /**
   * Releases a session so the agent marks it inactive.
   *
   * Required, not merely tidy: an active session never appears in session/list, so
   * one left open can never be reopened from the list.
   */
  async closeSession(sessionId: string): Promise<void> {
    this.states.delete(sessionId);
    if (!this.client) return;
    try {
      await this.client.request('session/close', { sessionId });
    } catch (err) {
      this.opts.log(`[acp] session/close failed for ${sessionId}: ${String(err)}`);
    }
  }

  /** Sends one prompt and resolves when that session's turn settles. */
  async prompt(sessionId: string, text: string): Promise<PromptResult> {
    const state = this.stateFor(sessionId);
    if (state.busy) throw new Error('a turn is already in flight for this session');
    state.busy = true;
    try {
      return await this.request<PromptResult>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      });
    } finally {
      state.busy = false;
    }
  }

  /** Cancels the in-flight turn. Unknown ids are a no-op agent-side. */
  cancel(sessionId: string): void {
    this.client?.notify('session/cancel', { sessionId });
  }

  /** Applies one advertised config option (e.g. switching the model). */
  async setConfigOption(sessionId: string, optionId: string, value: string): Promise<void> {
    const res = await this.request<{ configOptions?: ConfigOption[] }>('session/set_config_option', {
      sessionId,
      optionId,
      value,
    });
    if (res.configOptions) this.stateFor(sessionId).configOptions = res.configOptions;
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    if (!this.client) return Promise.reject(new Error('dsh agent is not running'));
    return this.client.request<T>(method, params);
  }

  /** Closes every session, then tears the transport down. */
  async dispose(): Promise<void> {
    const client = this.client;
    const ids = [...this.states.keys()];
    for (const id of ids) await this.closeSession(id);
    this.client = null;
    this.initResult = null;
    this.listeners.clear();
    if (client) await client.stop();
  }
}
