import type { Session, SessionEvent } from "../types/session";
import type { IntentTokenBreakdown } from "./localDeterministic";

export interface DeliverableIntentContribution {
  intent_id: string;
  score: number;
  percent: number;
}

export interface DeliverableItem {
  id: string;
  path: string;
  title: string;
  status: "created" | "edited" | "deleted" | "mixed";
  risk: "low" | "medium" | "high";
  token_total: number;
  estimated_cost_usd?: number;
  last_updated?: string;
  primary_intent_id?: string;
  related_intent_ids: string[];
  intent_contributions: DeliverableIntentContribution[];
  event_indices: number[];
}

function toStringValue(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

export function getIntentIdFromEvent(event: SessionEvent): string | undefined {
  return event.scope?.intent_id ?? toStringValue(event.payload.intent_id);
}

function getIntentId(event: SessionEvent): string | undefined {
  return getIntentIdFromEvent(event);
}

function getPath(event: SessionEvent): string | undefined {
  if (event.kind !== "file_op") return undefined;
  return toStringValue(event.payload.target) ?? event.scope?.file;
}

function getAction(event: SessionEvent): string | undefined {
  if (event.kind !== "file_op") return undefined;
  return toStringValue(event.payload.action);
}

function pathBaseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function severityRank(risk: DeliverableItem["risk"]): number {
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  return 1;
}

export function deriveDeliverables(session: Session, tokenBreakdown: IntentTokenBreakdown[]): DeliverableItem[] {
  const tokenByIntent = new Map(tokenBreakdown.map((item) => [item.intent_id, item]));
  const byPath = new Map<
    string,
    {
      actions: string[];
      event_indices: number[];
      last_updated?: string;
      risk_level: DeliverableItem["risk"];
      intentContribution: Map<string, number>;
    }
  >();

  for (let i = 0; i < session.events.length; i++) {
    const event = session.events[i];
    if (event.kind !== "file_op") continue;
    const path = getPath(event);
    if (!path) continue;
    const action = getAction(event) ?? "edit";
    const intentId = getIntentId(event) ?? "intent_fallback";
    const bucket =
      byPath.get(path) ??
      {
        actions: [],
        event_indices: [],
        last_updated: undefined,
        risk_level: "low" as DeliverableItem["risk"],
        intentContribution: new Map<string, number>(),
      };
    bucket.actions.push(action);
    bucket.event_indices.push(i);
    bucket.last_updated = event.ts;
    bucket.intentContribution.set(intentId, (bucket.intentContribution.get(intentId) ?? 0) + 3);
    byPath.set(path, bucket);
  }

  for (const event of session.events) {
    if (event.kind !== "risk_signal" && event.kind !== "verification" && event.kind !== "hotspot") continue;
    const intentId = getIntentId(event);
    if (!intentId) continue;
    for (const [path, bucket] of byPath.entries()) {
      if (!bucket.intentContribution.has(intentId)) continue;
      if (event.kind === "risk_signal") {
        const level = toStringValue(event.payload.level);
        if (level === "high") bucket.risk_level = "high";
        else if (level === "medium" && bucket.risk_level !== "high") bucket.risk_level = "medium";
      } else if (event.kind === "verification") {
        const result = toStringValue(event.payload.result);
        if (result === "fail") bucket.risk_level = "high";
        else if (result === "unknown" && bucket.risk_level === "low") bucket.risk_level = "medium";
      } else if (event.kind === "hotspot") {
        const score = Number(event.payload.score ?? 0);
        if (score >= 8) bucket.risk_level = "high";
        else if (score >= 4 && bucket.risk_level === "low") bucket.risk_level = "medium";
      }
      byPath.set(path, bucket);
    }
  }

  const out: DeliverableItem[] = [];
  for (const [path, bucket] of byPath.entries()) {
    const actions = [...new Set(bucket.actions)];
    let status: DeliverableItem["status"] = "edited";
    if (actions.length > 1) status = "mixed";
    else if (actions[0] === "create") status = "created";
    else if (actions[0] === "delete") status = "deleted";

    const contributions = [...bucket.intentContribution.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([intentId, score]) => ({ intent_id: intentId, score }));
    const totalContribution = contributions.reduce((sum, item) => sum + item.score, 0);
    const contributionsWithPct: DeliverableIntentContribution[] = contributions.map((item) => ({
      ...item,
      percent: totalContribution > 0 ? Math.round((item.score / totalContribution) * 100) : 0,
    }));
    const primary = contributionsWithPct[0]?.intent_id;
    const related = contributionsWithPct.slice(1).map((item) => item.intent_id);
    const tokenTotal = contributionsWithPct.reduce((sum, item) => {
      const t = tokenByIntent.get(item.intent_id)?.total_tokens ?? 0;
      return sum + Math.round((t * item.percent) / 100);
    }, 0);
    const estimatedCost = contributionsWithPct.reduce((sum, item) => {
      const c = tokenByIntent.get(item.intent_id)?.estimated_cost_usd ?? 0;
      return sum + (c * item.percent) / 100;
    }, 0);

    out.push({
      id: `deliverable:${path}`,
      path,
      title: pathBaseName(path),
      status,
      risk: bucket.risk_level,
      token_total: tokenTotal,
      estimated_cost_usd: estimatedCost > 0 ? Number(estimatedCost.toFixed(6)) : undefined,
      last_updated: bucket.last_updated,
      primary_intent_id: primary,
      related_intent_ids: related,
      intent_contributions: contributionsWithPct,
      event_indices: bucket.event_indices,
    });
  }

  out.sort((a, b) => {
    const riskDiff = severityRank(b.risk) - severityRank(a.risk);
    if (riskDiff !== 0) return riskDiff;
    return (b.last_updated ?? "").localeCompare(a.last_updated ?? "");
  });
  return out;
}
