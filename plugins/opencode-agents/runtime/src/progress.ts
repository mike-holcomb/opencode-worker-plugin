import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export type ProgressAvailability = "supported" | "unsupported" | "not_enabled";
export const CheckpointInputSchema = z.object({
  stage: z.enum(["starting", "investigating", "implementing", "verifying", "preparing_report", "blocked"]),
  summary: z.string().min(1).max(600), completed: z.array(z.string().min(1).max(200)).max(5),
  remaining: z.array(z.string().min(1).max(200)).max(5),
  blocker: z.object({ summary: z.string().min(1).max(400), request_id: z.string().min(1).max(128).optional() }).strict().nullable(),
  evidence_refs: z.array(z.string().min(1).max(128)).max(5),
}).strict().refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 4096, "checkpoint exceeds 4096 UTF-8 bytes; submit fewer or shorter entries");
export type CheckpointInput = z.infer<typeof CheckpointInputSchema>;
const Id = z.string().min(1).max(128);
export const ProgressReadSchema = z.object({ scope_id: Id, task_id: Id, execution_id: Id,
  after_cursor: z.string().min(1).max(512).optional(), max_updates: z.number().int().min(1).max(20).default(5),
  max_bytes: z.number().int().min(8192).max(32768).default(8192), include_snapshot: z.boolean().default(false) }).strict();
const ReadOptions = ProgressReadSchema.omit({ scope_id: true, task_id: true, execution_id: true });
type ReadInput = z.input<typeof ReadOptions>;
const CursorSchema = z.object({ v: z.literal(1), e: Id, p: z.string().uuid(), g: z.string().uuid(), s: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
type Cursor = z.infer<typeof CursorSchema>;
export type ProgressCheckpoint = CheckpointInput & { checkpoint_id: string; cursor: string; recorded_at: string; source: "worker" };
export type ProgressPage = { availability: ProgressAvailability; updates: ProgressCheckpoint[]; next_cursor: string; has_more: boolean;
  gap: { reason: string; history_missed: true; snapshot_available: boolean } | null; snapshot: ProgressCheckpoint | null;
  runtime: Record<string, unknown>; dropped_count: number; [key: string]: unknown };
type Entry = { sequence: number; checkpoint: ProgressCheckpoint; bytes: number };
type State = { generation: string; sequence: number; availability: ProgressAvailability; entries: Entry[]; latest: Entry | null;
  dedup: Map<string, string>; rate: Array<{ at: number; routine: boolean }>; dropped: number; lastActivity: number;
  terminalAt: number | null; resetReason: string | null; blocker: string | null };
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Advisory state only. Reads never register buffers, acknowledge consumers, or evict history. */
export class ProgressManager {
  private readonly processGeneration = randomUUID();
  private readonly states = new Map<string, State>();
  private readonly evicted = new Map<string, { reason: string; generation: string }>();
  private readonly now: () => number;
  private readonly maxCount: number;
  private readonly maxExecutionBytes: number;
  private readonly maxAggregateBytes: number;
  private readonly terminalTtlMs: number;
  constructor(options: { now?: () => number; maxCount?: number; maxExecutionBytes?: number; maxAggregateBytes?: number; terminalTtlMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.maxCount = options.maxCount ?? 100;
    this.maxExecutionBytes = options.maxExecutionBytes ?? 256 * 1024;
    this.maxAggregateBytes = options.maxAggregateBytes ?? 16 * 1024 * 1024;
    this.terminalTtlMs = options.terminalTtlMs ?? 30 * 60_000;
    for (const limit of [this.maxCount, this.maxExecutionBytes, this.maxAggregateBytes, this.terminalTtlMs])
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("progress limits must be positive safe integers");
  }
  private cursor(executionId: string, state?: State, sequence = state?.sequence ?? 0): string {
    return Buffer.from(JSON.stringify({ v: 1, e: executionId, p: this.processGeneration,
      g: state?.generation ?? this.evicted.get(executionId)?.generation ?? this.processGeneration, s: sequence })).toString("base64url");
  }
  private decode(encoded: string, executionId: string): Cursor {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || Buffer.from(encoded, "base64url").toString("base64url") !== encoded) throw new Error("malformed progress cursor");
    let cursor: Cursor;
    try { cursor = CursorSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))); }
    catch { throw new Error("malformed progress cursor"); }
    if (cursor.e !== executionId) throw new Error("progress cursor belongs to another execution");
    return cursor;
  }
  register(executionId: string, availability: ProgressAvailability): void {
    Id.parse(executionId);
    this.sweep();
    const current = this.states.get(executionId);
    if (current) { current.availability = availability; return; }
    const eviction = this.evicted.get(executionId);
    this.evicted.delete(executionId);
    this.states.set(executionId, { generation: eviction?.generation ?? this.processGeneration,
      sequence: 0, availability, entries: [], latest: null, dedup: new Map(), rate: [], dropped: 0,
      lastActivity: this.now(), terminalAt: null, resetReason: eviction?.reason ?? null, blocker: null });
    this.enforceAggregate();
  }
  append(executionId: string, sourceId: string, input: CheckpointInput): { accepted: boolean; duplicate: boolean } {
    Id.parse(sourceId);
    // Clone the validated input so a caller cannot rewrite already-exposed claims.
    const checkpoint = CheckpointInputSchema.parse(JSON.parse(JSON.stringify(input)));
    const canonical = JSON.stringify({ stage: checkpoint.stage, summary: checkpoint.summary, completed: checkpoint.completed,
      remaining: checkpoint.remaining, blocker: checkpoint.blocker ? { summary: checkpoint.blocker.summary,
        ...(checkpoint.blocker.request_id ? { request_id: checkpoint.blocker.request_id } : {}) } : null, evidence_refs: checkpoint.evidence_refs });
    const hash = sha(canonical);
    this.sweep();
    const state = this.states.get(executionId);
    if (!state || state.availability !== "supported") return { accepted: false, duplicate: false };
    const prior = state.dedup.get(sourceId);
    if (prior) {
      if (prior !== hash) throw new Error("checkpoint source ID has conflicting content");
      return { accepted: true, duplicate: true };
    }
    const now = this.now();
    state.rate = state.rate.filter((entry) => now - entry.at < 60_000);
    const blocker = checkpoint.blocker ? JSON.stringify(checkpoint.blocker) : null;
    const routine = blocker === state.blocker;
    // Metadata admission is finite, too. Keep hashes for the execution's admitted
    // IDs instead of forgetting them and accidentally accepting conflicting retries.
    if (state.dedup.size >= 1024 || state.rate.length >= 60 || (routine && state.rate.filter((entry) => entry.routine).length >= 48)) {
      state.dropped++; return { accepted: false, duplicate: false };
    }
    const sequence = state.sequence + 1;
    const entry: Entry = { sequence, checkpoint: { ...checkpoint, checkpoint_id: `checkpoint_${sha(sourceId).slice(0, 32)}`,
      cursor: this.cursor(executionId, state, sequence), recorded_at: new Date(now).toISOString(), source: "worker" }, bytes: 0 };
    entry.bytes = size(entry.checkpoint);
    // Guarantee one admitted record and its metadata fit the configured buffer.
    const admissionBytes = 512 + entry.bytes + [...state.dedup].reduce((sum, [id]) => sum + Buffer.byteLength(id) + 160, 0) + Buffer.byteLength(sourceId) + 160 + 60 * 24;
    if (admissionBytes > this.maxExecutionBytes) { state.dropped++; return { accepted: false, duplicate: false }; }
    state.sequence = sequence;
    state.entries.push(entry); state.latest = entry;
    state.dedup.set(sourceId, hash); state.rate.push({ at: now, routine });
    state.blocker = blocker; state.lastActivity = now;
    while (state.entries.length > this.maxCount || (this.stateBytes(state) > this.maxExecutionBytes && state.entries.length > 1)) state.entries.shift();
    this.enforceAggregate();
    return { accepted: true, duplicate: false };
  }
  reset(executionId: string, reason: "disconnect"): void {
    const state = this.states.get(executionId);
    if (!state) return;
    state.generation = randomUUID(); state.sequence = 0; state.entries = [];
    // Preserve a bounded snapshot and dedup hashes across reconnect. The snapshot
    // retains its original cursor; next_cursor always identifies the new head.
    state.resetReason = reason;
    state.lastActivity = this.now();
    this.sweep();
  }
  /** Supervisor maintenance runs independently of consumer reads. */
  maintain(): void { this.sweep(); }
  markTerminal(executionId: string): void {
    const state = this.states.get(executionId);
    if (state) state.terminalAt = this.now();
    this.sweep();
  }
  hint(executionId: string): { progress_cursor: string; progress_available: ProgressAvailability } {
    const state = this.states.get(executionId);
    return { progress_cursor: this.cursor(executionId, state), progress_available: state?.availability ?? "not_enabled" };
  }
  read(executionId: string, input: ReadInput = {}, runtime: Record<string, unknown> = {}, identity: Record<string, unknown> = {}): ProgressPage {
    Id.parse(executionId);
    const options = ReadOptions.parse(input);
    const state = this.states.get(executionId);
    const cursor = options.after_cursor ? this.decode(options.after_cursor, executionId) : null;
    let reason: string | null = null;
    if (cursor?.p !== undefined && cursor.p !== this.processGeneration) reason = "restart";
    else if (cursor && !state && (cursor.s > 0 || cursor.g !== (this.evicted.get(executionId)?.generation ?? this.processGeneration)))
      reason = this.evicted.get(executionId)?.reason ?? "buffer_unavailable";
    else if (cursor && state && cursor.g !== state.generation) reason = state.resetReason ?? "buffer_evicted";
    else if (cursor && state && cursor.s > state.sequence) throw new Error("progress cursor is ahead of the execution stream");
    else if (cursor && state?.entries.length && cursor.s < state.entries[0]!.sequence - 1) reason = "retention";
    const page: ProgressPage = { ...identity, availability: state?.availability ?? "not_enabled", updates: [],
      next_cursor: reason ? this.cursor(executionId, state) : options.after_cursor ?? this.cursor(executionId, state, state?.entries[0] ? state.entries[0].sequence - 1 : 0),
      has_more: false, gap: reason ? { reason, history_missed: true, snapshot_available: !!state?.latest } : null,
      snapshot: (options.include_snapshot || reason) && state?.latest ? state.latest.checkpoint : null,
      runtime: { ...runtime, last_worker_checkpoint_at: state?.latest?.checkpoint.recorded_at ?? null }, dropped_count: state?.dropped ?? 0 };
    if (size(page) > options.max_bytes) throw new Error("progress response exceeds max_bytes; increase the page budget");
    if (reason || !state) return structuredClone(page);
    const eligible = state.entries.filter((entry) => entry.sequence > (cursor?.s ?? 0));
    for (const entry of eligible) {
      if (page.updates.length >= options.max_updates) break;
      const trial = { ...page, updates: [...page.updates, entry.checkpoint], next_cursor: entry.checkpoint.cursor, has_more: false };
      if (size(trial) > options.max_bytes) break;
      page.updates.push(entry.checkpoint); page.next_cursor = entry.checkpoint.cursor;
    }
    page.has_more = page.updates.length < eligible.length;
    if (page.has_more && page.updates.length === 0) throw new Error("max_bytes cannot fit snapshot and next checkpoint; increase max_bytes or disable include_snapshot");
    return structuredClone(page);
  }
  private stateBytes(state: State): number {
    const latestExtra = state.latest && !state.entries.includes(state.latest) ? state.latest.bytes : 0;
    return 512 + latestExtra + state.entries.reduce((sum, entry) => sum + entry.bytes, 0) +
      [...state.dedup].reduce((sum, [id]) => sum + Buffer.byteLength(id) + 160, 0) + state.rate.length * 24;
  }
  private evict(id: string, reason: string): void {
    this.states.delete(id); this.evicted.delete(id);
    // A new empty-buffer generation distinguishes expired cursors from the
    // recovery cursor without reads acknowledging or mutating retained state.
    this.evicted.set(id, { reason, generation: randomUUID() });
    // Tombstones are bounded; older unknown buffers still return an honest gap.
    while (this.evicted.size > 256 || this.evicted.size * 256 > this.maxAggregateBytes / 4) this.evicted.delete(this.evicted.keys().next().value!);
  }
  private enforceAggregate(): void {
    let bytes = this.evicted.size * 256 + [...this.states].reduce((sum, [id, state]) => sum + Buffer.byteLength(id) + this.stateBytes(state), 0);
    for (const [id, state] of [...this.states].sort((a, b) => a[1].lastActivity - b[1].lastActivity)) {
      if (bytes <= this.maxAggregateBytes) break;
      this.evict(id, "aggregate");
      bytes = this.evicted.size * 256 + [...this.states].reduce((sum, [id, value]) => sum + Buffer.byteLength(id) + this.stateBytes(value), 0);
    }
  }
  private sweep(): void {
    for (const [id, state] of this.states) if (state.terminalAt !== null && this.now() - state.terminalAt >= this.terminalTtlMs) this.evict(id, "terminal");
    this.enforceAggregate();
  }
}
