import { useMemo, useState } from "react";
import type { Session } from "../types/session";
import type { SubagentNode } from "../lib/subagentAnalysis";
import { deriveSubagentGraph } from "../lib/subagentAnalysis";

import "./OrchestrationView.css";

interface OrchestrationViewProps {
  session: Session;
  onSeek: (index: number) => void;
}

export function OrchestrationView({ session, onSeek }: OrchestrationViewProps) {
  const graph = useMemo(() => deriveSubagentGraph(session.events), [session.events]);
  const rootId = graph.nodes.find((node) => node.level === 0)?.agent_id ?? graph.nodes[0]?.agent_id ?? null;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(rootId);

  const selectedNode = graph.nodes.find((node) => node.agent_id === selectedNodeId) ?? null;
  const directChildren = useMemo(() => {
    if (!rootId) return [];
    const childIds = new Set(
      graph.edges.filter((edge) => edge.from_agent_id === rootId).map((edge) => edge.to_agent_id)
    );
    return graph.nodes.filter((node) => childIds.has(node.agent_id));
  }, [graph.edges, graph.nodes, rootId]);

  const relatedChildren = useMemo(() => {
    if (!selectedNode) return [];
    const childIds = new Set(
      graph.edges.filter((edge) => edge.from_agent_id === selectedNode.agent_id).map((edge) => edge.to_agent_id)
    );
    return graph.nodes.filter((node) => childIds.has(node.agent_id));
  }, [graph.edges, graph.nodes, selectedNode]);

  const renderNodeCard = (node: SubagentNode, role: "root" | "child" | "selected") => (
    <button
      key={`${role}-${node.agent_id}`}
      type="button"
      className={`orchestration__node-card ${selectedNodeId === node.agent_id ? "is-selected" : ""}`}
      onClick={() => setSelectedNodeId(node.agent_id)}
    >
      <div className="orchestration__node-head">
        <h3>{node.label}</h3>
        <span>{node.synthetic ? "synthetic" : "explicit"}</span>
      </div>
      <p>
        status {node.status} · level {node.level}
      </p>
      <p>
        tokens {node.token_total.toLocaleString()} · output {node.output_tokens.toLocaleString()} · files {node.deliverable_count}
      </p>
    </button>
  );

  return (
    <section className="orchestration">
      <header className="orchestration__header">
        <h2>Subagent Orchestration</h2>
        <p>Execution DAG with deterministic parent-child reconstruction and bottleneck signals.</p>
      </header>

      <div className="orchestration__summary">
        <span>{graph.summary.agent_count} agents</span>
        <span>{graph.summary.edge_count} handoffs</span>
        <span>{graph.summary.token_total.toLocaleString()} tokens</span>
        <span>confidence {graph.summary.confidence}</span>
      </div>

      {graph.nodes.length === 0 ? (
        <p className="replay-placeholder-note">No subagent graph could be derived from this session.</p>
      ) : (
        <>
          <div className="orchestration__dag">
            <div className="orchestration__lane">
              <h3>Coordinator</h3>
              {rootId ? renderNodeCard(graph.nodes.find((n) => n.agent_id === rootId) ?? graph.nodes[0], "root") : null}
            </div>
            <div className="orchestration__lane">
              <h3>Direct children (level 1)</h3>
              <div className="orchestration__lane-grid">
                {directChildren.map((node) => renderNodeCard(node, "child"))}
              </div>
            </div>
          </div>

          <div className="orchestration__bottlenecks">
            <h3>Bottlenecks</h3>
            {graph.bottlenecks.length === 0 ? <p>No major bottlenecks detected.</p> : null}
            <ul>
              {graph.bottlenecks.slice(0, 8).map((item, index) => (
                <li key={`${item.type}-${index}`}>
                  <strong>{item.severity.toUpperCase()}</strong> · {item.reason}
                </li>
              ))}
            </ul>
          </div>

          {selectedNode ? (
            <div className="orchestration__detail">
              <h3>Node Drill-down: {selectedNode.label}</h3>
              <p>
                Agent {selectedNode.agent_id} · seq {selectedNode.start_seq}..{selectedNode.end_seq}
              </p>
              <p>
                Context {selectedNode.context_tokens.toLocaleString()} · Output {selectedNode.output_tokens.toLocaleString()} · Unknown {selectedNode.unknown_tokens.toLocaleString()}
              </p>
              <div className="orchestration__detail-actions">
                <button type="button" onClick={() => onSeek(Math.max(0, selectedNode.start_seq - 1))}>
                  Jump to start
                </button>
                <button type="button" onClick={() => onSeek(Math.max(0, selectedNode.end_seq - 1))}>
                  Jump to end
                </button>
              </div>
              {relatedChildren.length > 0 ? (
                <>
                  <h4>Descendants</h4>
                  <div className="orchestration__lane-grid">
                    {relatedChildren.map((node) => renderNodeCard(node, "selected"))}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
