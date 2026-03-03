import type { CanonicalEvent } from "./event-envelope.js";

export type FollowupMode = "per_intent" | "session";
export type FollowupStrictness = "soft" | "advisory" | "hard";
export type FollowupFocus = "risk" | "verification_gap" | "hotspot" | "rework_pattern" | "efficiency";

export type RuleTemplateId =
  | "high_risk_guardrail"
  | "verification_loop_control"
  | "context_retrieval_limit"
  | "file_check_dedup"
  | "hotspot_change_gate";

export interface ValueClaims {
  risk_mitigation: string[];
  efficiency_improvement: string[];
  quality_standardization: string[];
}

export interface EvidenceRef {
  event_id: string;
  reason: string;
  file?: string;
}

export interface IntentRuleFeatures {
  intent_id: string;
  intent_title: string;
  risk_score: number;
  efficiency_waste_score: number;
  stability_score: number;
  high_risk_signals: number;
  verification_fail_count: number;
  verification_unknown_count: number;
  hotspot_score: number;
  repeated_call_count: number;
  repeated_file_check_count: number;
  file_ops_count: number;
  token_total: number;
}

export interface FollowupArtifact {
  intent_id: string;
  intent_title: string;
  confidence: number;
  rule_template_id: RuleTemplateId;
  features: IntentRuleFeatures;
  value_claims: ValueClaims;
  evidence_refs: EvidenceRef[];
  rule_spec: Record<string, unknown>;
  skill_draft: string;
  insufficient_evidence?: boolean;
}

export interface FollowupSummary {
  intent_count: number;
  high_risk_intents: number;
  high_efficiency_waste_intents: number;
  avg_confidence: number;
}

export interface FollowupGenerationResult {
  artifacts: FollowupArtifact[];
  summary: FollowupSummary;
  insufficient_evidence: boolean;
}

export interface TokenSplitAttribution {
  checkpoint_event_id: string;
  total_tokens: number;
  context_tokens: number;
  output_tokens: number;
  unknown_tokens: number;
  neighbor_event_ids: string[];
}

export interface IntentTokenBreakdown {
  intent_id: string;
  intent_title: string;
  total_tokens: number;
  context_tokens: number;
  output_tokens: number;
  unknown_tokens: number;
  estimated_cost_usd?: number;
  event_window: { start_seq: number; end_seq: number };
  supporting_events: TokenSplitAttribution[];
}

export interface TokenBreakdownResult {
  intent_breakdown: IntentTokenBreakdown[];
  totals: {
    total_tokens: number;
    context_tokens: number;
    output_tokens: number;
    unknown_tokens: number;
    estimated_cost_usd?: number;
  };
}

const MAX_REPEATED_CHECKS_SOFT = 3;
const MAX_REPEATED_CALLS_SOFT = 4;
const TOKEN_NEIGHBORHOOD_RADIUS_SEQ = 5;
const MIN_RULE_CONFIDENCE = 0.45;

interface IntentBucket {
  intent_id: string;
  intent_title: string;
  start_seq: number;
  end_seq: number;
  events: CanonicalEvent[];
}

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

function payload(event: CanonicalEvent): Record<string, unknown> {
  return event.payload ?? {};
}

function getIntentId(event: CanonicalEvent): string | undefined {
  const p = payload(event);
  const payloadIntent = toStringValue(p.intent_id);
  return event.scope?.intent_id ?? payloadIntent;
}

function getIntentTitle(event: CanonicalEvent): string | undefined {
  const p = payload(event);
  return toStringValue(p.title) ?? toStringValue(p.description);
}

function getFileTarget(event: CanonicalEvent): string | undefined {
  if (event.kind !== "file_op") return undefined;
  const p = payload(event);
  return toStringValue(p.target) ?? event.scope?.file;
}

function getTokenUsage(event: CanonicalEvent): {
  total_tokens: number;
  estimated_cost_usd?: number;
} | null {
  const p = payload(event);
  const direct = p.usage;
  const details = p.details;
  const nested =
    details && typeof details === "object" ? (details as Record<string, unknown>).llm_usage : undefined;
  const usage =
    direct && typeof direct === "object"
      ? (direct as Record<string, unknown>)
      : nested && typeof nested === "object"
      ? (nested as Record<string, unknown>)
      : null;
  if (!usage) return null;
  const prompt = toNumber(usage.prompt_tokens);
  const completion = toNumber(usage.completion_tokens);
  const totalRaw = toNumber(usage.total_tokens);
  const total = totalRaw > 0 ? totalRaw : prompt + completion;
  if (total <= 0) return null;
  const cost = toNumber(usage.estimated_cost_usd);
  return {
    total_tokens: total,
    estimated_cost_usd: cost > 0 ? cost : undefined,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function buildIntentBuckets(eventsRaw: CanonicalEvent[]): IntentBucket[] {
  const events = [...eventsRaw].sort((a, b) => (a.seq === b.seq ? a.ts.localeCompare(b.ts) : a.seq - b.seq));
  const boundaryEvents = events.filter((event) => event.kind === "intent");
  const boundaries = boundaryEvents.map((event) => ({
    intent_id: getIntentId(event) ?? `intent_${event.seq}`,
    intent_title: getIntentTitle(event) ?? `Intent ${event.seq}`,
    seq: event.seq,
  }));
  const boundaryById = new Map(boundaries.map((item) => [item.intent_id, item.intent_title]));
  const fallbackId = "intent_fallback";
  const byIntent = new Map<string, CanonicalEvent[]>();

  function inferIntent(event: CanonicalEvent): string {
    const explicit = getIntentId(event);
    if (explicit) return explicit;
    let latest: string | undefined;
    for (const boundary of boundaries) {
      if (boundary.seq <= event.seq) latest = boundary.intent_id;
      else break;
    }
    return latest ?? fallbackId;
  }

  for (const event of events) {
    if (event.kind === "session_start" || event.kind === "session_end") continue;
    const intentId = inferIntent(event);
    const list = byIntent.get(intentId) ?? [];
    list.push(event);
    byIntent.set(intentId, list);
  }

  const orderedIds = [...new Set([...boundaries.map((item) => item.intent_id), ...byIntent.keys()])];
  return orderedIds.map((intentId) => {
    const intentEvents = byIntent.get(intentId) ?? [];
    const startSeq = intentEvents[0]?.seq ?? 0;
    const endSeq = intentEvents[intentEvents.length - 1]?.seq ?? startSeq;
    return {
      intent_id: intentId,
      intent_title: boundaryById.get(intentId) ?? (intentId === fallbackId ? "Fallback intent" : intentId),
      start_seq: startSeq,
      end_seq: endSeq,
      events: intentEvents,
    };
  });
}

function isFileCheckEvent(event: CanonicalEvent): boolean {
  if (event.kind !== "tool_call") return false;
  const p = payload(event);
  const action = (toStringValue(p.action) ?? "").toLowerCase();
  const target = (toStringValue(p.target) ?? "").toLowerCase();
  if (!action && !target) return false;
  const looksCheck = /(read|cat|open|view|inspect|grep|rg|ls|stat)/.test(action);
  const looksFile = /\/|\\|\.ts$|\.tsx$|\.js$|\.json$|\.md$|\.yml$|\.yaml$/.test(target);
  return looksCheck || looksFile;
}

function isContextEvent(event: CanonicalEvent): boolean {
  if (event.kind === "tool_call") {
    const category = toStringValue(payload(event).category);
    return category === "search" || category === "tool" || category === "execution";
  }
  if (event.kind === "artifact_created") {
    const module = (event.scope?.module ?? "").toLowerCase();
    const artifactType = (toStringValue(payload(event).artifact_type) ?? "").toLowerCase();
    return module === "reasoning" || artifactType === "reasoning";
  }
  return false;
}

function isOutputEvent(event: CanonicalEvent): boolean {
  if (event.kind === "file_op" || event.kind === "diff_summary") return true;
  if (event.kind === "artifact_created") {
    const artifactType = (toStringValue(payload(event).artifact_type) ?? "").toLowerCase();
    return ["file", "patch", "report", "test", "build", "migration", "pr"].includes(artifactType);
  }
  return false;
}

function deriveIntentFeatures(
  bucket: IntentBucket,
  repeatedCallThreshold: number,
  repeatedCheckThreshold: number
): { features: IntentRuleFeatures; template: RuleTemplateId; evidence: EvidenceRef[]; thresholdHints: Record<string, number> } {
  const evidence: EvidenceRef[] = [];
  let highRiskSignals = 0;
  let verificationFailCount = 0;
  let verificationUnknownCount = 0;
  let hotspotScore = 0;
  let fileOpsCount = 0;
  let tokenTotal = 0;
  let tokenCost = 0;

  const callKeyCount = new Map<string, number>();
  const fileCheckCount = new Map<string, number>();
  const editedFiles = new Set<string>();
  let diffSummaryCount = 0;
  let outputArtifacts = 0;

  for (const event of bucket.events) {
    const p = payload(event);
    if (event.kind === "risk_signal") {
      const level = toStringValue(p.level) ?? "low";
      if (level === "high") highRiskSignals += 3;
      else if (level === "medium") highRiskSignals += 2;
      else highRiskSignals += 1;
      evidence.push({ event_id: event.id, reason: `risk_signal:${level}`, file: event.scope?.file });
    }
    if (event.kind === "assumption") {
      const risk = toStringValue(p.risk);
      if (risk === "high") highRiskSignals += 2;
      else if (risk === "medium") highRiskSignals += 1;
    }
    if (event.kind === "verification") {
      const result = toStringValue(p.result);
      if (result === "fail") {
        verificationFailCount += 1;
        evidence.push({ event_id: event.id, reason: "verification:fail", file: event.scope?.file });
      } else if (result === "unknown") {
        verificationUnknownCount += 1;
      }
    }
    if (event.kind === "hotspot") {
      const score = toNumber(p.score);
      hotspotScore += score;
      evidence.push({ event_id: event.id, reason: `hotspot:${score}`, file: toStringValue(p.file) ?? event.scope?.file });
    }
    if (event.kind === "tool_call") {
      const key = `${toStringValue(p.action) ?? "unknown"}::${toStringValue(p.target) ?? ""}`;
      callKeyCount.set(key, (callKeyCount.get(key) ?? 0) + 1);
      if (isFileCheckEvent(event)) {
        const target = toStringValue(p.target) ?? toStringValue(event.scope?.file) ?? "unknown";
        fileCheckCount.set(target, (fileCheckCount.get(target) ?? 0) + 1);
      }
    }
    if (event.kind === "file_op") {
      fileOpsCount += 1;
      const action = toStringValue(p.action);
      if (action === "create" || action === "edit" || action === "delete") {
        const target = getFileTarget(event);
        if (target) editedFiles.add(target);
      }
    }
    if (event.kind === "diff_summary") diffSummaryCount += 1;
    if (event.kind === "artifact_created" && isOutputEvent(event)) outputArtifacts += 1;
    const usage = getTokenUsage(event);
    if (usage) {
      tokenTotal += usage.total_tokens;
      tokenCost += usage.estimated_cost_usd ?? 0;
    }
  }

  const repeatedCallCount = [...callKeyCount.values()].reduce((sum, count) => {
    return sum + (count > repeatedCallThreshold ? count - repeatedCallThreshold : 0);
  }, 0);
  const repeatedFileCheckCount = [...fileCheckCount.entries()].reduce((sum, [target, count]) => {
    if (count <= repeatedCheckThreshold) return sum;
    if (editedFiles.has(target)) return sum;
    return sum + (count - repeatedCheckThreshold);
  }, 0);
  const deliverableDelta = fileOpsCount + diffSummaryCount + outputArtifacts;
  const lowDeliverableWithHighToken = tokenTotal > 0 && tokenTotal > 2000 && deliverableDelta <= 1 ? 1 : 0;
  const verificationLoop = verificationFailCount + verificationUnknownCount >= 3 ? 1 : 0;

  const riskScoreRaw = highRiskSignals * 12 + verificationFailCount * 16 + Math.min(20, hotspotScore);
  const efficiencyScoreRaw =
    repeatedCallCount * 10 + repeatedFileCheckCount * 12 + verificationLoop * 10 + lowDeliverableWithHighToken * 14;
  const stabilityRaw = 100 - (verificationFailCount * 12 + verificationUnknownCount * 5 + repeatedCallCount * 2);

  const riskScore = Math.max(0, Math.min(100, Math.round(riskScoreRaw)));
  const efficiencyWasteScore = Math.max(0, Math.min(100, Math.round(efficiencyScoreRaw)));
  const stabilityScore = Math.max(0, Math.min(100, Math.round(stabilityRaw)));

  let template: RuleTemplateId = "context_retrieval_limit";
  if (riskScore >= 65 || (highRiskSignals >= 3 && verificationFailCount > 0)) template = "high_risk_guardrail";
  else if (verificationLoop) template = "verification_loop_control";
  else if (repeatedFileCheckCount > 0) template = "file_check_dedup";
  else if (hotspotScore >= 8) template = "hotspot_change_gate";

  if (evidence.length === 0) {
    const fallbackEvent = bucket.events.find((event) => event.kind === "tool_call" || event.kind === "file_op");
    if (fallbackEvent) evidence.push({ event_id: fallbackEvent.id, reason: "behavioral_pattern", file: fallbackEvent.scope?.file });
  }

  return {
    features: {
      intent_id: bucket.intent_id,
      intent_title: bucket.intent_title,
      risk_score: riskScore,
      efficiency_waste_score: efficiencyWasteScore,
      stability_score: stabilityScore,
      high_risk_signals: highRiskSignals,
      verification_fail_count: verificationFailCount,
      verification_unknown_count: verificationUnknownCount,
      hotspot_score: Number(hotspotScore.toFixed(2)),
      repeated_call_count: repeatedCallCount,
      repeated_file_check_count: repeatedFileCheckCount,
      file_ops_count: fileOpsCount,
      token_total: tokenTotal,
    },
    template,
    evidence: evidence.slice(0, 12),
    thresholdHints: {
      repeated_call_threshold: repeatedCallThreshold,
      repeated_check_threshold: repeatedCheckThreshold,
      verification_loop_threshold: 3,
      low_delta_token_threshold: 2000,
      estimated_cost_usd: Number(tokenCost.toFixed(6)),
    },
  };
}

function valueClaimsForTemplate(template: RuleTemplateId, features: IntentRuleFeatures): ValueClaims {
  const risk_mitigation: string[] = [];
  const efficiency_improvement: string[] = [];
  const quality_standardization: string[] = [];

  if (template === "high_risk_guardrail" || features.verification_fail_count > 0 || features.high_risk_signals > 0) {
    risk_mitigation.push("Mitigates high-risk regressions by enforcing stronger verification gates.");
  }
  if (template === "file_check_dedup" || template === "context_retrieval_limit" || features.repeated_call_count > 0) {
    efficiency_improvement.push("Reduces unnecessary repeated calls/checks by applying bounded retrieval guardrails.");
  }
  quality_standardization.push("Standardizes intent execution with explicit evidence-based guardrails.");

  return { risk_mitigation, efficiency_improvement, quality_standardization };
}

function buildRuleSpec(
  template: RuleTemplateId,
  features: IntentRuleFeatures,
  strictness: FollowupStrictness,
  focus: FollowupFocus,
  thresholdHints: Record<string, number>,
  evidence: EvidenceRef[]
): Record<string, unknown> {
  const softGuardrailAction =
    strictness === "soft"
      ? "warn_and_recommend"
      : strictness === "advisory"
      ? "recommend_only"
      : "block_until_ack";

  return {
    version: 1,
    template_id: template,
    focus,
    strictness,
    intent_id: features.intent_id,
    intent_title: features.intent_title,
    scores: {
      risk_score: features.risk_score,
      efficiency_waste_score: features.efficiency_waste_score,
      stability_score: features.stability_score,
    },
    thresholds: thresholdHints,
    soft_guardrails: [
      {
        trigger: "repeated_file_check_without_edit",
        threshold: thresholdHints.repeated_check_threshold,
        action: softGuardrailAction,
        recommendation: "Consolidate file inspection and defer duplicate checks until meaningful edits occur.",
      },
      {
        trigger: "repeated_tool_call_same_target",
        threshold: thresholdHints.repeated_call_threshold,
        action: softGuardrailAction,
        recommendation: "Cache previously gathered context and avoid repeated identical retrieval calls.",
      },
    ],
    expected_outcomes: {
      risk_reduction: features.risk_score >= 50 || features.verification_fail_count > 0,
      efficiency_gain: features.efficiency_waste_score >= 35,
      reduced_unnecessary_checks: features.repeated_file_check_count > 0 || features.repeated_call_count > 0,
    },
    evidence_refs: evidence,
  };
}

function buildSkillDraft(
  features: IntentRuleFeatures,
  template: RuleTemplateId,
  claims: ValueClaims,
  thresholdHints: Record<string, number>,
  evidence: EvidenceRef[]
): string {
  return [
    `# Skill: ${features.intent_title} Guardrail`,
    "",
    "## Purpose",
    "Apply deterministic checks that reduce wasteful context gathering and mitigate risk in similar tasks.",
    "",
    "## Template",
    `- ${template}`,
    "",
    "## Value",
    ...(claims.risk_mitigation.length > 0 ? claims.risk_mitigation.map((item) => `- ${item}`) : []),
    ...(claims.efficiency_improvement.length > 0 ? claims.efficiency_improvement.map((item) => `- ${item}`) : []),
    ...(claims.quality_standardization.length > 0
      ? claims.quality_standardization.map((item) => `- ${item}`)
      : []),
    "",
    "## Thresholds",
    `- Repeated file checks threshold: ${thresholdHints.repeated_check_threshold}`,
    `- Repeated call threshold: ${thresholdHints.repeated_call_threshold}`,
    `- Verification loop threshold: ${thresholdHints.verification_loop_threshold}`,
    "",
    "## Workflow",
    "1. Gather context once and cache references.",
    "2. Avoid repeated retrieval calls for the same target unless state changed.",
    "3. Prioritize edits and run targeted checks only when needed.",
    "4. Escalate to full verification for high-risk or failing intents.",
    "",
    "## Evidence anchors",
    ...evidence.map((item) => `- ${item.event_id}${item.file ? ` (${item.file})` : ""}: ${item.reason}`),
    "",
  ].join("\n");
}

function computeConfidence(features: IntentRuleFeatures, evidenceCount: number): number {
  const strongSignals =
    (features.risk_score >= 55 ? 1 : 0) +
    (features.efficiency_waste_score >= 45 ? 1 : 0) +
    (features.verification_fail_count > 0 ? 1 : 0) +
    (features.repeated_call_count > 0 ? 1 : 0) +
    (features.repeated_file_check_count > 0 ? 1 : 0);
  const confidence = 0.28 + strongSignals * 0.12 + Math.min(0.24, evidenceCount * 0.03);
  return Math.max(0, Math.min(0.96, Number(confidence.toFixed(2))));
}

export function generateFollowupArtifacts(
  events: CanonicalEvent[],
  input: {
    mode?: FollowupMode;
    strictness?: FollowupStrictness;
    focus?: FollowupFocus;
  } = {}
): FollowupGenerationResult {
  const mode = input.mode ?? "per_intent";
  const strictness = input.strictness ?? "soft";
  const focus = input.focus ?? "risk";
  const buckets = buildIntentBuckets(events);

  const repeatedCallBaseline = percentile(
    buckets.map((bucket) =>
      bucket.events.filter((event) => event.kind === "tool_call").length
    ),
    0.75
  );
  const repeatedCheckBaseline = percentile(
    buckets.map((bucket) => bucket.events.filter((event) => isFileCheckEvent(event)).length),
    0.75
  );
  const repeatedCallThreshold = Math.max(MAX_REPEATED_CALLS_SOFT, Math.round(repeatedCallBaseline));
  const repeatedCheckThreshold = Math.max(MAX_REPEATED_CHECKS_SOFT, Math.round(repeatedCheckBaseline));

  const targetBuckets =
    mode === "session"
      ? [
          {
            intent_id: "session_total",
            intent_title: "Session aggregate",
            start_seq: buckets[0]?.start_seq ?? 0,
            end_seq: buckets[buckets.length - 1]?.end_seq ?? 0,
            events: buckets.flatMap((bucket) => bucket.events),
          },
        ]
      : buckets;

  const artifacts: FollowupArtifact[] = targetBuckets
    .map((bucket) => {
      const { features, template, evidence, thresholdHints } = deriveIntentFeatures(
        bucket,
        repeatedCallThreshold,
        repeatedCheckThreshold
      );
      const valueClaims = valueClaimsForTemplate(template, features);
      const confidence = computeConfidence(features, evidence.length);
      const insufficient = confidence < MIN_RULE_CONFIDENCE;

      return {
        intent_id: bucket.intent_id,
        intent_title: bucket.intent_title,
        confidence,
        rule_template_id: template,
        features,
        value_claims: valueClaims,
        evidence_refs: evidence,
        rule_spec: buildRuleSpec(template, features, strictness, focus, thresholdHints, evidence),
        skill_draft: buildSkillDraft(features, template, valueClaims, thresholdHints, evidence),
        insufficient_evidence: insufficient,
      };
    })
    .sort((a, b) => b.features.risk_score + b.features.efficiency_waste_score - (a.features.risk_score + a.features.efficiency_waste_score));

  const highRiskIntents = artifacts.filter((artifact) => artifact.features.risk_score >= 60).length;
  const highWasteIntents = artifacts.filter((artifact) => artifact.features.efficiency_waste_score >= 50).length;
  const avgConfidence =
    artifacts.length > 0
      ? Number((artifacts.reduce((sum, artifact) => sum + artifact.confidence, 0) / artifacts.length).toFixed(2))
      : 0;

  return {
    artifacts,
    summary: {
      intent_count: artifacts.length,
      high_risk_intents: highRiskIntents,
      high_efficiency_waste_intents: highWasteIntents,
      avg_confidence: avgConfidence,
    },
    insufficient_evidence: artifacts.length === 0 || artifacts.every((artifact) => artifact.insufficient_evidence),
  };
}

export function deriveIntentTokenBreakdown(events: CanonicalEvent[]): TokenBreakdownResult {
  const buckets = buildIntentBuckets(events);
  const intentBreakdown: IntentTokenBreakdown[] = [];
  let totalTokens = 0;
  let contextTokens = 0;
  let outputTokens = 0;
  let unknownTokens = 0;
  let cost = 0;

  for (const bucket of buckets) {
    const supporting: TokenSplitAttribution[] = [];
    let bucketTotal = 0;
    let bucketContext = 0;
    let bucketOutput = 0;
    let bucketUnknown = 0;
    let bucketCost = 0;

    const tokenEvents = bucket.events.filter((event) => event.kind === "token_usage_checkpoint");
    for (const checkpoint of tokenEvents) {
      const usage = getTokenUsage(checkpoint);
      if (!usage) continue;
      const neighbors = bucket.events.filter(
        (event) =>
          event.id !== checkpoint.id &&
          Math.abs(event.seq - checkpoint.seq) <= TOKEN_NEIGHBORHOOD_RADIUS_SEQ
      );
      const contextNeighbor = neighbors.filter((event) => isContextEvent(event));
      const outputNeighbor = neighbors.filter((event) => isOutputEvent(event));

      let contextPart = 0;
      let outputPart = 0;
      let unknownPart = 0;
      if (contextNeighbor.length === 0 && outputNeighbor.length === 0) {
        unknownPart = usage.total_tokens;
      } else if (contextNeighbor.length > 0 && outputNeighbor.length === 0) {
        contextPart = usage.total_tokens;
      } else if (outputNeighbor.length > 0 && contextNeighbor.length === 0) {
        outputPart = usage.total_tokens;
      } else {
        const totalWeight = contextNeighbor.length + outputNeighbor.length;
        contextPart = Math.round((usage.total_tokens * contextNeighbor.length) / totalWeight);
        outputPart = usage.total_tokens - contextPart;
      }

      supporting.push({
        checkpoint_event_id: checkpoint.id,
        total_tokens: usage.total_tokens,
        context_tokens: contextPart,
        output_tokens: outputPart,
        unknown_tokens: unknownPart,
        neighbor_event_ids: neighbors.slice(0, 8).map((event) => event.id),
      });

      bucketTotal += usage.total_tokens;
      bucketContext += contextPart;
      bucketOutput += outputPart;
      bucketUnknown += unknownPart;
      bucketCost += usage.estimated_cost_usd ?? 0;
    }

    intentBreakdown.push({
      intent_id: bucket.intent_id,
      intent_title: bucket.intent_title,
      total_tokens: bucketTotal,
      context_tokens: bucketContext,
      output_tokens: bucketOutput,
      unknown_tokens: bucketUnknown,
      estimated_cost_usd: bucketCost > 0 ? Number(bucketCost.toFixed(6)) : undefined,
      event_window: {
        start_seq: bucket.start_seq,
        end_seq: bucket.end_seq,
      },
      supporting_events: supporting,
    });

    totalTokens += bucketTotal;
    contextTokens += bucketContext;
    outputTokens += bucketOutput;
    unknownTokens += bucketUnknown;
    cost += bucketCost;
  }

  return {
    intent_breakdown: intentBreakdown.sort((a, b) => b.total_tokens - a.total_tokens),
    totals: {
      total_tokens: totalTokens,
      context_tokens: contextTokens,
      output_tokens: outputTokens,
      unknown_tokens: unknownTokens,
      estimated_cost_usd: cost > 0 ? Number(cost.toFixed(6)) : undefined,
    },
  };
}
