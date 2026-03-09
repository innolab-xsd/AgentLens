import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { Session } from "../types/session";
import { runAuditPostProcessing } from "../lib/auditPipeline";
import { FlowView } from "./FlowView";
import { ReviewerHighlights } from "./ReviewerHighlights";
import { ReviewerFocusPanel } from "./ReviewerFocusPanel";
import { ContextPathView } from "./ContextPathView";
import { OrchestrationView } from "./OrchestrationView";
import { DeliverablesList } from "./DeliverablesList";
import { DeliverableWorkOverview } from "./DeliverableWorkOverview";
import { deriveDeliverables, getIntentIdFromEvent, type DeliverableItem } from "../lib/deliverables";
import {
  getDecisionsForDeliverable,
  getVerificationsForDeliverable,
} from "../lib/deliverableContext";
import {
  deriveIntentTokenBreakdown,
  generateFollowupArtifacts,
  type FollowupGenerationResult,
  type TokenBreakdownResult,
} from "../lib/localDeterministic";

import "./ReplayView.css";

const BASE_INTERVAL_MS = 2000;

type DeliverableTab = "what_changed" | "why_changed" | "cost";

interface ReplayViewProps {
  session: Session;
  onBack: () => void;
}

type FollowupGenerateResponse = FollowupGenerationResult;
type TokenBreakdownResponse = TokenBreakdownResult;

function formatPercent(value: number): string {
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

export function ReplayView({ session, onBack }: ReplayViewProps) {
  const { normalized, reviewer } = useMemo(
    () => runAuditPostProcessing(session.events),
    [session.events],
  );

  const criticalEvents = useMemo(() => {
    const out: Array<{
      index: number;
      severity: "high" | "medium";
      reason: string;
    }> = [];
    for (let i = 0; i < session.events.length; i++) {
      const e = session.events[i];
      if (e.kind === "decision")
        out.push({ index: i, severity: "medium", reason: "Decision point" });
      if (e.kind === "session_end")
        out.push({ index: i, severity: "medium", reason: "Session outcome" });
      if (e.kind === "assumption" && e.payload.risk === "high") {
        out.push({
          index: i,
          severity: "high",
          reason: "High-risk assumption",
        });
      }
      if (e.kind === "verification") {
        const r = e.payload.result;
        if (r === "fail")
          out.push({
            index: i,
            severity: "high",
            reason: "Verification failed",
          });
        else if (r === "unknown")
          out.push({
            index: i,
            severity: "medium",
            reason: "Verification unknown",
          });
      }
      if (e.kind === "file_op") {
        const target =
          (typeof e.payload.target === "string" ? e.payload.target : "") ||
          (typeof e.scope?.file === "string" ? e.scope.file : "");
        const lower = target.toLowerCase();
        if (
          lower.includes("/api/") ||
          lower.includes("/routes/") ||
          lower.includes("/migrations/") ||
          lower.endsWith("package.json")
        ) {
          out.push({
            index: i,
            severity: "high",
            reason: `High-impact file: ${target}`,
          });
        }
      }
    }
    out.sort((a, b) => a.index - b.index);
    return out;
  }, [session.events]);

  const [currentIndex, setCurrentIndex] = useState(0);
  type MainView = "orchestration" | "deliverables" | "context" | "reviewer" | "pivot";
  const [mainView, setMainView] = useState<MainView>("orchestration");
  const [deliverableTab, setDeliverableTab] =
    useState<DeliverableTab>("why_changed");
  const [selectedDeliverableId, setSelectedDeliverableId] = useState<
    string | null
  >(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed] = useState<1 | 2>(1);
  const [followupResult, setFollowupResult] =
    useState<FollowupGenerateResponse | null>(null);
  const [followupStatus, setFollowupStatus] = useState<string>("");
  const [tokenBreakdown, setTokenBreakdown] =
    useState<TokenBreakdownResponse | null>(null);
  const [tokenStatus, setTokenStatus] = useState<string>("");
  const [selectedIntentCost, setSelectedIntentCost] = useState<string | null>(
    null,
  );
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isWorkflowView = mainView === "pivot";
  const playbackSpeed = speed;

  const eventCount = session.events.length;
  const atEnd = eventCount === 0 || currentIndex >= eventCount - 1;

  const stopPlayback = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsPlaying(false);
  }, []);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isPlaying) return;
    if (atEnd) {
      stopPlayback();
      return;
    }
    const ms = BASE_INTERVAL_MS / playbackSpeed;
    intervalRef.current = setInterval(() => {
      setCurrentIndex((i) => {
        if (i >= eventCount - 1) {
          stopPlayback();
          return i;
        }
        return i + 1;
      });
    }, ms);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPlaying, playbackSpeed, atEnd, eventCount, stopPlayback]);

  const handleSeek = useCallback(
    (index: number) => {
      setCurrentIndex(index);
      if (isPlaying) stopPlayback();
    },
    [isPlaying, stopPlayback],
  );

  const handlePlay = useCallback(() => setIsPlaying(true), []);
  const handlePause = useCallback(() => stopPlayback(), [stopPlayback]);

  const handleGenerateFollowup = useCallback(() => {
    setFollowupStatus("Generating rule + skill draft locally...");
    setFollowupResult(null);
    try {
      const data = generateFollowupArtifacts(session.events, {
        focus: "risk",
        mode: "per_intent",
        strictness: "soft",
      });
      setFollowupResult(data);
      setFollowupStatus("Follow-up artifacts generated locally.");
    } catch (error) {
      setFollowupStatus(
        error instanceof Error
          ? error.message
          : "Failed to generate follow-up artifacts.",
      );
    }
  }, [session.events]);

  const copyText = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // ignore clipboard failures in unsupported contexts
    }
  }, []);

  useEffect(() => {
    setTokenStatus("Computing intent token breakdown locally...");
    try {
      const data = deriveIntentTokenBreakdown(session.events);
      setTokenBreakdown(data);
      setSelectedIntentCost(data.intent_breakdown[0]?.intent_id ?? null);
      setTokenStatus("");
    } catch (error) {
      setTokenBreakdown(null);
      setTokenStatus(
        error instanceof Error ? error.message : "Token breakdown unavailable.",
      );
    }
  }, [session.events]);

  const deliverables = useMemo(
    () => deriveDeliverables(session, tokenBreakdown?.intent_breakdown ?? []),
    [session, tokenBreakdown],
  );

  useEffect(() => {
    if (deliverables.length === 0) {
      setSelectedDeliverableId(null);
      return;
    }
    const selectedStillExists = selectedDeliverableId
      ? deliverables.some((item) => item.id === selectedDeliverableId)
      : false;
    if (!selectedStillExists) {
      setSelectedDeliverableId(deliverables[0].id);
    }
  }, [deliverables, selectedDeliverableId]);

  const selectedDeliverable = useMemo(
    () =>
      deliverables.find((item) => item.id === selectedDeliverableId) ?? null,
    [deliverables, selectedDeliverableId],
  );

  const intentById = useMemo(() => {
    const map = new Map<
      string,
      TokenBreakdownResponse["intent_breakdown"][number]
    >();
    for (const item of tokenBreakdown?.intent_breakdown ?? []) {
      map.set(item.intent_id, item);
    }
    return map;
  }, [tokenBreakdown]);

  const handleSelectDeliverable = useCallback((id: string) => {
    setSelectedDeliverableId(id);
    setDeliverableTab("why_changed");
  }, []);

  const renderWhyChanged = useCallback(
    (deliverable: DeliverableItem) => {
      const decisions = getDecisionsForDeliverable(session, deliverable);
      const verifications = getVerificationsForDeliverable(session, deliverable);
      const contributions = deliverable.intent_contributions;
      const eventIndicesByIntent = new Map<string, number[]>();
      for (const index of deliverable.event_indices) {
        const event = session.events[index];
        if (!event) continue;
        const intentId =
          getIntentIdFromEvent(event) ?? "__unknown_intent__";
        const list = eventIndicesByIntent.get(intentId) ?? [];
        list.push(index);
        eventIndicesByIntent.set(intentId, list);
      }
      const primaryId =
        deliverable.primary_intent_id ?? contributions[0]?.intent_id;
      const hasIntents = contributions.length > 0;
      const hasDecisions = decisions.length > 0;
      const hasVerifications = verifications.length > 0;

      if (!hasIntents && !hasDecisions && !hasVerifications) {
        return (
          <p className="replay-placeholder-note">
            No intent, decision, or verification links were detected for this deliverable.
          </p>
        );
      }

      return (
        <div className="deliverable-why-changed">
          {hasDecisions ? (
            <section className="deliverable-why-changed__section">
              <h4 className="deliverable-why-changed__heading">Decisions affecting this file</h4>
              <ul className="deliverable-why-changed__list">
                {decisions.map((d) => (
                  <li key={d.eventIndex}>
                    <button
                      type="button"
                      className="deliverable-why-changed__event-btn"
                      onClick={() => handleSeek(d.eventIndex)}
                    >
                      #{d.eventIndex + 1}
                    </button>
                    <span>{d.summary}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {hasVerifications ? (
            <section className="deliverable-why-changed__section">
              <h4 className="deliverable-why-changed__heading">Verifications</h4>
              <ul className="deliverable-why-changed__list">
                {verifications.map((v) => (
                  <li key={v.eventIndex}>
                    <button
                      type="button"
                      className="deliverable-why-changed__event-btn"
                      onClick={() => handleSeek(v.eventIndex)}
                    >
                      #{v.eventIndex + 1}
                    </button>
                    <span className={`verification-result verification-result--${v.result}`}>
                      {v.type}: {v.result}
                    </span>
                    {v.details ? <span className="deliverable-why-changed__detail"> — {v.details}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {hasIntents ? (
            <section className="deliverable-why-changed__section">
              <h4 className="deliverable-why-changed__heading">Intent contributions</h4>
              <div className="deliverable-intents">
                {contributions.map((item) => {
                  const intent = intentById.get(item.intent_id);
                  const isPrimary = item.intent_id === primaryId;
                  const roleLabel = isPrimary ? "Primary intent" : "Contributing intent";
                  const relatedIndices =
                    eventIndicesByIntent.get(item.intent_id) ?? [];
                  return (
                    <article
                      className="deliverable-intent-card"
                      key={`${deliverable.id}-${item.intent_id}`}
                    >
                      <header>
                        <h4>{intent?.intent_title ?? item.intent_id}</h4>
                        <span
                          className={
                            isPrimary
                              ? "deliverable-intent-card__badge deliverable-intent-card__badge--primary"
                              : "deliverable-intent-card__badge"
                          }
                        >
                          {roleLabel}
                        </span>
                      </header>
                      <p>
                        Contribution: <strong>{formatPercent(item.percent)}</strong>
                      </p>
                      {intent ? (
                        <p>
                          Tokens {intent.total_tokens.toLocaleString()} · context{" "}
                          {intent.context_tokens.toLocaleString()} · output{" "}
                          {intent.output_tokens.toLocaleString()} · unknown{" "}
                          {intent.unknown_tokens.toLocaleString()}
                        </p>
                      ) : (
                        <p>No token telemetry linked for this intent.</p>
                      )}
                      {relatedIndices.length > 0 ? (
                        <div className="deliverable-intent-card__events">
                          <span className="deliverable-intent-card__events-label">
                            Related events:
                          </span>
                          {relatedIndices.map((evIndex) => (
                            <button
                              type="button"
                              key={evIndex}
                              className="deliverable-intent-card__event-btn"
                              onClick={() => handleSeek(evIndex)}
                            >
                              #{evIndex + 1}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>
      );
    },
    [intentById, session, handleSeek],
  );

  const renderCost = useCallback(
    (deliverable: DeliverableItem) => {
      const rows = deliverable.intent_contributions.map((item) => {
        const intent = intentById.get(item.intent_id);
        const ratio = Math.max(0, Math.min(1, item.percent / 100));
        const total = Math.round((intent?.total_tokens ?? 0) * ratio);
        const context = Math.round((intent?.context_tokens ?? 0) * ratio);
        const output = Math.round((intent?.output_tokens ?? 0) * ratio);
        const unknown = Math.round((intent?.unknown_tokens ?? 0) * ratio);
        return {
          intentId: item.intent_id,
          intentTitle: intent?.intent_title ?? item.intent_id,
          contributionPct: item.percent,
          total,
          context,
          output,
          unknown,
          cost:
            intent?.estimated_cost_usd != null
              ? Number((intent.estimated_cost_usd * ratio).toFixed(6))
              : null,
        };
      });
      return (
        <div className="reviewer-focus__card reviewer-focus__card--wide">
          <table className="reviewer-focus__table">
            <thead>
              <tr>
                <th>Intent</th>
                <th>Contribution</th>
                <th>Total</th>
                <th>Context</th>
                <th>Output</th>
                <th>Unknown</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const total = Math.max(1, row.total);
                const contextPct = Math.round((row.context / total) * 100);
                const outputPct = Math.round((row.output / total) * 100);
                const unknownPct = Math.max(0, 100 - contextPct - outputPct);
                return (
                  <tr key={`${deliverable.id}-${row.intentId}`}>
                    <td>{row.intentTitle}</td>
                    <td>{formatPercent(row.contributionPct)}</td>
                    <td>{row.total.toLocaleString()}</td>
                    <td>
                      {row.context.toLocaleString()}
                      <div className="token-bar">
                        <span
                          className="token-bar__context"
                          style={{ width: `${contextPct}%` }}
                        />
                        <span
                          className="token-bar__output"
                          style={{ width: `${outputPct}%` }}
                        />
                        <span
                          className="token-bar__unknown"
                          style={{ width: `${unknownPct}%` }}
                        />
                      </div>
                    </td>
                    <td>{row.output.toLocaleString()}</td>
                    <td>{row.unknown.toLocaleString()}</td>
                    <td>{row.cost != null ? `$${row.cost}` : "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    },
    [intentById],
  );

  return (
    <div
      className={`replay-view ${isWorkflowView ? "replay-view--workflow" : ""}`}
    >
      <header className="replay-header">
        <button
          type="button"
          className="back-btn"
          onClick={onBack}
          aria-label="Load another session"
        >
          ← Back
        </button>
        <h1
          className={`replay-title ${isWorkflowView ? "replay-title--workflow" : ""}`}
        >
          {isWorkflowView ? (
            <>
              <span className="workflow-logo" aria-hidden>
                ◇
              </span>
              Workflow Visualizer
            </>
          ) : (
            session.title
          )}
        </h1>
        <p className="replay-meta">
          {session.id} · {eventCount} events
        </p>
      </header>
      <div className="replay-body">
        <nav
          className="replay-nav-strip"
          aria-label="View switcher"
        >
          <button
            type="button"
            className={`replay-nav-strip__btn ${mainView === "orchestration" ? "active" : ""}`}
            onClick={() => setMainView("orchestration")}
            title="Orchestration"
            aria-label="Orchestration"
          >
            <span aria-hidden>⎇</span>
          </button>
          <button
            type="button"
            className={`replay-nav-strip__btn ${mainView === "reviewer" ? "active" : ""}`}
            onClick={() => setMainView("reviewer")}
            title="Dashboard"
            aria-label="Dashboard"
          >
            <span aria-hidden>▤</span>
          </button>
          <button
            type="button"
            className={`replay-nav-strip__btn ${mainView === "deliverables" ? "active" : ""}`}
            onClick={() => setMainView("deliverables")}
            title="Deliverables"
            aria-label="Deliverables"
          >
            <span aria-hidden>☑</span>
          </button>
          <button
            type="button"
            className={`replay-nav-strip__btn ${mainView === "context" ? "active" : ""}`}
            onClick={() => setMainView("context")}
            title="Context"
            aria-label="Context"
          >
            <span aria-hidden>⊞</span>
          </button>
          <button
            type="button"
            className={`replay-nav-strip__btn replay-nav-strip__btn--pivot ${mainView === "pivot" ? "active" : ""}`}
            onClick={() => setMainView("pivot")}
            title="Pivot: immersive mission flow"
            aria-label="Pivot"
          >
            <span aria-hidden>◇</span>
          </button>
        </nav>
        <div className="replay-layout">
        {mainView === "deliverables" && (
          <aside className="replay-sidebar">
            <DeliverablesList
              items={deliverables}
              selectedId={selectedDeliverableId}
              onSelect={handleSelectDeliverable}
            />
          </aside>
        )}
        <main className="replay-main">
          {mainView === "pivot" && (
            <FlowView
              session={session}
              currentIndex={currentIndex}
              onSeek={handleSeek}
              isPlaying={isPlaying}
              onPlay={handlePlay}
              onPause={handlePause}
              allowPerspective={true}
            />
          )}
          {mainView !== "pivot" && (
            <>
              {mainView === "reviewer" ? (
                <>
                  <ReviewerHighlights
                    normalized={normalized}
                    reviewer={reviewer}
                  />
                  <ReviewerFocusPanel
                    session={session}
                    normalized={normalized}
                    reviewer={reviewer}
                    currentIndex={currentIndex}
                    onSeek={handleSeek}
                    criticalEvents={criticalEvents}
                  />
                  <section className="reviewer-focus">
                    <header className="reviewer-focus__alert">
                      <h2>Intent Cost</h2>
                      <p>
                        Token consumption per intent, split into
                        context-building vs output-producing usage.
                      </p>
                    </header>
                    {tokenStatus ? <p>{tokenStatus}</p> : null}
                    {tokenBreakdown ? (
                      <>
                        <div className="reviewer-focus__card reviewer-focus__card--wide">
                          <p>
                            Total{" "}
                            {tokenBreakdown.totals.total_tokens.toLocaleString()}{" "}
                            tokens · context{" "}
                            {tokenBreakdown.totals.context_tokens.toLocaleString()}{" "}
                            · output{" "}
                            {tokenBreakdown.totals.output_tokens.toLocaleString()}{" "}
                            · unknown{" "}
                            {tokenBreakdown.totals.unknown_tokens.toLocaleString()}
                          </p>
                        </div>
                        <div className="reviewer-focus__card reviewer-focus__card--wide">
                          <table className="reviewer-focus__table">
                            <thead>
                              <tr>
                                <th>Intent</th>
                                <th>Total</th>
                                <th>Context</th>
                                <th>Output</th>
                                <th>Unknown</th>
                                <th>Cost</th>
                              </tr>
                            </thead>
                            <tbody>
                              {tokenBreakdown.intent_breakdown.map((row) => {
                                const total = Math.max(1, row.total_tokens);
                                const contextPct = Math.round(
                                  (row.context_tokens / total) * 100,
                                );
                                const outputPct = Math.round(
                                  (row.output_tokens / total) * 100,
                                );
                                const unknownPct = Math.max(
                                  0,
                                  100 - contextPct - outputPct,
                                );
                                return (
                                  <tr
                                    key={row.intent_id}
                                    className={
                                      selectedIntentCost === row.intent_id
                                        ? "is-selected"
                                        : ""
                                    }
                                    onClick={() =>
                                      setSelectedIntentCost(row.intent_id)
                                    }
                                  >
                                    <td>{row.intent_title}</td>
                                    <td>{row.total_tokens.toLocaleString()}</td>
                                    <td>
                                      {row.context_tokens.toLocaleString()}
                                      <div className="token-bar">
                                        <span
                                          className="token-bar__context"
                                          style={{ width: `${contextPct}%` }}
                                        />
                                        <span
                                          className="token-bar__output"
                                          style={{ width: `${outputPct}%` }}
                                        />
                                        <span
                                          className="token-bar__unknown"
                                          style={{ width: `${unknownPct}%` }}
                                        />
                                      </div>
                                    </td>
                                    <td>
                                      {row.output_tokens.toLocaleString()}
                                    </td>
                                    <td>
                                      {row.unknown_tokens.toLocaleString()}
                                    </td>
                                    <td>
                                      {row.estimated_cost_usd != null
                                        ? `$${row.estimated_cost_usd}`
                                        : "-"}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </>
                    ) : null}
                  </section>
                  <section className="reviewer-focus">
                    <header className="reviewer-focus__alert">
                      <h2>User-Triggered Workflow Standardization</h2>
                      <p>
                        Generate a rule + skill draft only when you want to
                        standardize similar future tasks.
                      </p>
                    </header>
                    <button
                      type="button"
                      className="browse-btn"
                      onClick={() => void handleGenerateFollowup()}
                    >
                      Generate Follow-up Rule/Skill
                    </button>
                    {followupStatus ? <p>{followupStatus}</p> : null}
                    {followupResult ? (
                      <>
                        <p>
                          Intents: {followupResult.summary.intent_count} ·
                          high-risk intents:{" "}
                          {followupResult.summary.high_risk_intents} · high
                          waste intents:{" "}
                          {followupResult.summary.high_efficiency_waste_intents}
                        </p>
                        <div className="reviewer-focus__grid reviewer-focus__grid--2">
                          {followupResult.artifacts.map((artifact) => (
                            <article
                              className="reviewer-focus__card"
                              key={artifact.intent_id}
                            >
                              <h3>{artifact.intent_title}</h3>
                              <p>
                                template{" "}
                                <code>{artifact.rule_template_id}</code> ·
                                confidence {artifact.confidence}
                              </p>
                              <p>
                                risk {artifact.features.risk_score} · waste{" "}
                                {artifact.features.efficiency_waste_score} ·
                                stability {artifact.features.stability_score}
                              </p>
                              <ul>
                                {artifact.value_claims.risk_mitigation.map(
                                  (item, index) => (
                                    <li
                                      key={`risk-${artifact.intent_id}-${index}`}
                                    >
                                      {item}
                                    </li>
                                  ),
                                )}
                                {artifact.value_claims.efficiency_improvement.map(
                                  (item, index) => (
                                    <li
                                      key={`eff-${artifact.intent_id}-${index}`}
                                    >
                                      {item}
                                    </li>
                                  ),
                                )}
                                {artifact.value_claims.quality_standardization.map(
                                  (item, index) => (
                                    <li
                                      key={`qual-${artifact.intent_id}-${index}`}
                                    >
                                      {item}
                                    </li>
                                  ),
                                )}
                              </ul>
                              <details>
                                <summary>
                                  Evidence refs ({artifact.evidence_refs.length}
                                  )
                                </summary>
                                <ul>
                                  {artifact.evidence_refs
                                    .slice(0, 10)
                                    .map((item) => (
                                      <li
                                        key={`${artifact.intent_id}-${item.event_id}`}
                                      >
                                        {item.event_id} · {item.reason}
                                      </li>
                                    ))}
                                </ul>
                              </details>
                              <div className="reviewer-focus__actions">
                                <button
                                  type="button"
                                  onClick={() =>
                                    void copyText(
                                      JSON.stringify(
                                        artifact.rule_spec,
                                        null,
                                        2,
                                      ),
                                    )
                                  }
                                >
                                  Copy Rule JSON
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void copyText(artifact.skill_draft)
                                  }
                                >
                                  Copy SKILL.md
                                </button>
                              </div>
                            </article>
                          ))}
                        </div>
                      </>
                    ) : null}
                  </section>
                </>
              ) : mainView === "orchestration" ? (
                <OrchestrationView
                  session={session}
                  onSeek={handleSeek}
                />
              ) : mainView === "context" ? (
                <ContextPathView
                  session={session}
                  currentIndex={currentIndex}
                  onSeek={handleSeek}
                />
              ) : selectedDeliverable ? (
                <>
                  <section className="deliverable-summary">
                    <header className="deliverable-summary__header">
                      <h2>{selectedDeliverable.title}</h2>
                      <p>{selectedDeliverable.path}</p>
                    </header>
                    <div className="deliverable-summary__meta">
                      <span>Status: {selectedDeliverable.status}</span>
                      <span className={`risk risk-${selectedDeliverable.risk}`}>
                        Risk: {selectedDeliverable.risk}
                      </span>
                      <span>
                        Est. tokens:{" "}
                        {selectedDeliverable.token_total.toLocaleString()}
                      </span>
                      <span>
                        Est. cost:{" "}
                        {selectedDeliverable.estimated_cost_usd != null
                          ? `$${selectedDeliverable.estimated_cost_usd}`
                          : "-"}
                      </span>
                    </div>
                  </section>

                  <div className="deliverable-tabs">
                    <button
                      type="button"
                      className={
                        deliverableTab === "why_changed" ? "active" : ""
                      }
                      onClick={() => setDeliverableTab("why_changed")}
                    >
                      Why changed
                    </button>
                    <button
                      type="button"
                      className={
                        deliverableTab === "what_changed" ? "active" : ""
                      }
                      onClick={() => setDeliverableTab("what_changed")}
                    >
                      What changed
                    </button>
                    <button
                      type="button"
                      className={deliverableTab === "cost" ? "active" : ""}
                      onClick={() => setDeliverableTab("cost")}
                    >
                      Cost
                    </button>
                  </div>

                  {deliverableTab === "what_changed" ? (
                    <section className="deliverable-pane">
                      <DeliverableWorkOverview
                        session={session}
                        deliverable={selectedDeliverable}
                        onSeek={handleSeek}
                      />
                    </section>
                  ) : null}

                  {deliverableTab === "why_changed" ? (
                    <section className="deliverable-pane">
                      {renderWhyChanged(selectedDeliverable)}
                    </section>
                  ) : null}

                  {deliverableTab === "cost" ? (
                    <section className="deliverable-pane">
                      <h3 className="deliverable-pane__title">Cost breakdown by intent</h3>
                      <p className="deliverable-pane__hint">
                        Token and cost share attributed to each intent that contributed to this deliverable.
                      </p>
                      {renderCost(selectedDeliverable)}
                    </section>
                  ) : null}
                </>
              ) : (
                <div className="replay-placeholder">
                  <p>
                    Select a deliverable to inspect why it changed, what work was
                    done, and associated intent cost.
                  </p>
                </div>
              )}
            </>
          )}
        </main>
        </div>
      </div>
    </div>
  );
}
