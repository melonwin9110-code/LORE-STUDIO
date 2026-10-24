"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Check, GitBranch, LoaderCircle, RefreshCw, Shield, Trash2 } from "lucide-react";
import type { Relation } from "@/lib/types";
import type { FamilyCharacter, FamilyData } from "@/lib/workspace-types";
import { FamilyView } from "./family-view";
import { HistoryApiError, historyApi } from "./history-api";
import { HistoryDialog } from "./history-dialogs";

export function FamilyWorkspace({ worldId, canEdit, onCharacter }: { worldId: string; canEdit: boolean; onCharacter: (character: FamilyCharacter) => void }) {
  const [data, setData] = useState<FamilyData | null>(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [editor, setEditor] = useState<Relation | "new" | null>(null);
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(async () => {
      if (!cancelled) { setLoading(true); setError(""); }
      return historyApi<FamilyData>(`/worlds/${worldId}/family`);
    }).then((result) => { if (!cancelled) setData(result); }).catch((err: Error) => { if (!cancelled) setError(err.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [worldId]);
  async function reload() {
    setBusy(true); setError("");
    try { setData(await historyApi<FamilyData>(`/worlds/${worldId}/family`)); setEditor(null); setConflict(false); }
    catch (err) { setError(err instanceof Error ? err.message : "Не удалось загрузить древо"); }
    finally { setBusy(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!data || editor === null) return;
    const fields = new FormData(event.currentTarget), existing = editor === "new" ? null : editor;
    const payload = { fromId: String(fields.get("fromId")), toId: String(fields.get("toId")), familyKind: String(fields.get("familyKind")), description: String(fields.get("description") || ""), expectedVersion: data.version, ...(existing ? { version: existing.version } : {}) };
    setBusy(true); setError(""); setConflict(false);
    try {
      setData(await historyApi<FamilyData>(existing ? `/family/relations/${existing.id}` : `/worlds/${worldId}/family/relations`, existing ? "PATCH" : "POST", payload));
      setEditor(null);
    } catch (err) { setError(err instanceof Error ? err.message : "Не удалось сохранить родство"); setConflict(err instanceof HistoryApiError && err.status === 409); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!data || !editor || editor === "new" || !window.confirm("Удалить родственную связь? Общее древо этого мира изменится для всех временных линий.")) return;
    setBusy(true); setError(""); setConflict(false);
    try { setData(await historyApi<FamilyData>(`/family/relations/${editor.id}`, "DELETE", { expectedVersion: data.version })); setEditor(null); }
    catch (err) { setError(err instanceof Error ? err.message : "Не удалось удалить связь"); setConflict(err instanceof HistoryApiError && err.status === 409); }
    finally { setBusy(false); }
  }
  async function importExisting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!data) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true); setError("");
    try { setData(await historyApi<FamilyData>(`/worlds/${worldId}/family/import`, "POST", { timelineId: String(fields.get("timelineId")), expectedVersion: data.version })); }
    catch (err) { setError(err instanceof Error ? err.message : "Не удалось перенести прежнее древо"); }
    finally { setBusy(false); }
  }
  if (loading) return <div className="loading-state"><LoaderCircle className="spin" size={26} /><p>Собираем семейную историю…</p></div>;
  if (!data) return <section className="family-empty"><h1>Семейное древо</h1><p role="alert">{error || "Не удалось загрузить древо"}</p><button className="button secondary" onClick={() => void reload()} disabled={busy}><RefreshCw size={15} />Повторить</button></section>;
  const existing = editor && editor !== "new" ? editor : undefined;
  return <section className="family-workspace">
    <div className="independent-family-note"><Shield size={15} /><span>Общее древо мира · работает независимо от даты и временной линии</span><button className="icon-button" aria-label="Обновить семейное древо" onClick={() => void reload()} disabled={busy}><RefreshCw size={14} /></button></div>
    {error && !editor && <p className="error-banner" role="alert">{error}</p>}
    {data.migration?.required && <section className="family-import"><GitBranch size={24} /><div><h2>Сохраним прежние семейные связи</h2><p>{data.migration.message || "В прежних линиях различалось родство. Выберите исходную версию для общего древа мира; прежняя история сохранится."}</p>{canEdit ? <form onSubmit={importExisting}><label className="field"><span>Исходная версия древа</span><select name="timelineId" aria-label="Исходная версия семейного древа" required defaultValue={data.migration.sources[0]?.timelineId}>{data.migration.sources.map((source) => <option key={source.timelineId} value={source.timelineId}>{source.name} · связей: {source.count}</option>)}</select></label><button className="button primary" disabled={busy || !data.migration.sources.length}>{busy ? "Переносим…" : "Использовать выбранное древо"}</button></form> : <p>Выбрать исходную версию может владелец или редактор проекта.</p>}</div></section>}
    <FamilyView characters={data.characters} relations={data.relations} canEdit={canEdit && !data.migration?.required} onAdd={() => { setError(""); setEditor("new"); }} onCharacter={(character) => { const full = data.characters.find((item) => item.id === character.id); if (full) onCharacter(full); }} onEditRelation={(relation) => { setError(""); setEditor(relation); }} />
    {editor !== null && <HistoryDialog title={existing ? "Родственная связь" : "Новая родственная связь"} onClose={() => { setEditor(null); setError(""); }} busy={busy}><form onSubmit={save}><div className="editor-content"><p className="field-hint">Родство общее для мира. Для родителя первый персонаж — родитель, второй — ребёнок.</p><div className="form-columns"><label className="field"><span>От персонажа</span><select name="fromId" aria-label="От персонажа" defaultValue={existing?.fromId || data.characters[0]?.id}>{data.characters.map((character) => <option value={character.id} key={character.id}>{character.name}</option>)}</select></label><label className="field"><span>К персонажу</span><select name="toId" aria-label="К персонажу" defaultValue={existing?.toId || data.characters[1]?.id}>{data.characters.map((character) => <option value={character.id} key={character.id}>{character.name}</option>)}</select></label></div><label className="field"><span>Семейная связь</span><select name="familyKind" aria-label="Семейная связь" defaultValue={existing?.familyKind || "parent"}><option value="parent">Родитель → ребёнок</option><option value="adoptive_parent">Усыновитель → ребёнок</option><option value="spouse">Брак</option></select></label><label className="field"><span>Описание родства</span><textarea name="description" aria-label="Описание родства" defaultValue={existing?.description || ""} rows={4} maxLength={10000} /></label>{error && <p className="form-error" role="alert">{error}</p>}{conflict && <button type="button" className="button secondary" onClick={() => void reload()}>Перечитать древо</button>}</div><div className="editor-footer">{existing && <button type="button" className="button danger-quiet" disabled={busy} onClick={() => void remove()}><Trash2 size={15} />Удалить родство</button>}<span /><button type="button" className="button secondary" disabled={busy} onClick={() => { setEditor(null); setError(""); }}>Отмена</button><button className="button primary" disabled={busy || !canEdit || conflict}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}Сохранить родство</button></div></form></HistoryDialog>}
  </section>;
}
