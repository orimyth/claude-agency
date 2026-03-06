# Claude Agency - Optimization Report

## 1. Why "Opus 4.1" Is Used (Model Selection Analysis)

**Finding:** There is NO explicit model selection anywhere in the codebase. The project uses `@anthropic-ai/claude-code` SDK's `query()` function without specifying a model parameter. The SDK internally selects the model — which defaults to **Claude Opus** (the most capable, most expensive model).

This means every single Claude call — whether it's a 50-turn complex development task or a 1-turn "classify this 10-word message" call — uses the same Opus-tier model.

**Impact:** This is the single biggest cost driver. Opus is ~15x more expensive than Haiku per token. The system makes many lightweight calls (intent classification, learning extraction, memory summarization, chat responses, status reports) that could use a smaller model.

### Where Opus Is Used Unnecessarily

| Call Site | File | Turns | Purpose | Should Use |
|-----------|------|-------|---------|------------|
| `classifyIntent()` | index.ts:649 | 1 | Classify 1 sentence | Haiku |
| `extractLearnings()` | memory-manager.ts:150 | 1 | Extract JSON from text | Haiku |
| `summarizeCategory()` | memory-manager.ts:227 | 1 | Summarize memories | Sonnet |
| `agentToAgentChat()` | agent-manager.ts:547 | 1 | 1-2 sentence Slack msg | Sonnet |
| `chat()` (casual) | agent-manager.ts:504 | 1 | Casual conversation | Sonnet |
| Status reports | index.ts:429 | 1 | 2-4 sentence update | Haiku |
| CEO evaluation | workflow-engine.ts:104 | 15 | Project planning | Opus (correct) |
| Task execution | agent-manager.ts:174 | 50 | Actual coding work | Opus (correct) |

**Estimated savings:** 40-60% cost reduction by routing lightweight calls to smaller models.

---

## 2. Token Usage Optimization Opportunities

### 2.1 Redundant System Prompt in Task Prompts
**Problem:** `buildTaskPrompt()` (agent-manager.ts:298) starts with `You are ${blueprint.name}, the ${blueprint.role}` — but this is ALREADY in the `customSystemPrompt` passed to the SDK. The system prompt for each agent already contains their full identity and instructions.

**Fix:** Remove the redundant identity line from the task prompt. Save ~20-50 tokens per call × hundreds of calls.

### 2.2 Verbose API Instructions Injected Every Task
**Problem:** Management roles get ~400 tokens of API instructions injected into EVERY task prompt (lines 336-369). Worker roles get ~200 tokens of git push API docs (lines 373-395). These instructions are identical every time.

**Fix:** Move API instructions into the `systemPrompt` of each blueprint. The SDK caches system prompts, so they'll be served from cache on subsequent calls instead of consuming new input tokens.

### 2.3 Memory Context Injected Unconditionally
**Problem:** `buildContext()` is called for every task, even when there are zero relevant memories. The query itself (hitting MySQL for 30 memories) runs every time.

**Fix:** Add early-exit check: skip memory query for newly initialized agencies with no memories. Add a simple in-memory flag.

### 2.4 Double Claude Calls for Learning Extraction
**Problem:** After every completed task, `extractLearnings()` makes a separate Claude call to extract learnings. Then if threshold is hit, `summarizeCategory()` makes ANOTHER Claude call. That's 2 extra Opus calls per task completion.

**Fix:**
- Use Haiku for extraction (it's just JSON extraction from text)
- Batch summarization: don't summarize on every `remember()` call — run it on a timer (e.g., every 30 minutes) or when agent is idle

### 2.5 Chat History Rebuilt From Scratch Every Message
**Problem:** In `setupSlackBridge()` (index.ts:559-565), the full chat history is fetched and formatted as a string for EVERY message. For active conversations, this means the same 10 messages are re-sent as context repeatedly.

**Fix:** This is inherent to stateless SDK calls, but could be mitigated by limiting history to 5 messages instead of 10 for casual chats.

### 2.6 Intent Classification + Chat = Double Call
**Problem:** When the investor sends a message via Slack, TWO Claude calls happen:
1. `chat('ceo', msg.text, ...)` — Alice responds conversationally
2. `classifyIntent(msg.text)` — Classify the intent

**Fix:** Combine into a single call: ask Alice to respond AND classify in one prompt. Save ~500-1000 tokens per investor message.

### 2.7 Status Reports Use Full Chat Pipeline
**Problem:** The 15-minute status report (index.ts:429) calls `this.agentManager.chat('ceo', '', context)` which goes through the full chat pipeline including the CEO's entire system prompt (~500 tokens).

**Fix:** Use a direct lightweight query with minimal system prompt for status reports.

---

## 3. Agent Collaboration Improvements

### 3.1 Notification Storm on Task Completion
**Problem:** When a worker completes a task, the system:
1. Worker emits message → saved to DB + broadcast + Slack
2. Auto-creates QA task → QA agent starts (full Opus session)
3. `agentToAgentChat(worker, 'pm', ...)` → PM gets a chat (Opus call)
4. QA finishes → another `agentToAgentChat(qa, 'pm', ...)` (Opus call)
5. If QA passes → PM notified again
6. Memory extraction runs on worker result AND QA result

That's 4-5 Claude calls just for the notification chain of ONE completed task.

**Fix:**
- Make worker→PM notification a simple broadcast (no Claude call needed — just emit a system message)
- Only use `agentToAgentChat` when the receiving agent needs to take action
- Skip learning extraction on QA review results (they're derivative of the original work)

### 3.2 No Shared Context Between Sequential Agents
**Problem:** When QA reviews a developer's work, the QA task description includes only a truncated version of the original task description (500 chars). QA has no access to what the developer actually did, what files were changed, or the developer's own summary.

**Fix:** Include the developer's result text (truncated to 1000 chars) in the QA task description. This reduces QA's need to explore blindly.

### 3.3 PM Gets Spammed With Every Completion
**Problem:** Every single task completion triggers a chat to Diana (PM). If 5 developers finish simultaneously, that's 5 separate Claude calls where Diana just says "nice, got it."

**Fix:** Batch PM notifications. Instead of chatting immediately, queue completions and send a single summary every 2-5 minutes.

### 3.4 No Task Result Handoff
**Problem:** When a task depends on another (`dependsOn`), the dependent task starts with zero context about what the predecessor accomplished. The developer has to figure it out from the codebase.

**Fix:** When unblocking dependent tasks, inject a summary of the predecessor's result into the dependent task's prompt.

### 3.5 Agent-to-Agent Chat Is Wasteful for Notifications
**Problem:** `agentToAgentChat()` creates a full Claude session for each notification. Most agent-to-agent chats are just status updates that don't need AI-generated responses.

**Fix:** Add a `notify()` method that sends a pre-formatted message without invoking Claude. Reserve `agentToAgentChat()` for when the receiving agent actually needs to think and respond.

---

## 4. Summary of Recommended Changes (Priority Order)

| # | Change | Token Savings | Effort |
|---|--------|--------------|--------|
| 1 | Use Haiku/Sonnet for lightweight calls (classify, extract, summarize, chat) | 40-60% | Medium |
| 2 | Merge intent classification + CEO chat into single call | ~500-1000 tokens/msg | Low |
| 3 | Move API instructions to system prompts (cacheable) | ~400 tokens/task | Low |
| 4 | Replace notification chats with simple broadcasts | 3-4 Opus calls/task | Low |
| 5 | Remove redundant identity from task prompts | ~30 tokens/task | Trivial |
| 6 | Pass predecessor results to dependent tasks | Better quality | Low |
| 7 | Include dev results in QA task descriptions | Better QA quality | Low |
| 8 | Batch PM notifications | 3-5 Opus calls/batch | Medium |
| 9 | Skip learning extraction for QA/notification results | 1-2 Opus calls/task | Trivial |
| 10 | Reduce chat history from 10 to 5 for casual chats | ~200 tokens/msg | Trivial |
