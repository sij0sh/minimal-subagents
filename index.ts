import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const TASK_ARGUMENT_LIMIT = 8_000;
const ABORT_GRACE_MS = 3_000;
const CHILD_ENV = "PI_MINIMAL_SUBAGENTS_CHILD";
const TRUNCATION_NOTICE = "[Output truncated]";
const TOOL_LABEL = "Subagent";

export type ChildState = {
  output: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage: Usage;
};

type DispatchDefaults = {
  model?: string;
  thinking?: string;
  tools?: string[];
};

type RunResult = ChildState & {
  exitCode: number;
  stderr: string;
};

const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const asObject = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};

const textContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    const item = part as { type?: unknown; text?: unknown };
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
};

const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;

export function buildChildArgs(defaults: DispatchDefaults, taskArgument: string): string[] {
  const args = [
    "--mode", "json", "-p", "--no-session", "--no-skills", "--no-prompt-templates",
    "--exclude-tools", "subagent",
  ];
  const tools = defaults.tools?.filter((tool) => tool !== "subagent");
  if (tools !== undefined) {
    if (tools.length) args.push("--tools", tools.join(","));
    else args.push("--no-tools");
  }
  if (defaults.model) args.push("--model", defaults.model);
  if (defaults.thinking) args.push("--thinking", defaults.thinking);
  args.push(taskArgument);
  return args;
}

export function reduceJsonLine(state: ChildState, line: string): void {
  let event: Record<string, unknown>;
  try {
    event = asObject(JSON.parse(line), "child event");
  } catch (error) {
    throw new Error(`invalid child JSONL: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (event.type === "message_start") {
    const message = asObject(event.message, "child message");
    if (message.role === "assistant") state.output = "";
    return;
  }

  if (event.type === "message_update") {
    const update = asObject(event.assistantMessageEvent, "child message update");
    if (update.type === "text_delta" && typeof update.delta === "string") state.output += update.delta;
    return;
  }

  if (event.type !== "message_end") return;
  const message = asObject(event.message, "child message");
  if (message.role !== "assistant") return;
  state.output = textContent(message.content);
  if (typeof message.model === "string") state.model = message.model;
  if (typeof message.stopReason === "string") state.stopReason = message.stopReason;
  if (typeof message.errorMessage === "string") state.errorMessage = message.errorMessage;
  if (!message.usage || typeof message.usage !== "object") return;
  const usage = message.usage as Record<string, unknown>;
  const cost = usage.cost && typeof usage.cost === "object" ? usage.cost as Record<string, unknown> : {};
  state.usage.input += number(usage.input);
  state.usage.output += number(usage.output);
  state.usage.cacheRead += number(usage.cacheRead);
  state.usage.cacheWrite += number(usage.cacheWrite);
  state.usage.totalTokens += number(usage.totalTokens);
  state.usage.cost.input += number(cost.input);
  state.usage.cost.output += number(cost.output);
  state.usage.cost.cacheRead += number(cost.cacheRead);
  state.usage.cost.cacheWrite += number(cost.cacheWrite);
  state.usage.cost.total += number(cost.total);
  if (usage.cacheWrite1h !== undefined) state.usage.cacheWrite1h = (state.usage.cacheWrite1h ?? 0) + number(usage.cacheWrite1h);
  if (usage.reasoning !== undefined) state.usage.reasoning = (state.usage.reasoning ?? 0) + number(usage.reasoning);
}

export function truncateToolOutput(output: string): string {
  const truncated = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!truncated.truncated) return truncated.content;
  const visible = truncateHead(output, {
    maxLines: Math.max(1, DEFAULT_MAX_LINES - 2),
    maxBytes: Math.max(1, DEFAULT_MAX_BYTES - Buffer.byteLength(TRUNCATION_NOTICE, "utf8") - 2),
  }).content;
  return `${visible}\n\n${TRUNCATION_NOTICE}`;
}

function renderPinnedTask(width: number, task: string): string[] {
  if (width <= 0) return [];
  return [`${TOOL_LABEL}${task ? `\nTask: ${task}` : ""}`].flatMap((text) =>
    text.split("\n").flatMap((line) => {
      const chunks: string[] = [];
      for (let start = 0; start < line.length; start += width) chunks.push(line.slice(start, start + width));
      return chunks.length ? chunks : [""];
    }),
  );
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const executable = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
  return { command: "pi", args };
}

function killProcessTree(proc: ChildProcess, force: boolean): void {
  if (!proc.pid) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(proc.pid), "/t"];
    if (force) args.push("/f");
    const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
    killer.unref();
    return;
  }
  try {
    process.kill(-proc.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try { proc.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* already gone */ }
  }
}

async function runChild(
  cwd: string,
  defaults: DispatchDefaults,
  task: string,
  signal: AbortSignal | undefined,
  onOutput: ((state: ChildState) => void) | undefined,
): Promise<RunResult> {
  let tempDir: string | undefined;
  let taskArgument = `Task: ${task}`;
  if (task.length > TASK_ARGUMENT_LIMIT) {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-minimal-subagents-"));
    const taskPath = path.join(tempDir, "task.md");
    await fs.promises.writeFile(taskPath, `Task: ${task}`, { encoding: "utf8", mode: 0o600 });
    taskArgument = `@${taskPath}`;
  }
  const state: ChildState = { output: "", usage: emptyUsage() };
  let stderr = "";
  let aborted = false;
  try {
    const args = buildChildArgs(defaults, taskArgument);
    const invocation = getPiInvocation(args);
    const exitCode = await new Promise<number>((resolve, reject) => {
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, [CHILD_ENV]: "1" },
      });
      let buffer = "";
      let closed = false;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      const consume = (line: string): void => {
        if (!line.trim()) return;
        reduceJsonLine(state, line);
        onOutput?.(state);
      };
      const abort = (): void => {
        aborted = true;
        killProcessTree(proc, false);
        forceTimer = setTimeout(() => { if (!closed) killProcessTree(proc, true); }, ABORT_GRACE_MS);
      };
      proc.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        try { for (const line of lines) consume(line); } catch (error) { reject(error); killProcessTree(proc, true); }
      });
      proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      proc.on("error", (error) => reject(new Error(`failed to start child: ${error.message}`)));
      proc.on("close", (code) => {
        closed = true;
        if (forceTimer) clearTimeout(forceTimer);
        if (signal) signal.removeEventListener("abort", abort);
        try {
          if (buffer.trim()) consume(buffer);
          resolve(code ?? 1);
        } catch (error) {
          reject(error);
        }
      });
      if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }
    });
    return { ...state, exitCode, stderr, stopReason: aborted ? "aborted" : state.stopReason };
  } finally {
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

export default function minimalSubagents(pi: ExtensionAPI): void {
  if (process.env[CHILD_ENV] === "1") return;

  pi.registerTool({
    name: "subagent",
    label: TOOL_LABEL,
    description: "Delegate self-contained, independent tasks to child sessions for isolated context or parallel execution.",
    promptSnippet: "Delegate independent work to child sessions",
    promptGuidelines: [
      "Use separate subagents only for independent, non-overlapping tasks that benefit from isolated context or parallel execution. Make each task self-contained.",
    ],
    executionMode: "parallel",
    parameters: Type.Object({
      task: Type.String({ description: "Self-contained task to delegate" }),
    }),
    renderCall(args) {
      const task = typeof args?.task === "string" ? args.task : "";
      return {
        render: (width) => renderPinnedTask(width, task),
        invalidate() {},
      };
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await runChild(
        ctx.cwd,
        {
          model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
          thinking: ctx.thinkingLevel,
          tools: pi.getActiveTools().filter((name) => name !== "subagent"),
        },
        params.task,
        signal,
        (state) => onUpdate?.({
          content: [{ type: "text", text: state.output ? truncateToolOutput(state.output) : "(running...)" }],
          details: { model: state.model },
        }),
      );
      const diagnostic = truncateTail(result.stderr.trim(), { maxLines: 100, maxBytes: 8_000 }).content;
      if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || result.errorMessage) {
        throw new Error(`subagent failed: ${result.errorMessage || diagnostic || result.stopReason || `exit code ${result.exitCode}`}`);
      }
      if (!result.output) throw new Error("subagent failed: child produced no final assistant text");
      return {
        content: [{ type: "text", text: truncateToolOutput(result.output) }],
        details: { model: result.model },
        usage: result.usage,
      };
    },
  });
}
