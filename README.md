# minimal-subagents

> **Disposable context with almost no decision overhead.**

`minimal-subagents` gives Pi a single `subagent` tool. It moves self-contained work out of the parent context and returns only what is worth keeping.

A [Pi](https://github.com/earendil-works/pi-coding-agent) coding-agent extension.

The interface is one call:

```text id="5nc8bd"
subagent({
  task: "Trace where this configuration value is read and identify the behavior it controls."
})
```

One tool, one string parameter. The model's only decision is whether a task is self-contained enough to hand off. That smallness is deliberate context engineering.

## Why

A coding agent's context is working memory. Over a session it accumulates file contents, search results, command output, hypotheses, dead ends, corrections, and intermediate reasoning.

Some of that information matters to the final decision. Most of it matters only while reaching that decision.

Keeping all of it in the parent session increases the context load. Text that has stopped being useful still sits in the window on every later turn.

It can also increase cognitive load. The model has to switch between reasoning frames, remember which investigation produced which conclusion, and find its way back to the original objective after unrelated exploratory work.

A larger context window fits more of this history. It does not make the history free.

For independent work, the parent usually does not need the investigation. It needs the result.

`minimal-subagents` creates that boundary.

```text id="ylvi7m"
parent context
    |
    | self-contained task
    v
+--------------------+
| disposable child   |
|                    |
| search             |
| inspect            |
| test               |
| explore            |
| reject dead ends   |
+--------------------+
    |
    | bounded handoff
    v
parent context
```

The child gets its own clean reasoning context and can accumulate whatever temporary information the task requires. The parent gets back conclusions, evidence, useful locations, next actions, and unresolved uncertainty. The exploration stays disposable.

## Tools are context too

The conversation is only half of the context. The tools the model can call also shape what it has to reason about.

Every additional tool expands what the model might do. Modes, parameters, agent types, routing options, and configuration choices expand it again. The model has to sort through all of it before the actual work starts.

A delegation system can therefore cut context in one place and add thinking overhead in another. For example, a model might be asked to decide:

```text id="27co1v"
Should I delegate?
Which worker type should I choose?
How difficult is this task?
Which model should run it?
How much reasoning should it use?
Should it run sequentially or in parallel?
How much context should I send?
Can that worker delegate again?
```

Those decisions are not free, and in many cases they are unnecessary.

`minimal-subagents` leaves the model one question. Can this task be made self-contained and completed independently? If yes, delegate it. The extension chooses the rest.

## Why one tool?

The extension adds exactly one model-facing capability:

```text id="9tnf7y"
subagent({ task: "..." })
```

There are no separate tools for research, review, debugging, tracing, planning, or difficulty levels. Those are tasks, not tool types. A separate tool for each would force the model to classify work before doing it, and the extra choices would stay in every session where the extension is enabled.

The `subagent` description and its guidance are narrow on purpose. They were hand-authored and A/B tested to keep model-facing text as short as possible while still making the one rule clear. Delegate independent work that can be self-contained.

The minimalism here is not aesthetic. A delegation extension that adds decisions becomes part of the load problem it is meant to solve.

## Why no difficulty setting?

The parent never labels a delegated task easy, medium, hard, complex, deep, or anything similar. Doing so would force the model to answer a separate question before it starts. How difficult will this task be? That answer can stay uncertain precisely because nobody has explored the task yet. It would also add a routing decision unrelated to the useful one, which is whether the work is delegable at all.

Instead, the child inherits the current session's model and thinking level. The parent decides what work gets isolated, not how hard that work should be.

## Isolation, not compression

`minimal-subagents` does not try to summarize the parent's growing conversation. It prevents independent exploratory work from entering that conversation in the first place.

Each call starts a fresh headless Pi process with:

* the current session's model
* the current session's thinking level
* the parent's active tools, except `subagent` and `compress`
* no persisted session
* no inherited skills
* no inherited prompt templates

The child starts with the task to solve, not the history of how the parent got there. Subagents cannot create further subagents either. The boundary stays one level deep and predictable.

## The handoff is the interface

Isolation only helps if useful state can cross the boundary. Every child receives a fixed handoff contract before its task, and its final message is not meant to be a transcript of the work.

The child returns only what another coding agent needs to continue:

* conclusions
* precise file or symbol locations
* material command or test outcomes
* recommended next actions
* unresolved uncertainty

The contract also tells it what to leave behind:

* exploratory output
* dead ends
* routine successful output
* source text the parent can retrieve directly if needed

The returned handoff is capped at roughly 4k tokens / 16 KB. Without that cap, delegation would move the context problem into a child and then dump it back into the parent.

The child context is temporary. The handoff is the state worth preserving.

## Parallelism falls out of isolation

Independent tasks do not need to share the parent's context. They do not need to run one after another either. `subagent` uses Pi's parallel execution mode, so independent calls can run at the same time:

```text id="fn72z0"
Investigate these independently:

1. Trace where authentication state is created and invalidated.
2. Find the tests that cover token expiration.
3. Check whether the public API documents refresh behavior.
```

Each investigation gets its own working context and returns its own bounded handoff. Parallelism helps, but the point is independent context.

## When to delegate

Use a subagent when a task can be stated on its own and the parent mainly needs its conclusions. Good candidates:

* tracing an unfamiliar subsystem
* locating the source of a behavior
* inspecting a separate package or module
* researching an API or dependency
* running an independent verification pass
* comparing independent implementation options
* reviewing a bounded part of a codebase

Ask one question before delegating. Could the child do this from the task description and the repository state, then hand back enough for the parent to continue? If yes, delegation can keep substantial exploratory state out of the parent context.

## When not to delegate

Isolation has a cost. The child does not inherit the parent's conversation, so the task must contain the state it needs. Do not delegate work that depends heavily on implicit conversational state, needs continuous coordination with the parent, or would require reproducing most of the parent context just to make the task self-contained.

Do not split work merely because subagents exist. More agents are not inherently better context engineering. A useful boundary removes more cognitive state than the handoff introduces.

The goal is not to maximize delegation. The goal is to keep the active working set small.

## How it works

Each call spawns a headless Pi process and passes a fixed handoff contract followed by the requested task on stdin. The child's model, thinking level, and active tools come from the parent session. `subagent` and `compress` are removed, so workers cannot delegate recursively or compact a disposable context.

The child's final response streams back while it is produced. The result is capped at roughly 16 KB, and the child's token usage is credited to the parent session. Aborting the tool call terminates the child process tree.

There is no session persistence, agent hierarchy, difficulty selector, planning DSL, configuration file, or additional tool surface. Those omissions are features.

## Install

Clone the repository into Pi's extensions directory and install dependencies:

```sh id="6xe5o7"
git clone https://github.com/sij0sh/minimal-subagents.git ~/.pi/agent/extensions/minimal-subagents
cd ~/.pi/agent/extensions/minimal-subagents
npm install
```

Restart Pi, then ask it to delegate a self-contained task to a subagent.

## Tests

```sh id="s6npqo"
npm install
npm test
```
