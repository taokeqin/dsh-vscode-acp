// src/history/store.ts — best-effort transcript recovery from dsh's on-disk session log.
//
// WHY THIS EXISTS
// ACP's session/resume restores the agent's context but replays no updates, so a
// resumed panel would otherwise start blank while the agent still remembers the
// conversation. dsh persists the full event log on disk, so we read it back.
//
// WHY IT IS BEST-EFFORT
// This file format is dsh's INTERNAL representation. Unlike the ACP surface — which
// is a written contract ("adds no private method, capability, _meta, environment
// variable, or transport field") — nothing here is promised to stay stable. A dsh
// release may rename records, change nesting, or switch codecs at any time.
//
// Therefore every failure mode returns a typed reason instead of throwing, the
// caller logs it, and the panel degrades to "no history" while chat keeps working.
// Nothing in this module may ever break a session.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';

/** A renderable transcript entry, already flattened out of dsh's internal shapes. */
export type HistoryEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; reasoning: string }
  | { kind: 'tool'; id: string; name: string; detail: string; failed: boolean };

export type HistoryResult =
  | { ok: true; entries: HistoryEntry[]; truncated: boolean; scanned: number }
  | { ok: false; reason: string };

/**
 * Refuse absurdly large logs rather than pulling them into the extension host.
 * The largest real session measured was 3.2 MB compressed / 6.3 MB raw.
 */
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;

/** Upper bound on frames, so a corrupt file cannot spin the decode loop forever. */
const MAX_FRAMES = 500_000;

/** Records dsh marks for display. Everything else is internal bookkeeping. */
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);

/**
 * dsh splices scaffolding into the conversation as `user/message` records, so the
 * type alone does not mean "the person typed this". Across 55 sessions on this
 * machine the `data.source.kind` values were:
 *
 *   user (66)  plugin (43)  skill-catalog (36)  goal (25)
 *   agent-message (5)  subagent-settled (4)
 *
 * Only `user` is real input; the rest is runtime context, the skill catalog, goal
 * injections and sub-agent plumbing, which rendered as walls of text the user never
 * wrote. A record with no `source.kind` at all is kept: that would be a shape we do
 * not recognise, and hiding a real message is worse than showing an odd one.
 */
const REAL_USER_SOURCE = 'user';

/**
 * Locates a session's log directory.
 *
 * Primary strategy is a scan of `<dshHome>/sessions/<slug>/<sessionId>`: we already
 * know the session id from ACP, and scanning is immune to changes in how dsh slugs
 * a workspace path into a directory name. `slugForCwd` exists only as a fast path.
 */
export function findSessionLog(dshHome: string, sessionId: string, cwd?: string): string | null {
  const root = join(dshHome, 'sessions');
  if (cwd !== undefined) {
    const fast = join(root, slugForCwd(cwd), sessionId, 'session.jsonl.zstd');
    if (existsSync(fast)) return fast;
  }
  let slugs: string[];
  try {
    slugs = readdirSync(root);
  } catch {
    return null; // No session store at all (fresh install, or DSH_HOME points elsewhere).
  }
  for (const slug of slugs) {
    const candidate = join(root, slug, sessionId, 'session.jsonl.zstd');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Maps an absolute cwd to dsh's session directory name: the non-empty path
 * segments joined by '-', wrapped in '--'. Observed to use the literal cwd string
 * (not its realpath), which matches the cwd we spawn the agent with.
 */
export function slugForCwd(cwd: string): string {
  return `--${cwd.split('/').filter((s) => s !== '').join('-')}--`;
}

/**
 * Decompresses a zstd buffer that may hold many concatenated frames.
 *
 * This is the subtle part. dsh appends to the session log one zstd frame per write,
 * so a real file is a *multi-frame* stream — the largest measured here held 9014
 * frames. Node's zstd bindings decode only the FIRST frame and stop: both
 * `zstdDecompressSync` and `createZstdDecompress` returned 202 bytes of a 6.3 MB
 * log. The `zstd` CLI concatenates frames correctly, which is what made the
 * discrepancy visible.
 *
 * So we drive the frames ourselves: decode one, advance the offset by the stream's
 * `bytesWritten` (exactly the bytes that frame consumed), repeat. Measured at 549 ms
 * for the 3.2 MB / 9014-frame worst case versus 63 ms for the CLI — slower, but it
 * needs nothing installed, so it is the primary path and the CLI is the fallback.
 *
 * @param frameBudget stop after this many frames. Session metadata lives in the first
 *   few records, so the switcher reads a handful of frames instead of megabytes.
 */
async function decompressZstd(
  buf: Buffer,
  frameBudget = MAX_FRAMES,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const createStream = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream & { bytesWritten: number } })
    .createZstdDecompress;
  if (typeof createStream === 'function') {
    try {
      const parts: Buffer[] = [];
      let offset = 0;
      let frames = 0;
      while (offset < buf.length) {
        if (frames >= frameBudget) break; // Budget reached: return what decoded so far.
        if (++frames > MAX_FRAMES) {
          return { ok: false, reason: `log exceeds the ${MAX_FRAMES} frame cap` };
        }
        const stream = createStream();
        const chunk: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
          stream.on('data', (c: Buffer) => chunk.push(c));
          stream.on('end', () => resolve());
          stream.on('error', reject);
          stream.end(buf.subarray(offset));
        });
        // No forward progress means a malformed tail; keep what decoded cleanly.
        if (stream.bytesWritten <= 0) break;
        parts.push(...chunk);
        offset += stream.bytesWritten;
      }
      return { ok: true, text: Buffer.concat(parts).toString('utf8') };
    } catch (err) {
      return { ok: false, reason: `zstd frame decode failed: ${String(err)}` };
    }
  }
  // Fallback for a host whose Node predates zstd support (added in 22.15).
  try {
    const out = execFileSync('zstd', ['-dc'], {
      input: buf,
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, text: out.toString('utf8') };
  } catch {
    return {
      ok: false,
      reason: 'no zstd support (node:zlib has no createZstdDecompress and the zstd CLI is unavailable)',
    };
  }
}

/**
 * Turns a tool's JSON arguments into one readable line.
 *
 * The raw blob is unreadable in a narrow row — `bash {"command": "ls -la /Users/…",
 * "description": "List files"}` — so the field that actually identifies the call is
 * pulled out. Order matters: a bash call is its command, a file tool is its path.
 */
export function summariseToolArgs(argsJson: string): string {
  const raw = typeof argsJson === 'string' ? argsJson.trim() : '';
  if (raw === '') return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.replace(/\s+/g, ' ').slice(0, 120); // Not JSON: show it as-is.
  }
  if (parsed === null || typeof parsed !== 'object') return String(parsed).slice(0, 120);
  const obj = parsed as Record<string, unknown>;
  const preferred = ['command', 'file_path', 'path', 'filePath', 'notebook_path', 'pattern', 'query', 'url', 'prompt'];
  for (const key of preferred) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim() !== '') return v.replace(/\s+/g, ' ').slice(0, 120);
  }
  const first = Object.values(obj).find((v) => typeof v === 'string' && v.trim() !== '');
  return typeof first === 'string' ? first.replace(/\s+/g, ' ').slice(0, 120) : '';
}

/** Joins the text of a content-block array, ignoring blocks of other types. */
function textOfBlocks(blocks: unknown, type = 'text'): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b): b is { type?: string; text?: string } => !!b && typeof b === 'object')
    .filter((b) => b.type === type && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

/**
 * Parses the decompressed JSONL into renderable entries.
 *
 * Shapes (captured from a real log, dsh 0.1.2-rc.1):
 *   user/message      → data.content[]            of { type:'text', text }
 *   assistant/message → data.message.content[]    of { type:'text'|'reasoning'|'tool-call' }
 *   tool/call         → data.{ callId, name, arguments }        (no surfaceOp; supplies the label)
 *   tool/result       → data.message.content[]    of { type:'tool-result', toolCallId, content[], isError }
 *
 * Malformed lines are skipped, never thrown: a single bad record must not lose the
 * whole transcript.
 */
export function parseTranscript(jsonl: string, maxEntries: number): HistoryResult {
  const entries: HistoryEntry[] = [];
  /** tool callId → name and argument summary, learned from the tool/call that precedes each result. */
  const toolNames = new Map<string, string>();
  const toolArgs = new Map<string, string>();
  let scanned = 0;

  for (const line of jsonl.split('\n')) {
    if (line === '') continue;
    scanned++;
    let rec: { type?: string; data?: Record<string, unknown> };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue; // A truncated or partially-flushed tail line is expected, not an error.
    }
    const type = rec.type;
    if (type === 'tool/call') {
      const d = rec.data as { callId?: string; name?: string; arguments?: string } | undefined;
      if (d?.callId && typeof d.name === 'string') toolNames.set(d.callId, d.name);
      if (d?.callId && typeof d.arguments === 'string') toolArgs.set(d.callId, summariseToolArgs(d.arguments));
      continue;
    }
    if (type === undefined || !SURFACE_TYPES.has(type)) continue;

    if (type === 'user/message') {
      const data = rec.data as { content?: unknown; source?: { kind?: unknown } } | undefined;
      const sourceKind = data?.source?.kind;
      if (typeof sourceKind === 'string' && sourceKind !== REAL_USER_SOURCE) continue;
      const text = textOfBlocks(data?.content);
      if (text.trim() !== '') entries.push({ kind: 'user', text });
      continue;
    }
    if (type === 'assistant/message') {
      const content = (rec.data as { message?: { content?: unknown } } | undefined)?.message?.content;
      const text = textOfBlocks(content);
      const reasoning = textOfBlocks(content, 'reasoning');
      if (text.trim() !== '' || reasoning.trim() !== '') {
        entries.push({ kind: 'assistant', text, reasoning });
      }
      continue;
    }
    // tool/result
    const blocks = (rec.data as { message?: { content?: unknown } } | undefined)?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      const block = b as { type?: string; toolCallId?: string; content?: unknown; isError?: boolean };
      if (block.type !== 'tool-result' || typeof block.toolCallId !== 'string') continue;
      // Prefer the call's arguments over its output: "read src/x.ts" says more about
      // what happened than the first 120 characters of the file that came back.
      const args = toolArgs.get(block.toolCallId) ?? '';
      const detail = args !== ''
        ? args
        : textOfBlocks(block.content).replace(/\s+/g, ' ').trim().slice(0, 120);
      entries.push({
        kind: 'tool',
        id: block.toolCallId,
        name: toolNames.get(block.toolCallId) ?? 'tool',
        detail,
        failed: block.isError === true,
      });
    }
  }

  // Keep the tail: the most recent exchange is what the reader needs on resume.
  const truncated = entries.length > maxEntries;
  return { ok: true, entries: truncated ? entries.slice(-maxEntries) : entries, truncated, scanned };
}

/** Descriptive metadata for one persisted session, for the sidebar list. */
export interface SessionMeta {
  sessionId: string;
  /** First user message, used by dsh as the fallback session title. */
  title: string | null;
  createdAt: number | null;
  /** Log file mtime — the closest available proxy for last activity. */
  updatedAt: number | null;
  /** Workspace the session was created against. */
  cwd: string | null;
  /**
   * 0 for a conversation the user started; >0 for a sub-agent the agent delegated
   * to. Only depth 0 belongs in the session list — this is what `session/list`
   * means by "root sessions", and 3 of 28 sessions on this machine were depth 1.
   */
  delegationDepth: number | null;
}

/** Frames to decode when only the header and title are wanted. */
const META_FRAME_BUDGET = 64;

/**
 * Reads a session's header and title without decompressing the whole log.
 *
 * The `session` record is the first line and `session/title` follows within the
 * first few, so a small frame budget is enough. Returns nulls rather than failing:
 * a switcher entry with a missing title is still usable.
 */
export async function loadSessionMeta(
  dshHome: string,
  sessionId: string,
  cwd?: string,
): Promise<SessionMeta> {
  const empty: SessionMeta = {
    sessionId, title: null, createdAt: null, updatedAt: null, cwd: null, delegationDepth: null,
  };
  let path: string | null;
  try {
    path = findSessionLog(dshHome, sessionId, cwd);
  } catch {
    return empty;
  }
  if (path === null) return empty;

  let updatedAt: number | null = null;
  let buf: Buffer;
  try {
    const st = statSync(path);
    updatedAt = st.mtimeMs;
    if (st.size > MAX_COMPRESSED_BYTES) return { ...empty, updatedAt };
    buf = readFileSync(path);
  } catch {
    return empty;
  }

  const raw = await decompressZstd(buf, META_FRAME_BUDGET);
  if (!raw.ok) return { ...empty, updatedAt };

  let title: string | null = null;
  let createdAt: number | null = null;
  let sessionCwd: string | null = null;
  let delegationDepth: number | null = null;
  for (const line of raw.text.split('\n')) {
    if (line === '') continue;
    let rec: {
      type?: string; data?: Record<string, unknown>;
      createdAt?: number; cwd?: string; delegationDepth?: number;
    };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    if (rec.type === 'session') {
      if (typeof rec.createdAt === 'number') createdAt = rec.createdAt;
      if (typeof rec.cwd === 'string') sessionCwd = rec.cwd;
      if (typeof rec.delegationDepth === 'number') delegationDepth = rec.delegationDepth;
    }
    if (rec.type === 'session/title') {
      const t = (rec.data as { title?: unknown } | undefined)?.title;
      if (typeof t === 'string' && t.trim() !== '') title = t.trim();
    }
    // Fall back to the first user message if no title record was written yet.
    if (title === null && rec.type === 'user/message') {
      const t = textOfBlocks((rec.data as { content?: unknown } | undefined)?.content).trim();
      if (t !== '') title = t;
    }
    if (title !== null && createdAt !== null) break;
  }
  return { sessionId, title, createdAt, updatedAt, cwd: sessionCwd, delegationDepth };
}

/**
 * Enumerates persisted session ids for a workspace straight from disk.
 *
 * The sidebar needs this: `session/list` requires a running agent, but the list
 * should render on a fresh window before anything has been spawned — otherwise it
 * shows nothing and only starts working once you manually create a session.
 *
 * Directory layout is `<dshHome>/sessions/<slug>/<sessionId>/`. Both the literal cwd
 * and its realpath are tried, since dsh slugs whatever cwd it was launched with.
 * Returns ids only; callers filter delegated sub-sessions via `loadSessionMeta`.
 */
export function listSessionIdsOnDisk(dshHome: string, cwd: string): string[] {
  const slugs = new Set([slugForCwd(cwd)]);
  try {
    slugs.add(slugForCwd(realpathSync(cwd)));
  } catch {
    // An unresolvable cwd just means the literal slug is the only candidate.
  }
  const ids = new Set<string>();
  for (const slug of slugs) {
    const dir = join(dshHome, 'sessions', slug);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // No sessions recorded for this workspace yet.
    }
    for (const id of entries) {
      if (existsSync(join(dir, id, 'session.jsonl.zstd'))) ids.add(id);
    }
  }
  return [...ids];
}

/** Locates, decompresses, and parses one session's transcript. Never throws. */
export async function loadTranscript(opts: {
  dshHome: string;
  sessionId: string;
  cwd?: string;
  maxEntries: number;
}): Promise<HistoryResult> {
  let path: string | null;
  try {
    path = findSessionLog(opts.dshHome, opts.sessionId, opts.cwd);
  } catch (err) {
    return { ok: false, reason: `scanning the session store failed: ${String(err)}` };
  }
  if (path === null) return { ok: false, reason: 'no on-disk log for this session' };

  let buf: Buffer;
  try {
    const size = statSync(path).size;
    if (size > MAX_COMPRESSED_BYTES) {
      return { ok: false, reason: `log is ${size} bytes, above the ${MAX_COMPRESSED_BYTES} byte cap` };
    }
    buf = readFileSync(path);
  } catch (err) {
    return { ok: false, reason: `reading ${path} failed: ${String(err)}` };
  }

  const raw = await decompressZstd(buf);
  if (!raw.ok) return raw;
  try {
    return parseTranscript(raw.text, opts.maxEntries);
  } catch (err) {
    // parseTranscript is written not to throw; this is a belt-and-braces guard so a
    // future shape change can never escape as an unhandled rejection.
    return { ok: false, reason: `parsing the transcript failed: ${String(err)}` };
  }
}
