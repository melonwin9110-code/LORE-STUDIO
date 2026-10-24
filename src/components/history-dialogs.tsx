"use client";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, GitBranch, LoaderCircle, X } from "lucide-react";
import type { HistoryContext, Timeline, Difference } from "@/lib/history-types";
import { GREGORIAN, toOrdinal, type CalendarDefinition } from "@/lib/calendar";
import { historyApi } from "./history-api";
import { DateFields, dateAt, historicalDate } from "./history-controls";

export function HistoryDialog({ title, onClose, busy, children }: { title: string; onClose: () => void; busy?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = ref.current; node?.showModal(); return () => node?.close(); }, []);
  return <dialog ref={ref} className="editor-dialog history-dialog" aria-label={title} onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }} onClick={(e) => { if (e.target === ref.current && !busy) onClose(); }}><div className="editor-header"><div><p className="eyebrow">LORE STUDIO / ИСТОРИЧЕСКАЯ СИСТЕМА</p><h2>{title}</h2></div><button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Закрыть окно"><X size={20} /></button></div>{children}</dialog>;
}
export function TimelineDialog({ worldId, context, calendar, editing, onSaved, onClose }: { worldId: string; context: HistoryContext; calendar: CalendarDefinition; editing?: boolean; onSaved: (timeline: Timeline, day: string | null) => Promise<void>; onClose: () => void }) {
  const [mode, setMode] = useState("fork");
  const [date, setDate] = useState(() => dateAt(context.day, calendar));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = new FormData(e.currentTarget); setBusy(true); setError("");
    try {
      const forkDay = !editing && mode === "fork" ? toOrdinal(date, calendar).toString() : null;
      const body = { name: String(form.get("name")), isCanon: form.get("isCanon") === "on", ...(!editing && forkDay !== null ? { parentId: context.timeline.id, forkDay, expectedParentRevision: context.timeline.headRevision } : {}) };
      const { timeline } = await historyApi<{ timeline: Timeline }>(editing ? `/timelines/${context.timeline.id}` : `/worlds/${worldId}/timelines`, editing ? "PATCH" : "POST", body);
      await onSaved(timeline, forkDay ?? context.day); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "Не удалось сохранить линию"); } finally { setBusy(false); }
  }
  return <HistoryDialog title={editing ? "Настройки временной линии" : "Новая временная линия"} onClose={onClose} busy={busy}><form onSubmit={submit}><div className="editor-content"><div className="history-dialog-intro"><GitBranch size={27} /><p>{editing ? "Название и статус канона относятся только к этой линии." : "Зафиксируйте момент расхождения истории или начните независимую хронологию."}</p></div><label className="field"><span>Название линии</span><input aria-label="Название линии" name="name" required maxLength={160} defaultValue={editing ? context.timeline.name : ""} placeholder="Например, Рассвет новой династии" autoFocus /></label>{!editing && <><label className="field"><span>Тип линии</span><select aria-label="Тип линии" value={mode} onChange={(e) => setMode(e.target.value)}><option value="fork">Ответвление от текущей линии</option><option value="independent">Независимая пустая линия</option></select></label>{mode === "fork" && <><p className="field-hint">Родитель: «{context.timeline.name}». Состояние на дату и редакция {context.timeline.headRevision} будут зафиксированы.</p><DateFields prefix="Год ответвления" value={date} onChange={setDate} calendar={calendar} /></>}</>}<label className="checkbox-field"><input name="isCanon" type="checkbox" defaultChecked={editing ? context.timeline.isCanon : false} /><span>Каноническая линия</span></label>{error && <p role="alert" className="form-error">{error}</p>}</div><div className="editor-footer"><span /><button type="button" onClick={onClose} className="button secondary" disabled={busy}>Отмена</button><button className="button primary" disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{editing ? "Сохранить линию" : "Создать линию"}</button></div></form></HistoryDialog>;
}
const kindNames = { characters: "Персонаж", events: "Событие", relations: "Отношение" };
const changeNames = { added: "Только в текущей", removed: "Только в сравниваемой", changed: "Отличается" };
function objectName(difference: Difference) { const record = difference.right || difference.left; return String(record?.name || record?.kind || "Объект"); }
export function CompareDialog({ context, calendar = GREGORIAN, onTransferred, onClose }: { context: HistoryContext; calendar?: CalendarDefinition; onTransferred: () => Promise<void>; onClose: () => void }) {
  const [other, setOther] = useState(context.timelines.find((line) => line.id !== context.timeline.id)?.id || "");
  const [differences, setDifferences] = useState<Difference[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<{ left: string; right: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [overwrite, setOverwrite] = useState(false), [dependencies, setDependencies] = useState(true);
  async function compare() {
    setBusy(true); setError(""); setNotice("");
    try { const params = new URLSearchParams({ other }); if (context.day !== null) params.set("day", context.day); const result = await historyApi<{ differences: Difference[]; leftRevision: string; rightRevision: string }>(`/timelines/${context.timeline.id}/compare?${params}`); setDifferences(result.differences); setSnapshot({ left: result.leftRevision, right: result.rightRevision }); setSelected([]); }
    catch (err) { setError(err instanceof Error ? err.message : "Сравнение недоступно"); } finally { setBusy(false); }
  }
  async function transfer() {
    if (overwrite && !window.confirm("Заменить выбранные объекты текущей линии версиями из другой линии? Предыдущие состояния сохранятся в истории.")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await historyApi<{ transferred: number }>(`/timelines/${context.timeline.id}/transfer`, "POST", { sourceId: other, objectIds: selected, ...(context.day !== null ? { sourceDay: context.day, targetDay: context.day } : {}), expectedRevision: snapshot?.left ?? context.timeline.headRevision, expectedSourceRevision: snapshot?.right, overwrite, includeDependencies: dependencies });
      await onTransferred(); setNotice(`Перенесено объектов: ${result.transferred}. Стабильные идентификаторы и связи сохранены.`); setDifferences(null); setSnapshot(null); setSelected([]);
    } catch (err) { setError(err instanceof Error ? err.message : "Не удалось перенести объекты"); } finally { setBusy(false); }
  }
  return <HistoryDialog title="Сравнение и перенос объектов" onClose={onClose} busy={busy}><div className="editor-content"><p className="field-hint">Текущая линия: <strong>{context.timeline.name}</strong>. Дата: {historicalDate(context.day, calendar)}. Перенос идёт из сравниваемой линии в текущую.</p><div className="compare-select"><label className="field"><span>Сравнить с линией</span><select aria-label="Сравнить с линией" disabled={busy} value={other} onChange={(e) => { setOther(e.target.value); setDifferences(null); setSnapshot(null); setSelected([]); }}>{context.timelines.filter((line) => line.id !== context.timeline.id).map((line) => <option value={line.id} key={line.id}>{line.name}</option>)}</select></label><button className="button secondary" disabled={busy || !other} onClick={compare}>Сравнить</button></div>{differences !== null && <><div className="comparison-summary">{differences.length ? `Отличий: ${differences.length}` : "На выбранную дату различий нет."}</div><div className="difference-list">{differences.map((difference) => <label className="difference-row" key={difference.id}><input type="checkbox" disabled={!difference.right || busy} checked={selected.includes(difference.id)} onChange={(e) => setSelected((old) => e.target.checked ? [...old, difference.id] : old.filter((id) => id !== difference.id))} /><div><strong>{objectName(difference)}</strong><small>{kindNames[difference.kind]} · {changeNames[difference.change]}</small>{difference.change === "changed" && <details><summary>Посмотреть значения</summary><div className="difference-values"><pre>{JSON.stringify(difference.left, null, 2)}</pre><pre>{JSON.stringify(difference.right, null, 2)}</pre></div></details>}</div></label>)}</div><label className="checkbox-field"><input type="checkbox" disabled={busy} checked={dependencies} onChange={(e) => setDependencies(e.target.checked)} /><span>Добавить связанных персонажей</span></label><label className="checkbox-field"><input type="checkbox" disabled={busy} checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /><span>Разрешить замену конфликтующих объектов</span></label><p className="field-hint">Без разрешения замены конфликты прервут весь перенос. Исходная линия сохраняется.</p></>}{error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="history-success" role="status">{notice}</p>}</div><div className="editor-footer"><span /><button className="button secondary" disabled={busy} onClick={onClose}>Закрыть</button><button className="button primary" disabled={busy || !selected.length || !snapshot} onClick={transfer}>{busy ? "Переносим…" : "Перенести выбранные"}</button></div></HistoryDialog>;
}
