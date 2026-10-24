"use client";
import { useEffect, useState } from "react";
import { CalendarDays, GitBranch, GitCompare, Plus, Settings2, Clock3 } from "lucide-react";
import { fromOrdinal, toOrdinal, formatDate, GREGORIAN, type CalendarDefinition, type WorldDate } from "@/lib/calendar";
import type { HistoryContext } from "@/lib/history-types";

export function historicalDate(day: string | null, calendar: CalendarDefinition = GREGORIAN) {
  if (day === null || day === "1000000000000000") return "Последнее состояние";
  if (day === "-1000000000000000") return "Начальное состояние";
  try { return formatDate(fromOrdinal(BigInt(day), calendar), calendar); } catch { return `День ${day}`; }
}
export function dateAt(day: string | null, calendar: CalendarDefinition): WorldDate {
  try { return day === null ? { year: 1248, month: 1, day: 1 } : fromOrdinal(BigInt(day), calendar); }
  catch { return { year: 1248, month: 1, day: 1 }; }
}
export function DateFields({ value, onChange, calendar, prefix = "Исторический" }: { value: WorldDate; onChange: (date: WorldDate) => void; calendar: CalendarDefinition; prefix?: string }) {
  const yearLabel = prefix === "Исторический" ? "Исторический год" : prefix;
  return <div className="history-date-fields">
    <label className="field"><span>{yearLabel}</span><input aria-label={yearLabel} type="number" min={-1000000000} max={1000000000} step={1} value={value.year} onChange={(e) => onChange({ ...value, year: Number(e.target.value) })} required /></label>
    <label className="field"><span>Месяц</span><select aria-label={`${prefix} месяц`} value={value.month} onChange={(e) => onChange({ ...value, month: Number(e.target.value) })}>{calendar.months.map((month, index) => <option key={index} value={index + 1}>{month.name}</option>)}</select></label>
    <label className="field"><span>День</span><input aria-label={`${prefix} день`} type="number" min={1} max={10000} step={1} value={value.day} onChange={(e) => onChange({ ...value, day: Number(e.target.value) })} required /></label>
  </div>;
}
export function HistoryControls({ context, calendarId, onCalendarChange, onChange, onNew, onManage, onCompare, busy }: {
  context: HistoryContext; calendarId: string; onCalendarChange: (id: string) => void;
  onChange: (timelineId: string, day: string | null) => Promise<void>; onNew: () => void; onManage: () => void; onCompare: () => void; busy: boolean;
}) {
  const calendar = context.calendars.find((c) => c.id === calendarId)?.definition || GREGORIAN;
  const [draft, setDraft] = useState(() => dateAt(context.day, calendar));
  const [error, setError] = useState("");
  useEffect(() => { Promise.resolve().then(() => { setDraft(dateAt(context.day, calendar)); setError(""); }); }, [context.day, calendar]);
  const beforeFork = context.day !== null && context.timeline.forkDay !== null && BigInt(context.day) < BigInt(context.timeline.forkDay);
  function show() {
    try { const day = toOrdinal(draft, calendar).toString(); setError(""); void onChange(context.timeline.id, day); }
    catch (err) { setError(err instanceof Error ? err.message : "Проверьте дату"); }
  }
  return <section className="history-context" aria-label="Исторический контекст">
    <div className="history-context-top"><span className="history-context-title"><GitBranch size={17} />Линия и время</span><span className={`status-badge ${context.timeline.isCanon ? "canon" : "draft"}`}>{context.timeline.isCanon ? "Каноническая линия" : "Альтернативная линия"}</span><span className="history-context-spacer" /><button className="text-button" onClick={onNew} disabled={busy}><Plus size={14} />Новая линия</button><button className="icon-button" onClick={onManage} aria-label="Настройки временной линии" disabled={busy}><Settings2 size={16} /></button><button className="icon-button" onClick={onCompare} aria-label="Сравнить временные линии" disabled={busy || context.timelines.length < 2}><GitCompare size={17} /></button></div>
    <div className="history-context-fields"><label className="field history-line-field"><span>Временная линия</span><select aria-label="Временная линия" value={context.timeline.id} disabled={busy} onChange={(e) => void onChange(e.target.value, context.day)}>{context.timelines.map((line) => <option key={line.id} value={line.id}>{line.name}{line.isMain ? " · основная" : ""}</option>)}</select></label><label className="field history-calendar-field"><span>Календарь просмотра</span><select aria-label="Календарь просмотра" value={calendarId || context.calendars[0]?.id || ""} onChange={(e) => onCalendarChange(e.target.value)}>{context.calendars.map((record) => <option value={record.id} key={record.id}>{record.definition.name}</option>)}</select></label><DateFields value={draft} onChange={setDraft} calendar={calendar} /><div className="history-date-actions"><button className="button secondary" disabled={busy} onClick={show}><CalendarDays size={15} />Показать дату</button><button className="text-button" disabled={busy || context.day === null} onClick={() => void onChange(context.timeline.id, null)}><Clock3 size={13} />Последнее состояние</button></div></div>
    <div className="history-context-bottom"><span><Clock3 size={13} />{historicalDate(context.day, calendar)}</span><span>Правки сохраняются в выбранной линии{context.day !== null ? " с этой даты" : ""}.</span></div>
    {context.timeline.parentId && <p className="field-hint">Ответвление от «{context.timelines.find((line) => line.id === context.timeline.parentId)?.name || "Родительская линия"}» · {historicalDate(context.timeline.forkDay, calendar)}. Редакция родителя зафиксирована.</p>}
    {beforeFork && <p className="form-error" role="status">Это общая история до ответвления. Для правок выберите дату ответвления или позднее.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
