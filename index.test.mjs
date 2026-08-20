import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const extensionModule = await import("./index.ts");
const { buildChildArgs, getPiInvocation, reduceJsonLine, truncateToolOutput } = extensionModule;

const assistantEvent = (overrides = {}) => JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    model: "provider/model",
    stopReason: "stop",
    usage: {
      input: 10, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 16,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
    ...overrides,
  },
});
const childState = () => ({
  output: "",
  usage: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

const registerTool = () => {
  let tool;
  extensionModule.default({
    registerTool(definition) { tool = definition; },
    getActiveTools() { return ["read", "subagent"]; },
  });
  return tool;
};

const withChildFixture = async (callback) => {
  const directory = await mkdtemp(join(tmpdir(), "minimal-subagents-test-"));
  const script = join(directory, "child.mjs");
  await writeFile(script, `
import { existsSync, writeFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  writeFileSync("received-task", input);
  writeFileSync("received-args", JSON.stringify(process.argv.slice(2)));
  if (existsSync("fail")) {
    process.stderr.write("x".repeat(20_000) + "fixture failure");
    process.stdout.write(JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error" },
    }) + "\\n");
    return;
  }
  const usage = {
    input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  };
  const events = [
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streamed" } },
    { type: "message_end", message: {
      role: "assistant",
      content: [{ type: "text", text: "received " + input.length }],
      model: "fixture/model",
      stopReason: "stop",
      usage,
    } },
  ];
  process.stdout.write(events.map((event) => JSON.stringify(event)).join("\\n") + "\\n");
});
`, { encoding: "utf8" });
  const previousScript = process.argv[1];
  process.argv[1] = script;
  try {
    return await callback(directory);
  } finally {
    process.argv[1] = previousScript;
    await rm(directory, { recursive: true, force: true });
  }
};

test("fallback invocation runs the installed CLI script, not the `pi` shim", () => {
  // A bare `pi` command cannot be spawned without a shell when npm installs
  // it as pi.cmd on Windows, so the fallback must resolve dist/cli.js.
  const realArgv = process.argv;
  try {
    Object.defineProperty(process, "argv", { value: [realArgv[0], "/$bunfs/root/cli.js"], configurable: true });
    const invocation = getPiInvocation(["--mode", "json"]);
    assert.equal(invocation.command, process.execPath);
    assert.match(invocation.args[0] ?? "", /cli\.js$/);
    assert.deepEqual(invocation.args.slice(1), ["--mode", "json"]);
  } finally {
    Object.defineProperty(process, "argv", { value: realArgv, configurable: true });
  }
});

test("child args inherit parent model, thinking, and tools and exclude subagent", () => {
  const args = buildChildArgs(
    { model: "provider/model", thinking: "medium", tools: ["read", "subagent", "custom_tool"] },
  );
  assert.deepEqual(args.slice(0, 8), [
    "--mode", "json", "-p", "--no-session", "--no-skills", "--no-prompt-templates", "--exclude-tools", "subagent",
  ]);
  assert.equal(args[args.indexOf("--tools") + 1], "read,custom_tool");
  assert.equal(args[args.indexOf("--model") + 1], "provider/model");
  assert.equal(args[args.indexOf("--thinking") + 1], "medium");
  assert.ok(!args.includes("Task: inspect"));
});

test("disables tools when the parent exposes none", () => {
  const args = buildChildArgs({ tools: [] });
  assert.ok(args.includes("--no-tools"));
  assert.ok(args.includes("--exclude-tools"));
});

test("streams assistant text deltas and aggregates final usage", () => {
  const state = childState();
  reduceJsonLine(state, assistantEvent());
  reduceJsonLine(state, JSON.stringify({
    type: "message_start",
    message: { role: "assistant", content: [] },
  }));
  reduceJsonLine(state, JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Par" },
  }));
  reduceJsonLine(state, JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tial" },
  }));
  assert.equal(state.output, "Partial");

  reduceJsonLine(state, assistantEvent({ content: [{ type: "text", text: "Final." }] }));
  assert.equal(state.output, "Final.");
  assert.deepEqual(
    { input: state.usage.input, output: state.usage.output, totalTokens: state.usage.totalTokens, totalCost: state.usage.cost.total },
    { input: 20, output: 6, totalTokens: 32, totalCost: 20 },
  );
  assert.throws(() => reduceJsonLine(state, "not json"), /invalid child JSONL/);
});

test("clears retry errors and includes tool-result usage", () => {
  const state = childState();
  reduceJsonLine(state, assistantEvent({ stopReason: "error", errorMessage: "temporary failure" }));
  reduceJsonLine(state, JSON.stringify({
    type: "message_start",
    message: { role: "assistant", content: [] },
  }));
  assert.equal(state.output, "");
  assert.equal(state.stopReason, undefined);
  assert.equal(state.errorMessage, undefined);

  reduceJsonLine(state, assistantEvent({ content: [{ type: "text", text: "Recovered." }] }));
  reduceJsonLine(state, JSON.stringify({
    type: "message_end",
    message: {
      role: "toolResult",
      usage: {
        input: 4, output: 5, cacheRead: 6, cacheWrite: 7, totalTokens: 22,
        cacheWrite1h: 8, reasoning: 9,
        cost: { input: 10, output: 11, cacheRead: 12, cacheWrite: 13, total: 46 },
      },
    },
  }));
  assert.deepEqual(
    {
      input: state.usage.input,
      output: state.usage.output,
      totalTokens: state.usage.totalTokens,
      totalCost: state.usage.cost.total,
      cacheWrite1h: state.usage.cacheWrite1h,
      reasoning: state.usage.reasoning,
    },
    { input: 24, output: 11, totalTokens: 54, totalCost: 66, cacheWrite1h: 8, reasoning: 9 },
  );
});

test("truncates visible output without writing a durable artifact", () => {
  const output = truncateToolOutput("x".repeat(60 * 1024));
  assert.ok(Buffer.byteLength(output, "utf8") <= 50 * 1024);
  assert.ok(output.split("\n").length <= 2_000);
  assert.match(output, /\[Output truncated\]$/);
});

test("registers a parallel subagent tool with a pinned task", () => {
  let tool;
  extensionModule.default({ registerTool(definition) { tool = definition; } });
  assert.equal(tool.name, "subagent");
  assert.equal(tool.label, "Subagent");
  assert.equal(tool.executionMode, "parallel");
  assert.deepEqual(Object.keys(tool.parameters.properties), ["task"]);
  assert.deepEqual(tool.renderCall().render(80), ["Subagent"]);
  assert.deepEqual(tool.renderCall({ task: "inspect files" }).render(80), ["Subagent", "Task: inspect files"]);
  assert.match(tool.promptGuidelines.join("\n"), /independent, non-overlapping tasks/);
});

test("runs a long task through child stdin", async () => {
  await withChildFixture(async (cwd) => {
    const tool = registerTool();
    const task = `inspect the repository\n${"x".repeat(9_000)}`;
    const updates = [];
    const result = await tool.execute(
      "fixture-call",
      { task },
      undefined,
      (update) => updates.push(update),
      { cwd },
    );
    const expectedInput = `Task: ${task}`;
    assert.equal(await readFile(join(cwd, "received-task"), "utf8"), expectedInput);
    const childArgs = JSON.parse(await readFile(join(cwd, "received-args"), "utf8"));
    assert.ok(!childArgs.includes(expectedInput));
    assert.equal(result.content[0].text, `received ${expectedInput.length}`);
    assert.equal(result.details.model, "fixture/model");
    assert.deepEqual(result.usage, {
      input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    });
    assert.ok(updates.some((update) => update.content?.[0]?.text === "streamed"));
  });
});

test("reports a bounded child diagnostic", async () => {
  await withChildFixture(async (cwd) => {
    await writeFile(join(cwd, "fail"), "", { encoding: "utf8" });
    const tool = registerTool();
    await assert.rejects(
      tool.execute("fixture-call", { task: "failure task" }, undefined, undefined, { cwd }),
      (error) => {
        assert.match(error.message, /fixture failure$/);
        assert.ok(error.message.length <= "subagent failed: ".length + 8_000);
        return true;
      },
    );
    assert.equal(await readFile(join(cwd, "received-task"), "utf8"), "Task: failure task");
  });
});

test("does not register in a child process", () => {
  const previous = process.env.PI_MINIMAL_SUBAGENTS_CHILD;
  process.env.PI_MINIMAL_SUBAGENTS_CHILD = "1";
  try {
    let registrations = 0;
    extensionModule.default({ registerTool() { registrations += 1; } });
    assert.equal(registrations, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_MINIMAL_SUBAGENTS_CHILD;
    else process.env.PI_MINIMAL_SUBAGENTS_CHILD = previous;
  }
});
