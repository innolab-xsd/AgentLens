import type { DeliverableItem } from "../lib/deliverables";

import "./DeliverablesList.css";

interface DeliverablesListProps {
  items: DeliverableItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function DeliverablesList({ items, selectedId, onSelect }: DeliverablesListProps) {
  return (
    <div className="deliverables-list">
      <h2 className="panel-title">Deliverables</h2>
      {items.length === 0 ? <p className="panel-empty">No deliverables found.</p> : null}
      <ul className="deliverables-list__ul">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={`deliverables-list__item ${selectedId === item.id ? "is-selected" : ""}`}
              onClick={() => onSelect(item.id)}
            >
              <div className="deliverables-list__title">{item.title}</div>
              <div className="deliverables-list__meta">
                <span>{item.status}</span>
                <span className={`risk risk-${item.risk}`}>{item.risk}</span>
                <span>{item.token_total.toLocaleString()} tok</span>
              </div>
              <div className="deliverables-list__path">{item.path}</div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
