import assert from "node:assert/strict";
import test from "node:test";

const extensionModule = await import("./index.ts");
const { buildChildArgs, reduceJsonLine, truncateToolOutput } = extensionModule;

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

test("child args inherit parent model, thinking, and tools and exclude subagent", () => {
  const args = buildChildArgs(
    { model: "provider/model", thinking: "medium", tools: ["read", "subagent", "custom_tool"] },
    "Task: inspect",
  );
  assert.deepEqual(args.slice(0, 8), [
    "--mode", "json", "-p", "--no-session", "--no-skills", "--no-prompt-templates", "--exclude-tools", "subagent",
  ]);
  assert.equal(args[args.indexOf("--tools") + 1], "read,custom_tool");
  assert.equal(args[args.indexOf("--model") + 1], "provider/model");
  assert.equal(args[args.indexOf("--thinking") + 1], "medium");
  assert.equal(args[args.length - 1], "Task: inspect");
});

test("disables tools when the parent exposes none", () => {
  const args = buildChildArgs({ tools: [] }, "Task: work");
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
