import type { SessionEvent } from "../types/session";

export interface SubagentNode {
  agent_id: string;
  label: string;
  level: number;
  synthetic: boolean;
  parent_agent_id?: string;
  start_seq: number;
  end_seq: number;
  status: "active" | "completed" | "failed" | "blocked";
  token_total: number;
  context_tokens: number;
  output_tokens: number;
  unknown_tokens: number;
  estimated_cost_usd?: number;
  deliverable_count: number;
  event_count: number;
  evidence_event_ids: string[];
}

export interface SubagentEdge {
  from_agent_id: string;
  to_agent_id: string;
  delegation_id?: string;
  handoff_status: "ok" | "timeout" | "failed" | "abandoned";
  wait_ms: number;
  retry_count: number;
  evidence_event_ids: string[];
}

export interface SubagentBottleneck {
  type: "handoff_wait" | "retry_loop" | "verification_fail" | "cost_waste";
  severity: "high" | "medium";
  agent_id?: string;
  edge_id?: string;
  reason: string;
  evidence_event_ids: string[];
}

export interface SubagentGraphResult {
  nodes: SubagentNode[];
  edges: SubagentEdge[];
  critical_path: string[];
  bottlenecks: SubagentBottleneck[];
  summary: {
    agent_count: number;
    edge_count: number;
    token_total: number;
    context_tokens: number;
    output_tokens: number;
    unknown_tokens: number;
    estimated_cost_usd?: number;
    confidence: "high" | "medium" | "low";
    synthetic_node_ratio: number;
  };
}

interface WorkingNode {
  agent_id: string;
  synthetic: boolean;
  parent_agent_id?: string;
  level: number;
  start_seq: number;
  end_seq: number;
  token_total: number;
  context_tokens: number;
  output_tokens: number;
  unknown_tokens: number;
  estimated_cost_usd: number;
  deliverable_count: number;
  event_count: number;
  fail_count: number;
  evidence_event_ids: string[];
  first_ts?: string;
  last_ts?: string;
}

const TOKEN_NEIGHBORHOOD_RADIUS = 5;
const WAIT_ALERT_MS = 30_000;

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function payload(event: SessionEvent): Record<string, unknown> {
  return event.payload ?? {};
}

function eventMs(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : 0;
}

function getUsage(event: SessionEvent): { total_tokens: number; estimated_cost_usd: number } | null {
  const p = payload(event);
  const usageRaw = p.usage;
  const usage = usageRaw && typeof usageRaw === "object" ? (usageRaw as Record<string, unknown>) : null;
  if (!usage) return null;
  const prompt = toNumber(usage.prompt_tokens);
  const completion = toNumber(usage.completion_tokens);
  const totalRaw = toNumber(usage.total_tokens);
  const total = totalRaw > 0 ? totalRaw : prompt + completion;
  if (total <= 0) return null;
  return {
    total_tokens: total,
    estimated_cost_usd: Math.max(0, toNumber(usage.estimated_cost_usd)),
  };
}

function isContextEvent(event: SessionEvent): boolean {
  if (event.kind === "tool_call") {
    const category = toStringValue(payload(event).category);
    return category === "search" || category === "tool" || category === "execution";
  }
  if (event.kind === "artifact_created") {
    const artifact = (toStringValue(payload(event).artifact_type) ?? "").toLowerCase();
    return artifact === "reasoning";
  }
  return false;
}

function isOutputEvent(event: SessionEvent): boolean {
  if (event.kind === "file_op" || event.kind === "diff_summary") return true;
  if (event.kind === "artifact_created") {
    const artifact = (toStringValue(payload(event).artifact_type) ?? "").toLowerCase();
    return ["file", "patch", "report", "test", "build", "migration", "pr"].includes(artifact);
  }
  return false;
}

function inferAgentId(event: SessionEvent, fallbackPrefix: string): { id: string; synthetic: boolean } {
  const p = payload(event);
  const explicit =
    toStringValue(event.scope?.agent_id) ??
    toStringValue(p.agent_id) ??
    (event.actor.type === "agent" ? toStringValue(event.actor.id) : undefined);
  if (explicit) return { id: explicit, synthetic: false };
  const intent = toStringValue(event.scope?.intent_id) ?? toStringValue(p.intent_id) ?? "intent_fallback";
  const moduleName = toStringValue(event.scope?.module) ?? "general";
  const bucket = Math.max(0, Math.floor(event.seq / 50));
  return { id: `${fallbackPrefix}${intent}:${moduleName}:${bucket}`, synthetic: true };
}

function inferParentId(event: SessionEvent): string | undefined {
  const p = payload(event);
  return toStringValue(event.scope?.parent_agent_id) ?? toStringValue(p.parent_agent_id);
}

function inferDelegationId(event: SessionEvent): string | undefined {
  const p = payload(event);
  return toStringValue(event.scope?.delegation_id) ?? toStringValue(p.delegation_id) ?? toStringValue(p.task_id);
}

function deriveTokenSplit(events: SessionEvent[], usageEvent: SessionEvent, usage: { total_tokens: number }) {
  const near = events.filter((e) => e.seq !== usageEvent.seq && Math.abs(e.seq - usageEvent.seq) <= TOKEN_NEIGHBORHOOD_RADIUS);
  let contextWeight = 0;
  let outputWeight = 0;
  for (const e of near) {
    if (isContextEvent(e)) contextWeight += 2;
    if (isOutputEvent(e)) outputWeight += 2;
    if (!isContextEvent(e) && !isOutputEvent(e)) {
      contextWeight += 0.2;
      outputWeight += 0.2;
    }
  }
  if (contextWeight === 0 && outputWeight === 0) {
    return { context: 0, output: 0, unknown: usage.total_tokens };
  }
  const totalWeight = contextWeight + outputWeight;
  const context = Math.round((usage.total_tokens * contextWeight) / totalWeight);
  const output = Math.round((usage.total_tokens * outputWeight) / totalWeight);
  const unknown = Math.max(0, usage.total_tokens - context - output);
  return { context, output, unknown };
}

export function deriveSubagentGraph(eventsRaw: SessionEvent[]): SubagentGraphResult {
  const events = [...eventsRaw].sort((a, b) => (a.seq === b.seq ? a.ts.localeCompare(b.ts) : a.seq - b.seq));
  if (events.length === 0) {
    return {
      nodes: [],
      edges: [],
      critical_path: [],
      bottlenecks: [],
      summary: {
        agent_count: 0,
        edge_count: 0,
        token_total: 0,
        context_tokens: 0,
        output_tokens: 0,
        unknown_tokens: 0,
        confidence: "low",
        synthetic_node_ratio: 0,
      },
    };
  }

  const nodeMap = new Map<string, WorkingNode>();
  const edgeMap = new Map<string, SubagentEdge>();
  const delegationOwner = new Map<string, string>();
  const eventAgent = new Map<string, string>();

  let coordinatorId: string | null = null;

  for (const event of events) {
    const inferred = inferAgentId(event, "agent:");
    const agentId = inferred.id;
    eventAgent.set(event.id, agentId);
    if (!coordinatorId) coordinatorId = agentId;

    const parentExplicit = inferParentId(event);
    const delegationId = inferDelegationId(event);

    const existing = nodeMap.get(agentId) ?? {
      agent_id: agentId,
      synthetic: inferred.synthetic,
      parent_agent_id: parentExplicit,
      level: 0,
      start_seq: event.seq,
      end_seq: event.seq,
      token_total: 0,
      context_tokens: 0,
      output_tokens: 0,
      unknown_tokens: 0,
      estimated_cost_usd: 0,
      deliverable_count: 0,
      event_count: 0,
      fail_count: 0,
      evidence_event_ids: [],
      first_ts: event.ts,
      last_ts: event.ts,
    };

    existing.synthetic = existing.synthetic && inferred.synthetic;
    existing.start_seq = Math.min(existing.start_seq, event.seq);
    existing.end_seq = Math.max(existing.end_seq, event.seq);
    existing.event_count += 1;
    existing.last_ts = event.ts;
    if (!existing.first_ts) existing.first_ts = event.ts;

    if (existing.evidence_event_ids.length < 12) existing.evidence_event_ids.push(event.id);

    if (event.kind === "file_op" || event.kind === "diff_summary") existing.deliverable_count += 1;
    if (event.kind === "verification" && toStringValue(payload(event).result) === "fail") existing.fail_count += 1;

    const usage = getUsage(event);
    if (usage) {
      const split = deriveTokenSplit(events, event, usage);
      existing.token_total += usage.total_tokens;
      existing.context_tokens += split.context;
      existing.output_tokens += split.output;
      existing.unknown_tokens += split.unknown;
      existing.estimated_cost_usd += usage.estimated_cost_usd;
    }

    if (parentExplicit) existing.parent_agent_id = parentExplicit;

    nodeMap.set(agentId, existing);

    if (delegationId && !delegationOwner.has(delegationId)) {
      delegationOwner.set(delegationId, agentId);
    }

    if (delegationId) {
      const owner = delegationOwner.get(delegationId);
      if (owner && owner !== agentId) {
        const edgeKey = `${owner}->${agentId}`;
        const edge = edgeMap.get(edgeKey) ?? {
          from_agent_id: owner,
          to_agent_id: agentId,
          delegation_id: delegationId,
          handoff_status: "ok",
          wait_ms: 0,
          retry_count: 0,
          evidence_event_ids: [],
        };
        const fromNode = nodeMap.get(owner);
        const toNode = nodeMap.get(agentId);
        if (fromNode?.last_ts && toNode?.first_ts) {
          const wait = Math.max(0, eventMs(toNode.first_ts) - eventMs(fromNode.last_ts));
          edge.wait_ms = Math.max(edge.wait_ms, wait);
        }
        if (edge.evidence_event_ids.length < 10) edge.evidence_event_ids.push(event.id);
        edgeMap.set(edgeKey, edge);
      }
    }
  }

  if (coordinatorId) {
    for (const node of nodeMap.values()) {
      if (node.agent_id === coordinatorId) continue;
      if (!node.parent_agent_id) node.parent_agent_id = coordinatorId;
      const edgeKey = `${node.parent_agent_id}->${node.agent_id}`;
      if (!edgeMap.has(edgeKey)) {
        edgeMap.set(edgeKey, {
          from_agent_id: node.parent_agent_id,
          to_agent_id: node.agent_id,
          handoff_status: "ok",
          wait_ms: 0,
          retry_count: 0,
          evidence_event_ids: node.evidence_event_ids.slice(0, 2),
        });
      }
    }
  }

  const childMap = new Map<string, string[]>();
  for (const edge of edgeMap.values()) {
    const children = childMap.get(edge.from_agent_id) ?? [];
    if (!children.includes(edge.to_agent_id)) children.push(edge.to_agent_id);
    childMap.set(edge.from_agent_id, children);
  }

  function computeLevel(agentId: string, depth = 0): number {
    const node = nodeMap.get(agentId);
    if (!node) return depth;
    const parent = node.parent_agent_id;
    if (!parent || parent === agentId || !nodeMap.has(parent)) return depth;
    return computeLevel(parent, depth + 1);
  }

  const nodes: SubagentNode[] = [...nodeMap.values()]
    .map((node) => {
      const status: SubagentNode["status"] =
        node.fail_count > 0 ? "failed" : node.deliverable_count > 0 ? "completed" : "active";
      return {
        agent_id: node.agent_id,
        label: node.synthetic ? `Synthetic ${node.agent_id.split(":")[1] ?? "agent"}` : node.agent_id,
        level: computeLevel(node.agent_id),
        synthetic: node.synthetic,
        parent_agent_id: node.parent_agent_id,
        start_seq: node.start_seq,
        end_seq: node.end_seq,
        status,
        token_total: node.token_total,
        context_tokens: node.context_tokens,
        output_tokens: node.output_tokens,
        unknown_tokens: node.unknown_tokens,
        estimated_cost_usd: node.estimated_cost_usd > 0 ? Number(node.estimated_cost_usd.toFixed(6)) : undefined,
        deliverable_count: node.deliverable_count,
        event_count: node.event_count,
        evidence_event_ids: node.evidence_event_ids,
      };
    })
    .sort((a, b) => a.level - b.level || a.start_seq - b.start_seq);

  const pairCounts = new Map<string, number>();
  for (const edge of edgeMap.values()) {
    const key = `${edge.from_agent_id}->${edge.to_agent_id}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }

  const edges: SubagentEdge[] = [...edgeMap.values()].map((edge) => {
    const pairKey = `${edge.from_agent_id}->${edge.to_agent_id}`;
    const retryCount = Math.max(0, (pairCounts.get(pairKey) ?? 1) - 1);
    const toNode = nodes.find((n) => n.agent_id === edge.to_agent_id);
    const handoff_status: SubagentEdge["handoff_status"] =
      toNode?.status === "failed" ? "failed" : edge.wait_ms > WAIT_ALERT_MS ? "timeout" : "ok";
    return {
      ...edge,
      retry_count: retryCount,
      handoff_status,
    };
  });

  const bottlenecks: SubagentBottleneck[] = [];
  for (const node of nodes) {
    if (node.status === "failed") {
      bottlenecks.push({
        type: "verification_fail",
        severity: "high",
        agent_id: node.agent_id,
        reason: `${node.label} has failed verification signals.`,
        evidence_event_ids: node.evidence_event_ids.slice(0, 3),
      });
    }
    if (node.token_total > 0 && node.output_tokens < node.context_tokens * 0.35) {
      bottlenecks.push({
        type: "cost_waste",
        severity: node.token_total > 2500 ? "high" : "medium",
        agent_id: node.agent_id,
        reason: `${node.label} spent many tokens with limited output-producing work.`,
        evidence_event_ids: node.evidence_event_ids.slice(0, 3),
      });
    }
  }

  for (const edge of edges) {
    if (edge.wait_ms > WAIT_ALERT_MS) {
      bottlenecks.push({
        type: "handoff_wait",
        severity: edge.wait_ms > WAIT_ALERT_MS * 3 ? "high" : "medium",
        edge_id: `${edge.from_agent_id}->${edge.to_agent_id}`,
        reason: `Handoff wait ${Math.round(edge.wait_ms / 1000)}s from ${edge.from_agent_id} to ${edge.to_agent_id}.`,
        evidence_event_ids: edge.evidence_event_ids.slice(0, 3),
      });
    }
    if (edge.retry_count >= 2) {
      bottlenecks.push({
        type: "retry_loop",
        severity: "high",
        edge_id: `${edge.from_agent_id}->${edge.to_agent_id}`,
        reason: `Repeated delegation loop detected (${edge.retry_count} retries).`,
        evidence_event_ids: edge.evidence_event_ids.slice(0, 3),
      });
    }
  }

  const root = nodes.find((n) => n.level === 0)?.agent_id;
  const criticalPath: string[] = [];
  if (root) {
    let current = root;
    criticalPath.push(current);
    const visited = new Set<string>([current]);
    while (true) {
      const children = childMap.get(current) ?? [];
      if (children.length === 0) break;
      const next = children
        .map((id) => nodes.find((n) => n.agent_id === id))
        .filter((n): n is SubagentNode => !!n)
        .sort((a, b) => b.token_total - a.token_total || b.end_seq - a.end_seq)[0];
      if (!next || visited.has(next.agent_id)) break;
      criticalPath.push(next.agent_id);
      visited.add(next.agent_id);
      current = next.agent_id;
    }
  }

  const totals = nodes.reduce(
    (acc, node) => {
      acc.total += node.token_total;
      acc.context += node.context_tokens;
      acc.output += node.output_tokens;
      acc.unknown += node.unknown_tokens;
      acc.cost += node.estimated_cost_usd ?? 0;
      return acc;
    },
    { total: 0, context: 0, output: 0, unknown: 0, cost: 0 }
  );

  const syntheticNodeCount = nodes.filter((n) => n.synthetic).length;
  const syntheticRatio = nodes.length > 0 ? syntheticNodeCount / nodes.length : 0;
  const confidence: SubagentGraphResult["summary"]["confidence"] =
    syntheticRatio < 0.3 ? "high" : syntheticRatio < 0.7 ? "medium" : "low";

  return {
    nodes,
    edges,
    critical_path: criticalPath,
    bottlenecks: bottlenecks.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1)),
    summary: {
      agent_count: nodes.length,
      edge_count: edges.length,
      token_total: totals.total,
      context_tokens: totals.context,
      output_tokens: totals.output,
      unknown_tokens: totals.unknown,
      estimated_cost_usd: totals.cost > 0 ? Number(totals.cost.toFixed(6)) : undefined,
      confidence,
      synthetic_node_ratio: Number(syntheticRatio.toFixed(3)),
    },
  };
}
