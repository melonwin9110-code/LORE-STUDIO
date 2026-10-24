"use client";
import { useEffect, useState } from "react";
import { History, LoaderCircle } from "lucide-react";
import type { Revision } from "@/lib/history-types";
import type { CalendarDefinition } from "@/lib/calendar";
import { historyApi } from "./history-api";
import { historicalDate } from "./history-controls";

export function RevisionHistory({ kind, id, timelineId, calendar }: { kind: "character" | "event" | "relation"; id: string; timelineId: string; calendar: CalendarDefinition }) {
  const [revisions, setRevisions] = useState<Revision[] | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const resource = kind === "character" ? "characters" : kind === "event" ? "events" : "relations";
    historyApi<{ revisions: Revision[] }>(`/${resource}/${id}/history?${new URLSearchParams({ timeline: timelineId })}`).then((result) => { if (!cancelled) setRevisions(result.revisions); }).catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [kind, id, timelineId]);
  return <section className="revision-history"><h3><History size={17} />История состояний</h3><p className="field-hint">Предыдущие редакции сохраняются. Для просмотра карточки на нужный момент выберите дату в верхней панели.</p>{error ? <p className="form-error" role="alert">{error}</p> : revisions === null ? <LoaderCircle className="spin" size={20} /> : revisions.length ? <ol>{revisions.map((revision) => <li key={revision.revision}><div><strong>{historicalDate(revision.effectiveDay, calendar)}</strong><span className="pill subtle">{revision.deleted ? "Удаление" : `Состояние ${revision.version}`}</span></div>{revision.data && <p>{String(revision.data.name || revision.data.kind || "Редакция объекта")}{revision.data.biography ? ` · ${String(revision.data.biography).slice(0, 250)}` : ""}</p>}</li>)}</ol> : <p className="muted">Состояний в этой линии пока нет.</p>}</section>;
}
