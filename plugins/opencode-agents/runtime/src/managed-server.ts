import { randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import type { Readable } from "node:stream";
import { executionPairAllowed } from "./backend.js";
import { trustedDevelopmentWorkspace, type UserConfig } from "./config.js";
import { assertFrozenEffectiveConfig, effectiveConfigHash, type ManagedLaunchContract } from "./launch-config.js";
import { SdkOpenCodeBackend } from "./opencode-backend.js";

export type ManagedServer = {
  backendId: string;
  baseUrl: string;
  backend: SdkOpenCodeBackend;
  /** Valid only while this owned, certified server process remains alive. */
  confirmAbortStopped(sessionId: string, messageId: string): Promise<boolean>;
  close(): Promise<void>;
};

export type ManagedServerOptions = {
  binary: string;
  workspace: string;
  launchContract?: ManagedLaunchContract;
  developmentExecution?: UserConfig["development_execution"];
  backendId?: string;
  startupTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  onDiagnostic?: (bytes: Buffer) => void;
};

const LISTENING = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/;
type OwnedChild = ChildProcessByStdio<null, Readable, Readable>;
const execFileAsync = promisify(execFile);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OpenCode configuration must be an object");
  return value as Record<string, unknown>;
}

export function assertNoLocalPlugins(workspace: string, env: NodeJS.ProcessEnv): void {
  // FIXME: This is only a launch-time check. OpenCode 1.18.35 can discover V2
  // project plugins when it opens a location later; a file added after this
  // check can execute outside the bounded worker policy. Use an immutable,
  // sanitized worker config/project view or an upstream loader disable switch.
  // OpenCode runs with workspace as cwd, so relative override paths must be
  // resolved from that same directory rather than the supervisor's cwd.
  const fromWorker = (path: string) => resolve(workspace, path);
  const roots = new Set<string>();
  const documents = new Set<string>();
  let current = resolve(workspace);
  while (true) {
    roots.add(join(current, ".opencode"));
    documents.add(join(current, "opencode.json"));
    documents.add(join(current, "opencode.jsonc"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const workerHome = env.HOME ?? homedir();
  const globalConfig = fromWorker(join(env.XDG_CONFIG_HOME ?? join(workerHome, ".config"), "opencode"));
  roots.add(globalConfig);
  roots.add(fromWorker(env.OPENCODE_CONFIG_DIR ?? globalConfig));
  roots.add(fromWorker(join(env.OPENCODE_TEST_HOME ?? workerHome, ".opencode")));
  roots.add(fromWorker(join(env.XDG_DATA_HOME ?? join(workerHome, ".local", "share"), "opencode")));
  for (const root of roots) {
    documents.add(join(root, "opencode.json"));
    documents.add(join(root, "opencode.jsonc"));
    documents.add(join(root, "config.json"));
    for (const name of ["plugin", "plugins"]) {
      const location = join(root, name);
      if (existsSync(location) && readdirSync(location).length > 0)
        throw new Error(`OpenCode local plugins present at ${location}; server-mode --pure does not suppress them reliably`);
    }
  }
  if (env.OPENCODE_CONFIG) documents.add(fromWorker(env.OPENCODE_CONFIG));
  if (env.OPENCODE_CONFIG_CONTENT) assertNoPluginKeys(JSON.parse(env.OPENCODE_CONFIG_CONTENT), "OPENCODE_CONFIG_CONTENT");
  for (const file of documents) {
    if (!existsSync(file)) continue;
    // OpenCode's V2 loader reads project/global documents independently of the
    // legacy config.get response. Parse the comments and trailing commas that
    // OpenCode accepts, and fail closed on any other syntax.
    let config: unknown;
    try { config = parseJsoncConfig(readFileSync(file, "utf8")); }
    catch { throw new Error(`OpenCode config document at ${file} cannot be checked for V2 plugins`); }
    assertNoPluginKeys(config, file);
  }
}

function parseJsoncConfig(input: string): unknown {
  let withoutComments = "";
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quoted) {
      withoutComments += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; withoutComments += char; continue; }
    if (char === "/" && input[i + 1] === "/") {
      withoutComments += "  "; i++;
      while (i + 1 < input.length && input[i + 1] !== "\n" && input[i + 1] !== "\r") {
        withoutComments += " "; i++;
      }
      continue;
    }
    if (char === "/" && input[i + 1] === "*") {
      withoutComments += "  "; i++;
      let closed = false;
      while (i + 1 < input.length) {
        i++;
        if (input[i] === "*" && input[i + 1] === "/") {
          withoutComments += "  "; i++; closed = true; break;
        }
        withoutComments += input[i] === "\n" || input[i] === "\r" ? input[i] : " ";
      }
      if (!closed) throw new Error("unterminated JSONC comment");
      continue;
    }
    withoutComments += char;
  }
  let normalized = "";
  quoted = false;
  escaped = false;
  for (let i = 0; i < withoutComments.length; i++) {
    const char = withoutComments[i]!;
    if (quoted) {
      normalized += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; normalized += char; continue; }
    if (char === ",") {
      let next = i + 1;
      while (/\s/.test(withoutComments[next] ?? "") && next < withoutComments.length) next++;
      if (withoutComments[next] === "}" || withoutComments[next] === "]") {
        normalized += " "; continue;
      }
    }
    normalized += char;
  }
  return JSON.parse(normalized);
}

function assertNoPluginKeys(config: unknown, source: string): void {
  const parsed = object(config);
  if (Object.hasOwn(parsed, "plugin") || Object.hasOwn(parsed, "plugins"))
    throw new Error(`OpenCode plugin configuration present at ${source}; server-mode --pure does not suppress V2 plugins reliably`);
}

async function worktreeRoot(workspace: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", workspace, "rev-parse", "--show-toplevel"],
      { env, timeout: 5_000, maxBuffer: 4096 });
    return resolve(stdout.trim());
  // OpenCode assigns non-Git directories to its global project, whose
  // permission patterns are relative to the filesystem root.
  } catch (error) {
    const failure = error as { stderr?: string };
    if (typeof failure.stderr === "string" && /not a git repository/i.test(failure.stderr))
      return parse(resolve(workspace)).root;
    throw new Error(`cannot establish OpenCode worktree root: ${String(error)}`);
  }
}

export function workerPolicy(reportPath: string, worktree: string): {
  profiles: Record<string, { mode: "primary"; permission: Record<string, unknown> }>;
  reportEditPattern: string;
} {
  if (!isAbsolute(reportPath)) throw new Error("assigned report path must be absolute");
  const absoluteReport = resolve(reportPath);
  const reportEditPattern = `${relative(worktree, absoluteReport).replaceAll("\\", "/")}/*`;
  const reportExternalPattern = `${absoluteReport}/*`;
  const common = {
    read: "allow", glob: "allow", grep: "allow", list: "allow",
    external_directory: { "*": "deny", [reportExternalPattern]: "allow" },
    task: "deny", question: "deny", skill: "deny",
  };
  return {
    reportEditPattern,
    profiles: {
      "bounded-inspect": { mode: "primary", permission: {
        ...common, edit: { "*": "deny", [reportEditPattern]: "allow" },
        bash: "deny", webfetch: "deny", websearch: "deny",
      } },
      "bounded-build": { mode: "primary", permission: {
        ...common, edit: { "*": "ask", [reportEditPattern]: "allow" },
        bash: "ask", webfetch: "ask", websearch: "ask",
      } },
    },
  };
}

export function assertWorkerPolicy(config: unknown, profiles: ReturnType<typeof workerPolicy>["profiles"]): void {
  const effective = object(config);
  if (!Array.isArray(effective.plugin) || effective.plugin.length !== 0)
    throw new Error("OpenCode external plugins are not suppressed");
  const mcp = object(effective.mcp ?? {});
  for (const [name, entry] of Object.entries(mcp)) {
    if (object(entry).enabled !== false) throw new Error(`OpenCode MCP server ${name} is enabled for workers`);
  }
  const agents = object(effective.agent ?? {});
  for (const [name, expected] of Object.entries(profiles)) {
    const actual = object(agents[name]);
    if (actual.mode !== expected.mode || !isDeepStrictEqual(actual.permission, expected.permission))
      throw new Error(`OpenCode worker policy mismatch for ${name}`);
  }
}

export async function launchEnvironment(options: ManagedServerOptions): Promise<{
  env: NodeJS.ProcessEnv;
  profiles: ReturnType<typeof workerPolicy>["profiles"];
}> {
  const baseEnv = { ...process.env, ...options.env };
  assertNoLocalPlugins(options.workspace, baseEnv);
  const supplied = options.launchContract ? object(JSON.parse(options.launchContract.configContent)) :
    baseEnv.OPENCODE_CONFIG_CONTENT ? object(JSON.parse(baseEnv.OPENCODE_CONFIG_CONTENT)) : {};
  // `--pure` does not suppress inherited MCP servers. A live turn also loaded
  // a project plugin despite an empty effective plugin list, so local plugin
  // roots are rejected above and execution remains compatibility gated.
  const { stdout } = await execFileAsync(options.binary, ["debug", "config", "--pure"], {
    cwd: options.workspace, env: options.launchContract
      ? { ...baseEnv, OPENCODE_CONFIG_CONTENT: options.launchContract.configContent } : baseEnv,
    timeout: 15_000, maxBuffer: 5 * 1024 * 1024,
  });
  const resolved = object(JSON.parse(stdout));
  if (options.launchContract) assertFrozenEffectiveConfig(resolved, options.launchContract);
  const inheritedMcp = object(resolved.mcp ?? {});
  const disabledMcp = Object.fromEntries(Object.keys(inheritedMcp).map((name) => [name, { enabled: false }]));
  if (options.launchContract && !options.launchContract.reportPath)
    throw new Error("frozen execution report path is missing");
  const reportPath = options.launchContract?.reportPath;
  if (!reportPath) throw new Error("managed worker requires an assigned execution report path");
  const { profiles } = workerPolicy(reportPath, await worktreeRoot(options.workspace, baseEnv));
  if (options.launchContract) assertWorkerPolicy(resolved, profiles);
  const overlay = options.launchContract ? supplied : {
    ...supplied,
    mcp: { ...object(supplied.mcp ?? {}), ...disabledMcp },
    agent: { ...object(supplied.agent ?? {}), ...profiles },
  };
  return { env: { ...baseEnv, OPENCODE_CONFIG_CONTENT: JSON.stringify(overlay) }, profiles };
}

export async function startManagedServer(options: ManagedServerOptions): Promise<ManagedServer> {
  const password = randomBytes(32).toString("hex");
  const { env, profiles } = await launchEnvironment(options);
  const child = spawn(options.binary, ["serve", "--pure", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: options.workspace,
    env: { ...env, OPENCODE_SERVER_PASSWORD: password },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain stderr even when private capture is disabled; otherwise a noisy
  // worker can block on its pipe and stall the exact session being observed.
  child.stderr.on("data", (bytes: Buffer) => {
    try { options.onDiagnostic?.(bytes); }
    catch { /* optional diagnostics must not change execution state */ }
  });
  let baseUrl: string;
  try { baseUrl = await waitForServerUrl(child, options.startupTimeoutMs ?? 15_000); }
  catch (error) { await stopOwnedChild(child); throw error; }
  const backendId = options.backendId ?? `backend_${randomUUID()}`;
  const token = Buffer.from(`opencode:${password}`).toString("base64");
  const backend = new SdkOpenCodeBackend(baseUrl, options.workspace, backendId, { Authorization: `Basic ${token}` });
  try {
    const effective = await backend.effectiveConfiguration({ timeoutMs: 5_000 });
    assertWorkerPolicy(effective, profiles);
    if (options.launchContract) assertFrozenEffectiveConfig(effective, options.launchContract);
    const inspected = await backend.inspectBackend({ timeoutMs: 5_000 });
    const developmentTrusted = trustedDevelopmentWorkspace(
      { development_execution: options.developmentExecution }, options.workspace);
    if (!executionPairAllowed(inspected, developmentTrusted))
      throw new Error(`OpenCode ${inspected.version} is neither certified nor development-enabled for this exact workspace and pair`);
    if (inspected.version !== "1.18.35") throw new Error(`OpenCode ${inspected.version} has no certified abort-stop proof`);
  } catch (error) {
    await stopOwnedChild(child);
    throw error;
  }
  return { backendId, baseUrl, backend,
    confirmAbortStopped: async (sessionId, messageId) => {
      if (child.killed || child.exitCode !== null || child.signalCode !== null) return false;
      // This is a new snapshot after the abort response, scoped to the exact
      // recorded session and user message. OpenCode 1.18.35 omits idle sessions
      // from the status map; an explicit idle entry is not this proof.
      const observed = await backend.inspectTurn(sessionId, messageId, { timeoutMs: 5_000 });
      return !child.killed && child.exitCode === null && child.signalCode === null && observed.submitted &&
        !observed.finished && observed.statusOmitted === true && observed.activeTools === 0 &&
        observed.pendingRequests.length === 0;
    },
    close: () => stopOwnedChild(child) };
}

/** Freeze the exact pure-mode configuration and managed policy before durable admission. */
export async function freezeManagedLaunch(binary: string, workspace: string, reportPath: string,
  env: NodeJS.ProcessEnv = process.env): Promise<ManagedLaunchContract> {
  if (!isAbsolute(reportPath)) throw new Error("assigned report path must be absolute");
  const baseEnv = { ...env };
  assertNoLocalPlugins(workspace, baseEnv);
  const { stdout } = await execFileAsync(binary, ["debug", "config", "--pure"], {
    cwd: workspace, env: baseEnv, timeout: 15_000, maxBuffer: 5 * 1024 * 1024,
  });
  const resolved = object(JSON.parse(stdout));
  const inheritedMcp = object(resolved.mcp ?? {});
  const disabledMcp = Object.fromEntries(Object.keys(inheritedMcp).map((name) => [name, { enabled: false }]));
  const { profiles } = workerPolicy(reportPath, await worktreeRoot(workspace, baseEnv));
  const content = JSON.stringify({ ...resolved, plugin: [],
    mcp: { ...inheritedMcp, ...disabledMcp },
    agent: { ...object(resolved.agent ?? {}), ...profiles } });
  const frozenEnv = { ...baseEnv, OPENCODE_CONFIG_CONTENT: content };
  const expected = await execFileAsync(binary, ["debug", "config", "--pure"], {
    cwd: workspace, env: frozenEnv, timeout: 15_000, maxBuffer: 5 * 1024 * 1024,
  });
  const effective = object(JSON.parse(expected.stdout));
  assertWorkerPolicy(effective, profiles);
  return { configContent: content, effectiveConfigSha256: effectiveConfigHash(effective), reportPath };
}

function waitForServerUrl(child: OwnedChild, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const finish = (error?: Error, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(url!);
    };
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4096);
      const match = LISTENING.exec(output);
      if (match?.[1]) finish(undefined, match[1]);
    };
    const onExit = (code: number | null) => finish(new Error(`OpenCode server exited during startup (${code ?? "signal"})`));
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(() => finish(new Error("OpenCode server startup timed out")), timeoutMs);
    child.stdout.on("data", onData);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

async function stopOwnedChild(child: OwnedChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}
