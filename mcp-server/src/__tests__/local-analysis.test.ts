import assert from "node:assert";
import { describe, it } from "node:test";
import type { CanonicalEvent } from "../event-envelope.js";
import { deriveIntentTokenBreakdown, generateFollowupArtifacts } from "../local-analysis.js";
import { deriveSubagentGraph } from "../subagent-analysis.js";

function baseEvent(overrides: Partial<CanonicalEvent>): CanonicalEvent {
  return {
    id: "e-1",
    session_id: "sess-test",
    seq: 1,
    ts: "2026-03-03T00:00:00.000Z",
    kind: "intent",
    actor: { type: "agent" },
    payload: {},
    schema_version: 1,
    ...overrides,
  };
}

describe("local-analysis", () => {
  it("generates per-intent artifacts with deterministic template", () => {
    const events: CanonicalEvent[] = [
      baseEvent({
        id: "i1",
        seq: 1,
        kind: "intent",
        scope: { intent_id: "intent_a" },
        payload: { intent_id: "intent_a", title: "Implement feature A" },
      }),
      baseEvent({
        id: "t1",
        seq: 2,
        kind: "tool_call",
        scope: { intent_id: "intent_a" },
        payload: { category: "tool", action: "read_file", target: "src/a.ts" },
      }),
      baseEvent({
        id: "t2",
        seq: 3,
        kind: "tool_call",
        scope: { intent_id: "intent_a" },
        payload: { category: "tool", action: "read_file", target: "src/a.ts" },
      }),
      baseEvent({
        id: "t3",
        seq: 4,
        kind: "tool_call",
        scope: { intent_id: "intent_a" },
        payload: { category: "tool", action: "read_file", target: "src/a.ts" },
      }),
      baseEvent({
        id: "v1",
        seq: 5,
        kind: "verification",
        scope: { intent_id: "intent_a" },
        payload: { type: "test", result: "fail" },
      }),
      baseEvent({
        id: "r1",
        seq: 6,
        kind: "risk_signal",
        scope: { intent_id: "intent_a", file: "src/a.ts" },
        payload: { level: "high", reasons: ["regression risk"] },
      }),
    ];

    const result = generateFollowupArtifacts(events, {
      mode: "per_intent",
      strictness: "soft",
      focus: "risk",
    });

    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].intent_id, "intent_a");
    assert.equal(result.artifacts[0].rule_template_id, "high_risk_guardrail");
    assert.ok(result.artifacts[0].value_claims.risk_mitigation.length > 0);
  });

  it("derives token breakdown context/output split", () => {
    const events: CanonicalEvent[] = [
      baseEvent({
        id: "i1",
        seq: 1,
        kind: "intent",
        scope: { intent_id: "intent_a" },
        payload: { intent_id: "intent_a", title: "Intent A" },
      }),
      baseEvent({
        id: "ctx1",
        seq: 2,
        kind: "tool_call",
        scope: { intent_id: "intent_a" },
        payload: { category: "search", action: "search_docs", target: "api docs" },
      }),
      baseEvent({
        id: "tok1",
        seq: 3,
        kind: "token_usage_checkpoint",
        scope: { intent_id: "intent_a" },
        payload: { usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
      }),
      baseEvent({
        id: "out1",
        seq: 4,
        kind: "file_op",
        scope: { intent_id: "intent_a", file: "src/a.ts" },
        payload: { category: "file", action: "edit", target: "src/a.ts" },
      }),
      baseEvent({
        id: "tok2",
        seq: 5,
        kind: "token_usage_checkpoint",
        scope: { intent_id: "intent_a" },
        payload: { usage: { total_tokens: 90 } },
      }),
    ];
    const result = deriveIntentTokenBreakdown(events);
    assert.equal(result.intent_breakdown.length, 1);
    assert.equal(result.totals.total_tokens, 240);
    assert.equal(
      result.intent_breakdown[0].context_tokens +
        result.intent_breakdown[0].output_tokens +
        result.intent_breakdown[0].unknown_tokens,
      240
    );
  });

  it("derives deterministic subagent graph with synthetic fallback ids", () => {
    const events: CanonicalEvent[] = [
      baseEvent({
        id: "s1",
        seq: 1,
        kind: "intent",
        actor: { type: "agent", id: "coordinator" },
        scope: { intent_id: "intent_root", agent_id: "coordinator" },
        payload: { title: "Coordinate release" },
      }),
      baseEvent({
        id: "d1",
        seq: 2,
        kind: "tool_call",
        actor: { type: "agent", id: "coordinator" },
        scope: { intent_id: "intent_root", agent_id: "coordinator", delegation_id: "del_1" },
        payload: { category: "execution", action: "delegate_task", target: "child" },
      }),
      baseEvent({
        id: "c1",
        seq: 3,
        kind: "intent",
        actor: { type: "agent", id: "child_agent" },
        scope: { intent_id: "intent_child", parent_agent_id: "coordinator", delegation_id: "del_1" },
        payload: { title: "Implement child task" },
      }),
      baseEvent({
        id: "c2",
        seq: 4,
        kind: "file_op",
        actor: { type: "agent", id: "child_agent" },
        scope: { intent_id: "intent_child", parent_agent_id: "coordinator", file: "src/child.ts" },
        payload: { category: "file", action: "edit", target: "src/child.ts" },
      }),
      baseEvent({
        id: "c3",
        seq: 5,
        kind: "token_usage_checkpoint",
        actor: { type: "agent", id: "child_agent" },
        scope: { intent_id: "intent_child", parent_agent_id: "coordinator" },
        payload: { usage: { total_tokens: 220 } },
      }),
    ];

    const graph = deriveSubagentGraph(events);
    assert.equal(graph.nodes.length >= 2, true);
    assert.equal(graph.edges.length >= 1, true);
    assert.equal(graph.summary.agent_count, graph.nodes.length);
    assert.equal(
      graph.summary.token_total,
      graph.nodes.reduce((sum, node) => sum + node.token_total, 0)
    );
  });
});
