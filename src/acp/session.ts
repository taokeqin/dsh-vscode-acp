// src/acp/session.ts — agent lifecycle and session selection on top of AcpClient.
//
// This is the layer that answers "reuse an existing session or start a new one".
// Unlike the HTTP approach, that question has a protocol answer here: session/list
// returns persisted sessions with their cwd, and session/resume reattaches to one.
import { realpathSync } from 'node:fs';
import { AcpClient } from './client';
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

export interface AgentSessionOptions {
  command: string;
  profile: string;
  cwd: string;
  resumeLatest: boolean;
  log(line: string): void;
  /** Called for every session/update belonging to the active session. */
  onUpdate(update: SessionUpdate): void;
  /** Called when the agent process dies unexpectedly. */
  onExit(): void;
  /**
   * Asked to answer a permission prompt. Resolves to the chosen optionId, or null
   * to reject. Rarely fires: the shipped acp profile auto-approves tool use.
   */
  onPermission(params: unknown): Promise<string | null>;
}

/**
 * Compares two absolute paths by physical identity where possible, matching how
 * `session/list`'s cwd filter behaves. Falls back to string equality when a path
 * no longer resolves (a deleted or unmounted workspace).
 */
function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Owns one agent process plus the one session currently bound to the panel. */
export class AgentSession {
  private client: AcpClient | null = null;
  private sessionId: string | null = null;
  private configOptions: ConfigOption[] = [];
  private promptInFlight = false;
  private initResult: InitializeResult | null = null;
  /** True when start() bound an existing session rather than creating one. */
  private resumedExisting = false;

  constructor(private readonly opts: AgentSessionOptions) {}

  get id(): string | null {
    return this.sessionId;
  }

  /** Whether the bound session came from session/resume (so its transcript is on disk). */
  get resumed(): boolean {
    return this.resumedExisting;
  }

  get options(): ConfigOption[] {
    return this.configOptions;
  }

  get busy(): boolean {
    return this.promptInFlight;
  }

  get agentName(): string {
    const info = this.initResult?.agentInfo;
    return info ? `${info.name} ${info.version}` : 'dsh acp';
  }

  /** True when the configured model route accepts image prompts. */
  get supportsImages(): boolean {
    return this.initResult?.agentCapabilities?.promptCapabilities?.image === true;
  }

  /**
   * Boots the agent, performs the ACP handshake, then binds a session: the newest
   * persisted one for this workspace when resuming is enabled, otherwise a fresh one.
   */
  async start(): Promise<void> {
    const client = new AcpClient({
      command: this.opts.command,
      args: ['--profile', this.opts.profile],
      cwd: this.opts.cwd,
      log: this.opts.log,
    });
    this.client = client;

    client.on('notification', (method: string, params: unknown) => {
      if (method !== 'session/update') return;
      const p = params as { sessionId?: string; update?: SessionUpdate };
      // Several sessions can share one connection; ignore traffic that is not ours.
      if (p.sessionId && this.sessionId && p.sessionId !== this.sessionId) return;
      if (p.update) this.opts.onUpdate(p.update);
    });
    client.on('exit', () => {
      this.sessionId = null;
      this.promptInFlight = false;
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

    this.initResult = await client.request<InitializeResult>('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    this.opts.log(
      `[acp] handshake ok — ${this.agentName}, protocol v${this.initResult.protocolVersion}, ` +
        `images=${this.supportsImages}`,
    );

    const resumed = this.opts.resumeLatest ? await this.tryResumeLatest() : null;
    this.resumedExisting = resumed !== null;
    if (resumed === null) await this.newSession();
  }

  /**
   * Resumes the newest persisted session for this workspace.
   *
   * session/list returns newest-first, so the first cwd match is the newest. A
   * resume can legitimately fail (the session is already active elsewhere, or its
   * workspace no longer verifies) — that is not fatal, we just fall back to a new one.
   */
  private async tryResumeLatest(): Promise<string | null> {
    let sessions: SessionSummary[];
    try {
      const res = await this.request<ListSessionsResult>('session/list', {});
      sessions = res.sessions ?? [];
    } catch (err) {
      this.opts.log(`[acp] session/list failed, starting fresh: ${String(err)}`);
      return null;
    }
    const match = sessions.find((s) => samePath(s.cwd, this.opts.cwd));
    if (!match) {
      this.opts.log(`[acp] no persisted session for ${this.opts.cwd}; creating one`);
      return null;
    }
    try {
      const res = await this.request<NewSessionResult>('session/resume', {
        sessionId: match.sessionId,
        cwd: this.opts.cwd,
        mcpServers: [],
      });
      this.sessionId = match.sessionId;
      this.configOptions = res.configOptions ?? [];
      // Documented agent behaviour: resume restores the log without replaying old
      // updates, so the panel starts empty even though the model retains context.
      this.opts.log(`[acp] resumed ${match.sessionId} (no transcript replay)`);
      return match.sessionId;
    } catch (err) {
      this.opts.log(`[acp] resume failed, creating a new session: ${String(err)}`);
      return null;
    }
  }

  /**
   * Closes the currently bound session so the agent releases it.
   *
   * This matters for more than tidiness: `session/list` only returns *inactive*
   * sessions (measured — an active one is absent and reappears after close), so a
   * session left active can never be resumed from the switcher again.
   */
  private async closeCurrent(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId || !this.client) return;
    this.sessionId = null;
    try {
      await this.client.request('session/close', { sessionId });
    } catch (err) {
      // A session that is already gone is fine; anything else is logged, not fatal.
      this.opts.log(`[acp] session/close failed for ${sessionId}: ${String(err)}`);
    }
  }

  /** Creates and binds a fresh session in the workspace root, releasing the old one. */
  async newSession(): Promise<string> {
    await this.closeCurrent();
    const res = await this.request<NewSessionResult>('session/new', {
      cwd: this.opts.cwd,
      mcpServers: [],
    });
    this.sessionId = res.sessionId;
    this.configOptions = res.configOptions ?? [];
    this.resumedExisting = false;
    this.opts.log(`[acp] new session ${res.sessionId}`);
    return res.sessionId;
  }

  /**
   * Lists resumable sessions for this workspace, newest first.
   *
   * The currently bound session is not among them: the agent only lists inactive
   * sessions. That is the correct set for a "switch to" picker.
   */
  async listSessions(): Promise<SessionSummary[]> {
    const res = await this.request<ListSessionsResult>('session/list', {});
    return (res.sessions ?? []).filter((s) => samePath(s.cwd, this.opts.cwd));
  }

  /** Binds the panel to an existing persisted session, releasing the current one. */
  async resume(sessionId: string): Promise<void> {
    if (this.sessionId === sessionId) return;
    await this.closeCurrent();
    const res = await this.request<NewSessionResult>('session/resume', {
      sessionId,
      cwd: this.opts.cwd,
      mcpServers: [],
    });
    this.sessionId = sessionId;
    this.configOptions = res.configOptions ?? [];
    this.resumedExisting = true;
  }

  /** Sends one text prompt and resolves when the turn settles. */
  async prompt(text: string): Promise<PromptResult> {
    if (!this.sessionId) throw new Error('no active session');
    if (this.promptInFlight) throw new Error('a turn is already in flight');
    this.promptInFlight = true;
    try {
      return await this.request<PromptResult>('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      });
    } finally {
      this.promptInFlight = false;
    }
  }

  /** Cancels the in-flight turn. Unknown session ids are a no-op agent-side. */
  cancel(): void {
    if (!this.sessionId || !this.client) return;
    this.client.notify('session/cancel', { sessionId: this.sessionId });
  }

  /** Applies one advertised config option (e.g. switching the model). */
  async setConfigOption(optionId: string, value: string): Promise<void> {
    const res = await this.request<{ configOptions?: ConfigOption[] }>('session/set_config_option', {
      sessionId: this.sessionId,
      optionId,
      value,
    });
    if (res.configOptions) this.configOptions = res.configOptions;
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    if (!this.client) return Promise.reject(new Error('dsh agent is not running'));
    return this.client.request<T>(method, params);
  }

  async dispose(): Promise<void> {
    // Close first so the agent flushes persistence and the session becomes
    // resumable again, then tear the transport down.
    await this.closeCurrent();
    const client = this.client;
    this.client = null;
    if (!client) return;
    await client.stop();
  }
}
