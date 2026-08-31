# minimal-subagents

A [pi](https://github.com/earendil-works/pi-coding-agent) coding-agent extension that adds a single `subagent` tool for delegating self-contained tasks to child sessions.

It is deliberately small. The tool takes one parameter, `task`, and returns the child's final answer. Nothing else.

## Why

* Minimal context overhead. The tool definition is a single parameter, results are truncated before they return, and the child's intermediate work never enters the parent context.
* Isolated context. Each subagent runs in a fresh headless `pi` process, so noisy exploration stays out of your session.
* Fan-out. The tool runs in parallel mode, so independent subagents can execute at the same time.
* No bloat. No orchestration framework, no planning DSL, no configuration file, no extra tools.

## How it works

Each subagent call spawns a headless `pi` process with:

* the current session's model and thinking level
* the same tools as the parent, minus `subagent` and `compress`, so subagents cannot recurse or compact a disposable worker
* no session persistence, skills, or prompt templates, so each child starts clean and never inherits parent history

Every child prompt starts with a fixed handoff contract: the child's final message is a handoff to the parent, not a transcript of its work. Exploratory output, dead ends, and raw source stay in the child. The task follows the contract, keeping the child's prompt prefix stable.

The contract-prefixed task is passed on stdin. The returned handoff is capped at roughly 4k tokens (~16 KB) with no configuration. Output streams back to the parent while the child runs, and the child's token usage is credited to the parent session. Aborting the call kills the child process tree.

## Install

Clone the repository into pi's extensions directory and install dependencies:

```sh
git clone https://github.com/sij0sh/minimal-subagents.git ~/.pi/agent/extensions/minimal-subagents
cd ~/.pi/agent/extensions/minimal-subagents
npm install
```

Restart pi, then ask it to delegate a task to a subagent.

## Tests

```sh
npm install
npm test
```
