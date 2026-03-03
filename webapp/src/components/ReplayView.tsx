import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { Session } from "../types/session";
import { getRevisionIndexForEvent } from "../lib/fileEvolution";
import { runAuditPostProcessing } from "../lib/auditPipeline";
import { TimelineStrip } from "./TimelineStrip";
import { PlaybackControls } from "./PlaybackControls";
import { FlowView } from "./FlowView";
import { ReviewerHighlights } from "./ReviewerHighlights";
import { ReviewerFocusPanel } from "./ReviewerFocusPanel";
import { ContextPathView } from "./ContextPathView";
import { DeliverablesList } from "./DeliverablesList";
import { FileEvolutionView } from "./FileEvolutionView";
import { deriveDeliverables, type DeliverableItem } from "../lib/deliverables";
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
    [session.events]
  );

  const criticalEvents = useMemo(() => {
    const out: Array<{ index: number; severity: "high" | "medium"; reason: string }> = [];
    for (let i = 0; i < session.events.length; i++) {
      const e = session.events[i];
      if (e.kind === "decision") out.push({ index: i, severity: "medium", reason: "Decision point" });
      if (e.kind === "session_end") out.push({ index: i, severity: "medium", reason: "Session outcome" });
      if (e.kind === "assumption" && e.payload.risk === "high") {
        out.push({ index: i, severity: "high", reason: "High-risk assumption" });
      }
      if (e.kind === "verification") {
        const r = e.payload.result;
        if (r === "fail") out.push({ index: i, severity: "high", reason: "Verification failed" });
        else if (r === "unknown") out.push({ index: i, severity: "medium", reason: "Verification unknown" });
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
          out.push({ index: i, severity: "high", reason: `High-impact file: ${target}` });
        }
      }
    }
    out.sort((a, b) => a.index - b.index);
    return out;
  }, [session.events]);

  const criticalIndices = useMemo(
    () => [...new Set(criticalEvents.map((e) => e.index))],
    [criticalEvents]
  );

  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedRevisionIndex, setSelectedRevisionIndex] = useState(0);
  const [viewMode, setViewMode] = useState<"timeline" | "pivot">("timeline");
  const [timelineTab, setTimelineTab] = useState<"deliverables" | "context" | "reviewer">("deliverables");
  const [deliverableTab, setDeliverableTab] = useState<DeliverableTab>("what_changed");
  const [selectedDeliverableId, setSelectedDeliverableId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2>(1);
  const [followupResult, setFollowupResult] = useState<FollowupGenerateResponse | null>(null);
  const [followupStatus, setFollowupStatus] = useState<string>("");
  const [tokenBreakdown, setTokenBreakdown] = useState<TokenBreakdownResponse | null>(null);
  const [tokenStatus, setTokenStatus] = useState<string>("");
  const [selectedIntentCost, setSelectedIntentCost] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isWorkflowView = viewMode === "pivot";
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
    [isPlaying, stopPlayback]
  );

  const handleOpenFileEvolution = useCallback(
    (path: string, eventIndex: number) => {
      setSelectedFilePath(path);
      setSelectedRevisionIndex(getRevisionIndexForEvent(session, path, eventIndex));
      setCurrentIndex(eventIndex);
    },
    [session]
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
      setFollowupStatus(error instanceof Error ? error.message : "Failed to generate follow-up artifacts.");
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
      setTokenStatus(error instanceof Error ? error.message : "Token breakdown unavailable.");
    }
  }, [session.events]);

  const deliverables = useMemo(
    () => deriveDeliverables(session, tokenBreakdown?.intent_breakdown ?? []),
    [session, tokenBreakdown]
  );

  useEffect(() => {
    if (deliverables.length === 0) {
      setSelectedDeliverableId(null);
      setSelectedFilePath(null);
      return;
    }
    const selectedStillExists = selectedDeliverableId
      ? deliverables.some((item) => item.id === selectedDeliverableId)
      : false;
    const nextSelectedId = selectedStillExists ? selectedDeliverableId : deliverables[0].id;
    setSelectedDeliverableId(nextSelectedId);
    const deliverable = deliverables.find((item) => item.id === nextSelectedId);
    if (deliverable) {
      setSelectedFilePath(deliverable.path);
      setSelectedRevisionIndex(0);
    }
  }, [deliverables, selectedDeliverableId]);

  const selectedDeliverable = useMemo(
    () => deliverables.find((item) => item.id === selectedDeliverableId) ?? null,
    [deliverables, selectedDeliverableId]
  );

  const intentById = useMemo(() => {
    const map = new Map<string, TokenBreakdownResponse["intent_breakdown"][number]>();
    for (const item of tokenBreakdown?.intent_breakdown ?? []) {
      map.set(item.intent_id, item);
    }
    return map;
  }, [tokenBreakdown]);

  const handleSelectDeliverable = useCallback((id: string) => {
    setSelectedDeliverableId(id);
    setDeliverableTab("what_changed");
  }, []);

  const renderWhyChanged = useCallback(
    (deliverable: DeliverableItem) => {
      const contributions = deliverable.intent_contributions;
      if (contributions.length === 0) {
        return <p className="replay-placeholder-note">No intent links were detected for this deliverable.</p>;
      }
      return (
        <div className="deliverable-intents">
          {contributions.map((item, index) => {
            const intent = intentById.get(item.intent_id);
            const roleLabel = index === 0 ? "Primary intent" : "Related intent";
            return (
              <article className="deliverable-intent-card" key={`${deliverable.id}-${item.intent_id}`}>
                <header>
                  <h4>{intent?.intent_title ?? item.intent_id}</h4>
                  <span>{roleLabel}</span>
                </header>
                <p>
                  Contribution: <strong>{formatPercent(item.percent)}</strong>
                </p>
                {intent ? (
                  <p>
                    Tokens {intent.total_tokens.toLocaleString()} · context {intent.context_tokens.toLocaleString()} ·
                    output {intent.output_tokens.toLocaleString()} · unknown {intent.unknown_tokens.toLocaleString()}
                  </p>
                ) : (
                  <p>No token telemetry linked for this intent.</p>
                )}
              </article>
            );
          })}
        </div>
      );
    },
    [intentById]
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
          cost: intent?.estimated_cost_usd != null ? Number((intent.estimated_cost_usd * ratio).toFixed(6)) : null,
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
                        <span className="token-bar__context" style={{ width: `${contextPct}%` }} />
                        <span className="token-bar__output" style={{ width: `${outputPct}%` }} />
                        <span className="token-bar__unknown" style={{ width: `${unknownPct}%` }} />
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
    [intentById]
  );

  return (
    <div className={`replay-view ${isWorkflowView ? "replay-view--workflow" : ""}`}>
      <header className="replay-header">
        <button
          type="button"
          className="back-btn"
          onClick={onBack}
          aria-label="Load another session"
        >
          ← Back
        </button>
        <h1 className={`replay-title ${isWorkflowView ? "replay-title--workflow" : ""}`}>
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
        <div className="replay-view-toggle replay-view-toggle--all">
          <button
            type="button"
            className={viewMode === "timeline" ? "active" : ""}
            onClick={() => setViewMode("timeline")}
          >
            Session
          </button>
          <button
            type="button"
            className={`replay-view-toggle__pivot ${viewMode === "pivot" ? "active" : ""}`}
            onClick={() => setViewMode("pivot")}
            title="Pivot: immersive mission flow"
          >
            Pivot ★
          </button>
        </div>
      </header>
      <div className="replay-layout">
        {viewMode === "timeline" && timelineTab === "deliverables" && (
          <aside className="replay-sidebar">
            <DeliverablesList
              items={deliverables}
              selectedId={selectedDeliverableId}
              onSelect={handleSelectDeliverable}
            />
          </aside>
        )}
        <main className="replay-main">
          {viewMode === "timeline" && (
            <div className="replay-subtabs">
              <button
                type="button"
                className={timelineTab === "deliverables" ? "active" : ""}
                onClick={() => setTimelineTab("deliverables")}
              >
                Deliverables
              </button>
              <button
                type="button"
                className={timelineTab === "context" ? "active" : ""}
                onClick={() => setTimelineTab("context")}
              >
                Context
              </button>
              <button
                type="button"
                className={timelineTab === "reviewer" ? "active" : ""}
                onClick={() => setTimelineTab("reviewer")}
              >
                Reviewer
              </button>
            </div>
          )}
          {viewMode === "pivot" && (
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
          {viewMode === "timeline" && (
            <>
              {timelineTab === "reviewer" ? (
                <>
                  <ReviewerHighlights normalized={normalized} reviewer={reviewer} />
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
                      <p>Token consumption per intent, split into context-building vs output-producing usage.</p>
                    </header>
                    {tokenStatus ? <p>{tokenStatus}</p> : null}
                    {tokenBreakdown ? (
                      <>
                        <div className="reviewer-focus__card reviewer-focus__card--wide">
                          <p>
                            Total {tokenBreakdown.totals.total_tokens.toLocaleString()} tokens · context{" "}
                            {tokenBreakdown.totals.context_tokens.toLocaleString()} · output{" "}
                            {tokenBreakdown.totals.output_tokens.toLocaleString()} · unknown{" "}
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
                                const contextPct = Math.round((row.context_tokens / total) * 100);
                                const outputPct = Math.round((row.output_tokens / total) * 100);
                                const unknownPct = Math.max(0, 100 - contextPct - outputPct);
                                return (
                                  <tr
                                    key={row.intent_id}
                                    className={selectedIntentCost === row.intent_id ? "is-selected" : ""}
                                    onClick={() => setSelectedIntentCost(row.intent_id)}
                                  >
                                    <td>{row.intent_title}</td>
                                    <td>{row.total_tokens.toLocaleString()}</td>
                                    <td>
                                      {row.context_tokens.toLocaleString()}
                                      <div className="token-bar">
                                        <span className="token-bar__context" style={{ width: `${contextPct}%` }} />
                                        <span className="token-bar__output" style={{ width: `${outputPct}%` }} />
                                        <span className="token-bar__unknown" style={{ width: `${unknownPct}%` }} />
                                      </div>
                                    </td>
                                    <td>{row.output_tokens.toLocaleString()}</td>
                                    <td>{row.unknown_tokens.toLocaleString()}</td>
                                    <td>{row.estimated_cost_usd != null ? `$${row.estimated_cost_usd}` : "-"}</td>
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
                      <p>Generate a rule + skill draft only when you want to standardize similar future tasks.</p>
                    </header>
                    <button type="button" className="browse-btn" onClick={() => void handleGenerateFollowup()}>
                      Generate Follow-up Rule/Skill
                    </button>
                    {followupStatus ? <p>{followupStatus}</p> : null}
                    {followupResult ? (
                      <>
                        <p>
                          Intents: {followupResult.summary.intent_count} · high-risk intents:{" "}
                          {followupResult.summary.high_risk_intents} · high waste intents:{" "}
                          {followupResult.summary.high_efficiency_waste_intents}
                        </p>
                        <div className="reviewer-focus__grid reviewer-focus__grid--2">
                          {followupResult.artifacts.map((artifact) => (
                            <article className="reviewer-focus__card" key={artifact.intent_id}>
                              <h3>{artifact.intent_title}</h3>
                              <p>
                                template <code>{artifact.rule_template_id}</code> · confidence {artifact.confidence}
                              </p>
                              <p>
                                risk {artifact.features.risk_score} · waste {artifact.features.efficiency_waste_score}
                                {" "}· stability {artifact.features.stability_score}
                              </p>
                              <ul>
                                {artifact.value_claims.risk_mitigation.map((item, index) => (
                                  <li key={`risk-${artifact.intent_id}-${index}`}>{item}</li>
                                ))}
                                {artifact.value_claims.efficiency_improvement.map((item, index) => (
                                  <li key={`eff-${artifact.intent_id}-${index}`}>{item}</li>
                                ))}
                                {artifact.value_claims.quality_standardization.map((item, index) => (
                                  <li key={`qual-${artifact.intent_id}-${index}`}>{item}</li>
                                ))}
                              </ul>
                              <details>
                                <summary>Evidence refs ({artifact.evidence_refs.length})</summary>
                                <ul>
                                  {artifact.evidence_refs.slice(0, 10).map((item) => (
                                    <li key={`${artifact.intent_id}-${item.event_id}`}>
                                      {item.event_id} · {item.reason}
                                    </li>
                                  ))}
                                </ul>
                              </details>
                              <div className="reviewer-focus__actions">
                                <button
                                  type="button"
                                  onClick={() => void copyText(JSON.stringify(artifact.rule_spec, null, 2))}
                                >
                                  Copy Rule JSON
                                </button>
                                <button type="button" onClick={() => void copyText(artifact.skill_draft)}>
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
              ) : timelineTab === "context" ? (
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
                      <span className={`risk risk-${selectedDeliverable.risk}`}>Risk: {selectedDeliverable.risk}</span>
                      <span>Est. tokens: {selectedDeliverable.token_total.toLocaleString()}</span>
                      <span>
                        Est. cost: {selectedDeliverable.estimated_cost_usd != null ? `$${selectedDeliverable.estimated_cost_usd}` : "-"}
                      </span>
                    </div>
                  </section>

                  <div className="deliverable-tabs">
                    <button
                      type="button"
                      className={deliverableTab === "what_changed" ? "active" : ""}
                      onClick={() => setDeliverableTab("what_changed")}
                    >
                      What changed
                    </button>
                    <button
                      type="button"
                      className={deliverableTab === "why_changed" ? "active" : ""}
                      onClick={() => setDeliverableTab("why_changed")}
                    >
                      Why changed
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
                      <p className="deliverable-pane__hint">Clean summary first, detail on demand.</p>
                      {selectedDeliverable.event_indices.length > 0 ? (
                        <div className="deliverable-event-links">
                          {selectedDeliverable.event_indices.slice(-8).map((index) => (
                            <button
                              type="button"
                              key={`${selectedDeliverable.id}-${index}`}
                              onClick={() => handleOpenFileEvolution(selectedDeliverable.path, index)}
                            >
                              Jump to event #{index + 1}
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {selectedFilePath ? (
                        <FileEvolutionView
                          session={session}
                          path={selectedFilePath}
                          revisionIndex={selectedRevisionIndex}
                          onRevisionChange={setSelectedRevisionIndex}
                        />
                      ) : null}
                    </section>
                  ) : null}

                  {deliverableTab === "why_changed" ? (
                    <section className="deliverable-pane">{renderWhyChanged(selectedDeliverable)}</section>
                  ) : null}

                  {deliverableTab === "cost" ? (
                    <section className="deliverable-pane">{renderCost(selectedDeliverable)}</section>
                  ) : null}
                </>
              ) : (
                <div className="replay-placeholder">
                  <p>Select a deliverable to inspect what changed, why it changed, and associated intent cost.</p>
                </div>
              )}
            </>
          )}
        </main>
      </div>
      <footer className="replay-footer">
        {viewMode === "timeline" ? (
          <>
            <TimelineStrip
              eventCount={eventCount}
              currentIndex={currentIndex}
              onSeek={handleSeek}
              criticalIndices={criticalIndices}
            />
            <PlaybackControls
              isPlaying={isPlaying}
              speed={speed}
              onPlay={handlePlay}
              onPause={handlePause}
              onSpeedChange={setSpeed}
              disabled={eventCount === 0}
            />
          </>
        ) : null}
      </footer>
    </div>
  );
}
