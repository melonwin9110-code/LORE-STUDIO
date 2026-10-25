"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, CircleDot, Eye, GitBranch, History, Layers3, LoaderCircle, Lock, Map as MapIcon, Merge, MousePointer2, Move, Pencil, Plus, Redo2, RefreshCw, Save, Scissors, Settings2, Shield, Trash2, Undo2, Waves } from "lucide-react";
import type { CalendarDefinition } from "@/lib/calendar";
import type { HistoryContext } from "@/lib/history-types";
import type { LoreEvent } from "@/lib/types";
import { GEOGRAPHY_TYPES, type AtlasMap, type GeographyKind, type MapBatchInput, type MapChange, type MapData, type MapFeature, type MapFeatureHistory, type MapFeatureInput, type MapGeometry, type MapInput, type MapLayer, type MapLayerInput, type MapTool, type MapView } from "@/lib/map-types";
import { HistoryApiError, historyApi } from "./history-api";
import { historicalDate } from "./history-controls";
import { HistoryDialog } from "./history-dialogs";
import styles from "./map-workspace.module.css";

const MapCanvas = dynamic(() => import("./map-canvas").then((module) => module.MapCanvas), { ssr: false, loading: () => <div className={styles.canvasLoading}><LoaderCircle className="spin" size={26} /><span>Разворачиваем карту…</span></div> });
type Draft = { layers: MapLayer[]; features: MapFeature[] };
type DraftHistory = { past: Draft[]; present: Draft; future: Draft[] };
type Props = { worldId: string; context: HistoryContext; events: LoreEvent[]; canEdit: boolean; onChanged: () => Promise<void>; calendar: CalendarDefinition; onNavigationGuard?: (guard: (() => boolean) | null) => void; onDirtyChange?: (dirty: boolean) => void };
const layerLabels = { physical: "Физический", political: "Политический", custom: "Пользовательский" };
const polygonKinds = new Set<GeographyKind>(["continent", "island", "ocean", "sea", "lake", "plain", "forest", "desert", "biome", "state", "province"]);
const lineKinds = new Set<GeographyKind>(["coastline", "river", "road", "border"]);
const pointKinds = new Set<GeographyKind>(["city", "settlement", "port", "fortress", "label"]);
const politicalKinds = new Set<GeographyKind>(["state", "province", "border"]);
const colors: Partial<Record<GeographyKind, string>> = { continent: "#b5b78b", island: "#c6ba91", ocean: "#355b70", sea: "#47778a", lake: "#699dac", river: "#79b4cc", forest: "#658c74", desert: "#c9aa72", mountain: "#aaa49e", plain: "#b2b97a", biome: "#879d78", state: "#ae8ac7", province: "#c9a7d3", city: "#e0be7a", road: "#cdbd9a", border: "#b794d6" };
function drawingTool(kind: GeographyKind): MapTool { return lineKinds.has(kind) ? "line" : pointKinds.has(kind) ? "point" : "polygon"; }
function polygon(geometry: MapGeometry): geometry is Extract<MapGeometry, { type: "Polygon" | "MultiPolygon" }> { return geometry.type === "Polygon" || geometry.type === "MultiPolygon"; }
function geometryFits(kind: GeographyKind, geometry: MapGeometry) { return polygonKinds.has(kind) ? polygon(geometry) : lineKinds.has(kind) ? geometry.type === "LineString" : pointKinds.has(kind) ? geometry.type === "Point" : true; }
function layerInput(layer: MapLayer): MapLayerInput { return { name: layer.name, kind: layer.kind, visible: layer.visible, locked: layer.locked, opacity: layer.opacity, order: layer.order }; }
function featureInput(feature: MapFeature): MapFeatureInput { return { name: feature.name, kind: feature.kind, layerId: feature.layerId, geometry: feature.geometry, description: feature.description, fill: feature.fill, stroke: feature.stroke, strokeWidth: feature.strokeWidth, label: feature.label, eventId: feature.eventId, parentId: feature.parentId }; }
function differences<T extends { id: string; version: number }, V>(previous: T[], current: T[], input: (item: T) => V): MapChange<V>[] {
  const old = new Map(previous.map((item) => [item.id, item]));
  const next = new Set(current.map((item) => item.id));
  const changes: MapChange<V>[] = [];
  for (const item of current) { const before = old.get(item.id); const data = input(item); if (!before) changes.push({ op: "create", id: item.id, data }); else if (JSON.stringify(input(before)) !== JSON.stringify(data)) changes.push({ op: "update", id: item.id, version: before.version, data }); }
  for (const item of previous) if (!next.has(item.id)) changes.push({ op: "delete", id: item.id, version: item.version });
  return changes;
}

export function MapWorkspace({ worldId, context, events, canEdit, onChanged, calendar, onNavigationGuard, onDirtyChange }: Props) {
  const [maps, setMaps] = useState<AtlasMap[]>([]), [base, setBase] = useState<MapData | null>(null), [draft, setDraft] = useState<DraftHistory | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false), [view, setView] = useState<MapView>("physical"), [tool, setTool] = useState<MapTool>("select");
  const [selectedIds, setSelectedIds] = useState<string[]>([]), [activeLayerId, setActiveLayerId] = useState<string | null>(null), [drawingKind, setDrawingKind] = useState<GeographyKind>("continent");
  const [mapDialog, setMapDialog] = useState<"new" | "edit" | null>(null), [layerDialog, setLayerDialog] = useState<MapLayer | "new" | null>(null), [historyFeature, setHistoryFeature] = useState<MapFeature | null>(null), [search, setSearch] = useState("");
  const [hiddenLayers, setHiddenLayers] = useState<string[]>([]);
  const lastMapId = useRef<string | null>(null);
  const scope = `?${new URLSearchParams({ timeline: context.timeline.id, ...(context.day !== null ? { day: context.day } : {}) })}`;
  const layers = draft?.present.layers || [], features = draft?.present.features || [];
  const batch = useMemo<MapBatchInput | null>(() => base && draft ? { expectedRevision: base.revision, layers: differences(base.layers, draft.present.layers, layerInput), features: differences(base.features, draft.present.features, featureInput) } : null, [base, draft]);
  const dirty = Boolean(batch && (batch.layers.length || batch.features.length));
  const editable = canEdit && !busy && !conflict;
  const selected = features.filter((feature) => selectedIds.includes(feature.id));
  const activeLayer = layers.find((layer) => layer.id === activeLayerId);
  const selectedEditable = selected.length > 0 && selected.every((feature) => !layers.find((layer) => layer.id === feature.layerId)?.locked);
  const install = useCallback((data: MapData | null) => {
    setBase(data); setDraft(data ? { past: [], present: { layers: data.layers, features: data.features }, future: [] } : null);
    setSelectedIds([]); setActiveLayerId(data?.layers.find((layer) => layer.visible && !layer.locked)?.id || data?.layers[0]?.id || null);
    setTool("select"); setConflict(false); setHiddenLayers([]); lastMapId.current = data?.map.id || null;
  }, []);
  const confirmLeave = useCallback(() => !busy && (!dirty || window.confirm("На карте есть несохранённые изменения. Перейти и оставить их без сохранения?")), [dirty, busy]);
  useEffect(() => { onNavigationGuard?.(confirmLeave); return () => onNavigationGuard?.(null); }, [confirmLeave, onNavigationGuard]);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => { if (!cancelled) { setLoading(true); setError(""); } return historyApi<{ maps: AtlasMap[]; revision: string }>(`/worlds/${worldId}/maps${scope}`); }).then(async (result) => {
      if (cancelled) return;
      setMaps(result.maps);
      const id = result.maps.some((map) => map.id === lastMapId.current) ? lastMapId.current : result.maps[0]?.id;
      const data = id ? await historyApi<MapData>(`/maps/${id}${scope}`) : null;
      if (!cancelled) install(data);
    }).catch((err: Error) => { if (!cancelled) setError(err.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [worldId, scope, install]);

  function commit(change: (current: Draft) => Draft) {
    if (!editable) return;
    setDraft((old) => {
      if (!old) return old;
      const next = change(old.present);
      if (JSON.stringify(next) === JSON.stringify(old.present)) return old;
      return { past: [...old.past.slice(-49), old.present], present: next, future: [] };
    });
    setNotice(""); setError("");
  }
  async function reload(force = false) {
    if (!force && !confirmLeave()) return;
    setBusy(true); setError("");
    try {
      const list = await historyApi<{ maps: AtlasMap[] }>(`/worlds/${worldId}/maps${scope}`); setMaps(list.maps);
      const id = list.maps.find((map) => map.id === base?.map.id)?.id || list.maps[0]?.id;
      install(id ? await historyApi<MapData>(`/maps/${id}${scope}`) : null);
      setNotice("Сохранённая карта загружена");
    } catch (err) { setError(err instanceof Error ? err.message : "Не удалось перечитать карту"); }
    finally { setBusy(false); }
  }
  async function chooseMap(id: string) {
    if (!confirmLeave()) return;
    setBusy(true); setError("");
    try { install(await historyApi<MapData>(`/maps/${id}${scope}`)); setNotice(""); }
    catch (err) { setError(err instanceof Error ? err.message : "Не удалось открыть карту"); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!base || !batch || !dirty || !editable) return;
    if (batch.layers.length + batch.features.length > 200) { setError("За одно сохранение можно изменить не более 200 объектов и слоёв. Отмените часть последних действий и сохраните карту поэтапно."); return; }
    setBusy(true); setError("");
    try { install(await historyApi<MapData>(`/maps/${base.map.id}/content${scope}`, "PUT", batch)); setNotice("Карта сохранена в выбранной линии и дате"); await onChanged(); }
    catch (err) { setError(err instanceof Error ? err.message : "Не удалось сохранить карту"); if (err instanceof HistoryApiError && err.status === 409) setConflict(true); }
    finally { setBusy(false); }
  }
  async function mapSaved(input: MapInput) {
    const result = await historyApi<MapData>(mapDialog === "edit" && base ? `/maps/${base.map.id}${scope}` : `/worlds/${worldId}/maps${scope}`, mapDialog === "edit" ? "PATCH" : "POST", mapDialog === "edit" && base ? { version: base.map.version, name: input.name, description: input.description, background: input.background } : input);
    setMaps((old) => [result.map, ...old.filter((map) => map.id !== result.map.id)]); install(result); setNotice(mapDialog === "edit" ? "Настройки карты сохранены" : "Пустая карта создана"); setMapDialog(null); await onChanged();
  }
  async function removeMap() {
    if (!base || !canEdit || !confirmLeave() || !window.confirm(`Удалить карту «${base.map.name}» в выбранной линии с этой даты? Предыдущие исторические состояния сохранятся.`)) return;
    setBusy(true); setError("");
    try { await historyApi(`/maps/${base.map.id}${scope}`, "DELETE", { version: base.map.version }); install(null); const list = await historyApi<{ maps: AtlasMap[] }>(`/worlds/${worldId}/maps${scope}`); setMaps(list.maps); if (list.maps[0]) install(await historyApi<MapData>(`/maps/${list.maps[0].id}${scope}`)); setNotice("Карта удалена в выбранном историческом состоянии"); await onChanged(); }
    catch (err) { setError(err instanceof Error ? err.message : "Не удалось удалить карту"); }
    finally { setBusy(false); }
  }
  function createGeometry(geometry: MapGeometry) {
    if (!base || !activeLayer || activeLayer.locked || !activeLayer.visible || !editable) return;
    if (!geometryFits(drawingKind, geometry)) { setError("Выбранный тип объекта не подходит к этой геометрии"); return; }
    const id = crypto.randomUUID(), color = colors[drawingKind] || "#ac95c4";
    const feature: MapFeature = { id, worldId, mapId: base.map.id, version: 0, name: `${GEOGRAPHY_TYPES[drawingKind]} ${features.filter((item) => item.kind === drawingKind).length + 1}`, kind: drawingKind, layerId: activeLayer.id, geometry, description: "", fill: color, stroke: color, strokeWidth: lineKinds.has(drawingKind) ? 2.5 : 1.5, label: true, eventId: null, parentId: null };
    commit((current) => ({ ...current, features: [...current.features, feature] })); setSelectedIds([id]); setTool("select");
  }
  function deleteSelected() {
    if (!editable || !selectedEditable) return;
    const ids = new Set(selectedIds);
    if (features.some((feature) => feature.parentId && ids.has(feature.parentId) && !ids.has(feature.id))) { setError("У выбранного объекта есть дочерние территории. Сначала измените их принадлежность или выделите их для удаления вместе."); return; }
    commit((current) => ({ ...current, features: current.features.filter((feature) => !ids.has(feature.id)) })); setSelectedIds([]); setTool("select");
  }
  async function merge() {
    if (!base || !editable || !selectedEditable || selected.length < 2) return;
    const first = selected[0];
    if (selected.some((feature) => !polygon(feature.geometry) || feature.kind !== first.kind || feature.layerId !== first.layerId)) { setError("Для объединения выделите территории одного типа и одного слоя"); return; }
    const removed = new Set(selected.slice(1).map((feature) => feature.id));
    if (features.some((feature) => feature.parentId && removed.has(feature.parentId) && !removed.has(feature.id))) { setError("Сначала перенесите дочерние территории объединяемых объектов к первому объекту"); return; }
    setBusy(true); setError("");
    try { const result = await historyApi<{ geometry: MapGeometry }>(`/maps/${base.map.id}/geometry/merge${scope}`, "POST", { geometries: selected.map((feature) => feature.geometry) }); setDraft((old) => old ? { past: [...old.past.slice(-49), old.present], present: { ...old.present, features: old.present.features.filter((feature) => !removed.has(feature.id)).map((feature) => feature.id === first.id ? { ...feature, geometry: result.geometry } : feature) }, future: [] } : old); setSelectedIds([first.id]); setNotice("Территории объединены в черновике. Сохраните карту, чтобы записать изменение."); }
    catch (err) { setError(err instanceof Error ? err.message : "Не удалось объединить территории"); }
    finally { setBusy(false); }
  }
  async function split(cutter: Extract<MapGeometry, { type: "LineString" }>) {
    const first = selected[0]; if (!base || !editable || !selectedEditable || selected.length !== 1 || !polygon(first.geometry)) return;
    setBusy(true); setError("");
    try { const result = await historyApi<{ geometries: MapGeometry[] }>(`/maps/${base.map.id}/geometry/split${scope}`, "POST", { geometry: first.geometry, cutter }); const pieces = result.geometries.slice(1).map((geometry, index): MapFeature => ({ ...first, id: crypto.randomUUID(), version: 0, name: `${first.name} · часть ${index + 2}`, geometry })); setDraft((old) => old ? { past: [...old.past.slice(-49), old.present], present: { ...old.present, features: [...old.present.features.map((feature) => feature.id === first.id ? { ...feature, geometry: result.geometries[0] } : feature), ...pieces] }, future: [] } : old); setTool("select"); setNotice("Территория разделена в черновике. Частям можно задать отдельные имена."); }
    catch (err) { setError(err instanceof Error ? err.message : "Не удалось разделить территорию"); }
    finally { setBusy(false); }
  }
  function saveLayer(input: MapLayerInput) {
    if (!base || !layerDialog) return;
    const id = layerDialog === "new" ? crypto.randomUUID() : layerDialog.id;
    commit((current) => ({ ...current, layers: layerDialog === "new" ? [...current.layers, { ...input, id, worldId, mapId: base.map.id, version: 0 }] : current.layers.map((layer) => layer.id === id ? { ...layer, ...input } : layer) })); setActiveLayerId(id); setLayerDialog(null);
  }
  function removeLayer(layer: MapLayer) {
    const contained = features.filter((feature) => feature.layerId === layer.id);
    if (contained.length && !window.confirm(`Удалить слой «${layer.name}» и его объекты (${contained.length}) из черновика?`)) return;
    const removed = new Set(contained.map((feature) => feature.id));
    if (features.some((feature) => feature.parentId && removed.has(feature.parentId) && !removed.has(feature.id))) { setError("На объекты слоя ссылаются территории в других слоях. Сначала измените их принадлежность."); return; }
    commit((current) => ({ layers: current.layers.filter((item) => item.id !== layer.id), features: current.features.filter((feature) => feature.layerId !== layer.id) }));
    if (activeLayerId === layer.id) setActiveLayerId(layers.find((item) => item.id !== layer.id)?.id || null); setSelectedIds((old) => old.filter((id) => !removed.has(id))); setLayerDialog(null);
  }
  const shownLayers = layers.map((layer) => hiddenLayers.includes(layer.id) ? { ...layer, visible: false } : layer);
  const listedFeatures = features.filter((feature) => `${feature.name} ${GEOGRAPHY_TYPES[feature.kind]}`.toLowerCase().includes(search.toLowerCase()));
  const sortedLayers = [...layers].sort((a, b) => b.order - a.order);
  return <section className={styles.workspace} aria-label="Атлас мира">
    <div className="page-heading entity-heading"><div><p className="eyebrow">ЗЕМЛИ, У КОТОРЫХ ЕСТЬ ИСТОРИЯ</p><h1>Атлас мира<span className="heading-dot" aria-hidden="true">.</span></h1><p className="subtitle">Рисуйте материки, соединяйте города и меняйте границы вместе с историей.</p></div>{canEdit && <button className="button primary" disabled={busy} onClick={() => { if (confirmLeave()) setMapDialog("new"); }}><Plus size={16} />Новая карта</button>}</div>
    {error && <div className={styles.error} role="alert"><span>{error}</span>{conflict && <button className="button secondary" onClick={() => void reload()} disabled={busy}>Перечитать карту</button>}</div>}
    {notice && <p className={styles.success} role="status"><Check size={15} />{notice}</p>}
    {loading ? <div className={styles.empty}><LoaderCircle className="spin" size={28} /><p>Открываем атлас…</p></div> : !base || !draft ? <div className={styles.empty}><MapIcon size={37} strokeWidth={1.2} /><h2>{maps.length ? "Карта недоступна" : "Мир начинается с чистого листа"}</h2><p>Создайте пустую карту и дайте имена её землям. Карты относятся к выбранной временной линии.</p>{canEdit && <button className="button primary" onClick={() => setMapDialog("new")}><Plus size={16} />Создать первую карту</button>}<button className="text-button" onClick={() => void reload(true)}>Обновить список карт</button></div> : <>
      <div className={styles.mapBar}><label className="field"><span>Карта мира</span><select aria-label="Карта мира" value={base.map.id} disabled={busy} onChange={(event) => void chooseMap(event.target.value)}>{maps.map((map) => <option key={map.id} value={map.id}>{map.name}</option>)}</select></label><div className={styles.mapCaption}><span><GitBranch size={12} />{context.timeline.name}</span><small>{historicalDate(context.day, calendar)} · {base.map.width} × {base.map.height}</small></div><div className={styles.mapActions}><button className="icon-button" aria-label="Обновить карту" title="Перечитать сохранённую карту" onClick={() => void reload()} disabled={busy}><RefreshCw size={16} /></button>{canEdit && <><button className="icon-button" aria-label="Настройки карты" title="Настройки карты" disabled={busy || dirty} onClick={() => setMapDialog("edit")}><Settings2 size={16} /></button><button className="icon-button danger" aria-label="Удалить карту" title="Удалить карту" disabled={busy} onClick={() => void removeMap()}><Trash2 size={16} /></button></>}</div></div>
      <div className={styles.modeBar}><div className={styles.modeSwitch} role="group" aria-label="Представление карты"><button aria-pressed={view === "physical"} onClick={() => setView("physical")}><Waves size={15} />Физическая карта</button><button aria-pressed={view === "political"} onClick={() => setView("political")}><Shield size={15} />Политическая карта</button></div><p>{view === "physical" ? "Рельеф, воды и поселения" : "Общая география и политические границы"}</p><span className={dirty ? styles.unsaved : styles.saved}>{dirty ? "Есть несохранённые изменения" : "Карта сохранена"}</span></div>
      <div className={styles.editorGrid}>
        <aside className={styles.leftPanel} aria-label="Слои и объекты карты"><div className={styles.panelHeading}><h2><Layers3 size={15} />Слои</h2>{canEdit && <button className="icon-button" aria-label="Добавить слой" disabled={!editable} onClick={() => setLayerDialog("new")}><Plus size={15} /></button>}</div><div className={styles.layers}>{sortedLayers.map((layer) => <div className={`${styles.layer} ${activeLayerId === layer.id ? styles.activeLayer : ""}`} key={layer.id}><label className={styles.layerVisible}><input type="checkbox" aria-label={`Показать слой ${layer.name}`} checked={layer.visible && !hiddenLayers.includes(layer.id)} disabled={busy} onChange={(event) => { if (editable) commit((current) => ({ ...current, layers: current.layers.map((item) => item.id === layer.id ? { ...item, visible: event.target.checked } : item) })); else setHiddenLayers((old) => event.target.checked ? old.filter((id) => id !== layer.id) : [...old, layer.id]); }} /><Eye size={14} /></label><button className={styles.layerName} aria-label={`Работать со слоем ${layer.name}`} onClick={() => { setActiveLayerId(layer.id); if (layer.kind === "political") setView("political"); }}><strong>{layer.name}</strong><small>{layerLabels[layer.kind]} · {features.filter((feature) => feature.layerId === layer.id).length}</small></button>{canEdit ? <button className="icon-button" aria-label={`Настройки слоя ${layer.name}`} disabled={!editable} onClick={() => setLayerDialog(layer)}>{layer.locked ? <Lock size={13} /> : <Settings2 size={13} />}</button> : layer.locked && <Lock size={13} />}</div>)}</div>
          <div className={styles.panelHeading}><h2>Объекты <span>{features.length}</span></h2><input className={styles.search} aria-label="Поиск объектов карты" placeholder="Найти на карте…" value={search} onChange={(event) => setSearch(event.target.value)} /></div><div className={styles.featureList}>{listedFeatures.length ? listedFeatures.map((feature) => <div className={`${styles.featureRow} ${selectedIds.includes(feature.id) ? styles.selectedFeature : ""}`} key={feature.id}><input type="checkbox" aria-label={`Выделить объект ${feature.name}`} checked={selectedIds.includes(feature.id)} onChange={(event) => setSelectedIds((old) => event.target.checked ? [...old, feature.id] : old.filter((id) => id !== feature.id))} /><button aria-label={`Выбрать объект ${feature.name}`} onClick={() => { setSelectedIds([feature.id]); setTool("select"); if (politicalKinds.has(feature.kind)) setView("political"); }}><span className={styles.featureDot} style={{ backgroundColor: feature.fill }} /><span><strong>{feature.name}</strong><small>{GEOGRAPHY_TYPES[feature.kind]}</small></span></button></div>) : <p className={styles.panelEmpty}>{search ? "Ничего не найдено" : "Пока здесь чистая география. Выберите тип и нарисуйте первый объект."}</p>}</div>
        </aside>
        <div className={styles.mapCenter}><div className={styles.drawBar}><label><span>Тип объекта</span><select aria-label="Тип объекта карты" value={drawingKind} disabled={!editable} onChange={(event) => { const kind = event.target.value as GeographyKind; setDrawingKind(kind); setTool("select"); const wanted = layers.find((layer) => layer.kind === (politicalKinds.has(kind) ? "political" : "physical") && !layer.locked && layer.visible); if (wanted) setActiveLayerId(wanted.id); if (politicalKinds.has(kind)) setView("political"); }}>{Object.entries(GEOGRAPHY_TYPES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label><span>Рабочий слой</span><select aria-label="Рабочий слой" value={activeLayerId || ""} disabled={!editable} onChange={(event) => { setActiveLayerId(event.target.value); if (layers.find((layer) => layer.id === event.target.value)?.kind === "political") setView("political"); }}><option value="" disabled>Добавьте слой</option>{[...layers].sort((a, b) => a.order - b.order).map((layer) => <option value={layer.id} key={layer.id}>{layer.name}{layer.locked ? " · заблокирован" : ""}</option>)}</select></label><button className="button secondary" aria-pressed={tool === drawingTool(drawingKind)} disabled={!editable || !activeLayer || activeLayer.locked || !activeLayer.visible || activeLayer.opacity <= 0} onClick={() => { if (activeLayer?.kind === "political") setView("political"); setTool(drawingTool(drawingKind)); }}><Plus size={15} />Нарисовать объект</button></div>
          <div className={styles.tools} role="toolbar" aria-label="Инструменты карты"><Tool icon={MousePointer2} label="Выделить объекты" value="select" current={tool} onChange={setTool} /><Tool icon={Move} label="Переместить карту" value="pan" current={tool} onChange={setTool} /><span /><Tool icon={Pencil} label="Редактировать узлы" value="modify" current={tool} onChange={setTool} disabled={!editable || !selectedEditable} /><Tool icon={Move} label="Переместить объекты" value="move" current={tool} onChange={setTool} disabled={!editable || !selectedEditable} /><button aria-label="Объединить территории" title="Объединить выделенные территории" disabled={!editable || !selectedEditable || selected.length < 2 || selected.some((feature) => !polygon(feature.geometry))} onClick={() => void merge()}><Merge size={16} /></button><Tool icon={Scissors} label="Разделить территорию" value="split" current={tool} onChange={setTool} disabled={!editable || !selectedEditable || selected.length !== 1 || !polygon(selected[0]?.geometry || { type: "Point", coordinates: [0, 0] })} /><button aria-label="Удалить выбранные объекты" title="Удалить выбранные объекты" disabled={!editable || !selectedEditable} onClick={deleteSelected}><Trash2 size={16} /></button><span /><button aria-label="Отменить действие" title="Отменить действие" disabled={!editable || !draft.past.length} onClick={() => { setDraft((old) => old?.past.length ? { past: old.past.slice(0, -1), present: old.past.at(-1)!, future: [old.present, ...old.future] } : old); setSelectedIds([]); setTool("select"); setNotice(""); }}><Undo2 size={16} /></button><button aria-label="Повторить действие" title="Повторить действие" disabled={!editable || !draft.future.length} onClick={() => { setDraft((old) => old?.future.length ? { past: [...old.past, old.present], present: old.future[0], future: old.future.slice(1) } : old); setSelectedIds([]); setTool("select"); setNotice(""); }}><Redo2 size={16} /></button><div className={styles.toolSpacer} />{canEdit && <button className={styles.saveButton} disabled={!editable || !dirty} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}Сохранить карту</button>}</div>
          <MapCanvas map={base.map} features={features} layers={shownLayers} selectedIds={selectedIds} tool={tool} activeLayerId={activeLayerId} canEdit={editable} view={view} onSelect={setSelectedIds} onCreateGeometry={createGeometry} onGeometriesChanged={(changes) => { const changed = new Map(changes.map((change) => [change.id, change.geometry])); commit((current) => ({ ...current, features: current.features.map((feature) => changed.has(feature.id) && !layers.find((layer) => layer.id === feature.layerId)?.locked ? { ...feature, geometry: changed.get(feature.id)! } : feature) })); }} onSplitGeometry={(cutter) => void split(cutter)} />
          <div className={styles.mapFootnote}><span><CircleDot size={12} />{features.length} объектов · {layers.length} слоёв</span><span>{selected.length ? `Выделено: ${selected.length}` : "Выберите объект на карте или в списке"}</span></div>
        </div>
        <aside className={styles.inspector} aria-label="Свойства объекта карты">{selected.length === 1 ? <FeatureInspector key={`${selected[0].id}:${selected[0].version}:${JSON.stringify(featureInput(selected[0]))}`} feature={selected[0]} layers={layers} features={features} events={events} canEdit={editable && selectedEditable} onSave={(input) => { if (!geometryFits(input.kind, selected[0].geometry)) { setError("Этот тип объекта требует другой формы. Сначала нарисуйте подходящую точку, линию или территорию."); return; } commit((current) => ({ ...current, features: current.features.map((feature) => feature.id === selected[0].id ? { ...feature, ...input } : feature) })); }} onHistory={() => setHistoryFeature(selected[0])} /> : <div className={styles.inspectorEmpty}><MapIcon size={31} strokeWidth={1.1} /><h2>{selected.length ? `Выделено объектов: ${selected.length}` : "У каждого места — своя история"}</h2><p>{selected.length ? "Территории одного типа можно объединить. Удаление и перемещение применяются ко всему выделению." : "Выберите объект, чтобы изменить имя, оформление, принадлежность и связанное событие."}</p></div>}</aside>
      </div>
      <p className={styles.draftNote}><Shield size={14} />{canEdit ? "Рисование и свойства сначала попадают в черновик. Отмена и повтор работают до сохранения; сохранённые состояния остаются в истории выбранной линии." : "У вас доступ для чтения. Можно исследовать карту, переключать представления и смотреть историю объектов."}</p>
    </>}
    {mapDialog && <MapSettingsDialog value={mapDialog === "edit" ? base?.map : undefined} onClose={() => setMapDialog(null)} onSave={mapSaved} />}
    {layerDialog && <LayerDialog value={layerDialog === "new" ? undefined : layerDialog} nextOrder={Math.min(10000, Math.max(0, ...layers.map((layer) => layer.order)) + 10)} onClose={() => setLayerDialog(null)} onSave={saveLayer} onDelete={layerDialog !== "new" ? () => removeLayer(layerDialog) : undefined} />}
    {historyFeature && <FeatureHistory feature={historyFeature} scope={scope} calendar={calendar} events={events} onClose={() => setHistoryFeature(null)} />}
  </section>;
}

function Tool({ icon: Icon, label, value, current, onChange, disabled }: { icon: typeof MousePointer2; label: string; value: MapTool; current: MapTool; onChange: (value: MapTool) => void; disabled?: boolean }) { return <button aria-label={label} title={label} aria-pressed={value === current} disabled={disabled} onClick={() => onChange(value)}><Icon size={16} /></button>; }

function MapSettingsDialog({ value, onClose, onSave }: { value?: AtlasMap; onClose: () => void; onSave: (input: MapInput) => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true); setError(""); try { await onSave({ name: String(form.get("name")), description: String(form.get("description") || ""), width: value?.width || Number(form.get("width")), height: value?.height || Number(form.get("height")), background: String(form.get("background")) }); } catch (err) { setError(err instanceof Error ? err.message : "Не удалось сохранить карту"); } finally { setBusy(false); } }
  return <HistoryDialog title={value ? "Настройки карты" : "Новая карта"} onClose={onClose} busy={busy}><form onSubmit={save}><div className="editor-content"><div className={styles.dialogIntro}><MapIcon size={27} /><p>{value ? "Имя и оформление сохраняются с выбранной исторической даты." : "Пустая карта вашей вселенной. Материки, воды и государства появятся там, где вы их нарисуете."}</p></div><label className="field"><span>Название карты</span><input aria-label="Название карты" name="name" required maxLength={160} defaultValue={value?.name} autoFocus placeholder="Земли двух лун" /></label><label className="field"><span>Описание карты</span><textarea name="description" aria-label="Описание карты" rows={3} maxLength={10000} defaultValue={value?.description} /></label>{value ? <p className="field-hint">Размер: {value.width} × {value.height}. Границы листа сохраняются, чтобы координаты объектов оставались точными.</p> : <div className="form-columns"><label className="field"><span>Ширина карты</span><input aria-label="Ширина карты" name="width" type="number" min={100} max={100000} step={1} defaultValue={1000} required /></label><label className="field"><span>Высота карты</span><input aria-label="Высота карты" name="height" type="number" min={100} max={100000} step={1} defaultValue={700} required /></label></div>}<label className={styles.colorField}><span>Цвет фона</span><input aria-label="Цвет фона карты" name="background" type="color" defaultValue={value?.background || "#213c4c"} /></label>{error && <p className="form-error" role="alert">{error}</p>}</div><div className="editor-footer"><span /><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Отмена</button><button className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{value ? "Сохранить настройки карты" : "Создать карту"}</button></div></form></HistoryDialog>;
}

function LayerDialog({ value, nextOrder, onClose, onSave, onDelete }: { value?: MapLayer; nextOrder: number; onClose: () => void; onSave: (input: MapLayerInput) => void; onDelete?: () => void }) {
  function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); onSave({ name: String(form.get("name")), kind: String(form.get("kind")) as MapLayerInput["kind"], visible: form.get("visible") === "on", locked: form.get("locked") === "on", opacity: Number(form.get("opacity")), order: Number(form.get("order")) }); }
  return <HistoryDialog title={value ? "Настройки слоя" : "Новый слой"} onClose={onClose}><form onSubmit={save}><div className="editor-content"><label className="field"><span>Название слоя</span><input name="name" aria-label="Название слоя" defaultValue={value?.name} required maxLength={160} autoFocus /></label><label className="field"><span>Вид слоя</span><select name="kind" aria-label="Вид слоя" defaultValue={value?.kind || "custom"}>{Object.entries(layerLabels).map(([kind, label]) => <option value={kind} key={kind}>{label}</option>)}</select></label><p className="field-hint">Физические и пользовательские слои образуют общую основу. Политические слои показываются в политическом представлении.</p><div className="form-columns"><label className="field"><span>Непрозрачность</span><input aria-label="Непрозрачность слоя" name="opacity" type="number" step={0.05} min={0} max={1} defaultValue={value?.opacity ?? 1} required /></label><label className="field"><span>Порядок наложения</span><input aria-label="Порядок слоя" name="order" type="number" step={1} min={0} max={10000} defaultValue={value?.order ?? nextOrder} required /></label></div><label className="checkbox-field"><input name="visible" type="checkbox" defaultChecked={value?.visible ?? true} /><span>Показывать слой</span></label><label className="checkbox-field"><input name="locked" type="checkbox" defaultChecked={value?.locked ?? false} /><span>Заблокировать редактирование объектов</span></label><p className="field-hint">Изменения слоя войдут в черновик карты. Для записи нажмите «Сохранить карту».</p></div><div className="editor-footer">{onDelete && <button type="button" className="button danger-quiet" onClick={onDelete}><Trash2 size={15} />Удалить слой</button>}<span /><button type="button" className="button secondary" onClick={onClose}>Отмена</button><button className="button primary"><Check size={15} />{value ? "Применить слой" : "Добавить слой"}</button></div></form></HistoryDialog>;
}

function FeatureInspector({ feature, layers, features, events, canEdit, onSave, onHistory }: { feature: MapFeature; layers: MapLayer[]; features: MapFeature[]; events: LoreEvent[]; canEdit: boolean; onSave: (input: MapFeatureInput) => void; onHistory: () => void }) {
  function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); onSave({ ...featureInput(feature), name: String(form.get("name")), kind: String(form.get("kind")) as GeographyKind, layerId: String(form.get("layerId")), description: String(form.get("description") || ""), fill: String(form.get("fill")), stroke: String(form.get("stroke")), strokeWidth: Number(form.get("strokeWidth")), label: form.get("label") === "on", eventId: String(form.get("eventId") || "") || null, parentId: String(form.get("parentId") || "") || null }); }
  return <><div className={styles.panelHeading}><h2>Свойства объекта</h2><span className={styles.geometryBadge}>{feature.geometry.type === "Point" ? "Точка" : feature.geometry.type === "LineString" ? "Линия" : "Территория"}</span></div><form className={styles.properties} onSubmit={save}><fieldset disabled={!canEdit}><label className="field"><span>Название</span><input aria-label="Название объекта" name="name" defaultValue={feature.name} required maxLength={160} /></label><label className="field"><span>Тип объекта</span><select aria-label="Тип выбранного объекта" name="kind" defaultValue={feature.kind}>{Object.entries(GEOGRAPHY_TYPES).filter(([kind]) => geometryFits(kind as GeographyKind, feature.geometry)).map(([kind, label]) => <option value={kind} key={kind}>{label}</option>)}</select></label><label className="field"><span>Слой</span><select name="layerId" aria-label="Слой выбранного объекта" defaultValue={feature.layerId}>{layers.map((layer) => <option value={layer.id} key={layer.id} disabled={layer.locked && layer.id !== feature.layerId}>{layer.name}</option>)}</select></label><label className="field"><span>Описание</span><textarea aria-label="Описание объекта карты" name="description" defaultValue={feature.description} maxLength={40000} rows={3} /></label><div className={styles.colorColumns}><label className={styles.colorField}><span>Заливка</span><input aria-label="Заливка объекта" name="fill" type="color" defaultValue={feature.fill} /></label><label className={styles.colorField}><span>Контур</span><input aria-label="Контур объекта" name="stroke" type="color" defaultValue={feature.stroke} /></label></div><label className="field"><span>Толщина контура</span><input aria-label="Толщина контура" name="strokeWidth" type="number" step={0.5} min={0.5} max={10} defaultValue={feature.strokeWidth} required /></label><label className="checkbox-field"><input name="label" type="checkbox" defaultChecked={feature.label} /><span>Показывать подпись</span></label><label className="field"><span>Принадлежность территории</span><select aria-label="Принадлежность территории" name="parentId" defaultValue={feature.parentId || ""}><option value="">Без родительской территории</option>{features.filter((candidate) => candidate.id !== feature.id && (candidate.kind === "state" || candidate.kind === "province")).map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name}</option>)}</select></label><label className="field"><span>Связанное событие</span><select aria-label="Связанное событие" name="eventId" defaultValue={feature.eventId || ""}><option value="">Без события</option>{feature.eventId && !events.some((event) => event.id === feature.eventId) && <option value={feature.eventId}>Событие из прежней истории</option>}{events.map((event) => <option value={event.id} key={event.id}>{event.name}</option>)}</select></label><button className="button secondary" disabled={!canEdit}><Check size={14} />Применить свойства</button></fieldset></form>{!canEdit && <p className={styles.readOnly}>Свойства доступны для чтения. Для правки нужен доступ редактора и незаблокированный слой.</p>}<button className={`text-button ${styles.historyButton}`} disabled={feature.version === 0} onClick={onHistory}><History size={14} />История объекта</button></>;
}

function FeatureHistory({ feature, scope, calendar, events, onClose }: { feature: MapFeature; scope: string; calendar: CalendarDefinition; events: LoreEvent[]; onClose: () => void }) {
  const [data, setData] = useState<MapFeatureHistory | null>(null), [error, setError] = useState("");
  useEffect(() => { let cancelled = false; historyApi<MapFeatureHistory>(`/map-features/${feature.id}/history${scope}`).then((result) => { if (!cancelled) setData(result); }).catch((err: Error) => { if (!cancelled) setError(err.message); }); return () => { cancelled = true; }; }, [feature.id, scope]);
  return <HistoryDialog title="История объекта карты" onClose={onClose}><div className="editor-content"><h3>{feature.name}</h3><p className="field-hint">Геометрия и свойства сохраняются как исторические состояния. Для просмотра карты на нужный момент выберите дату в верхней панели.</p>{error ? <p role="alert" className="form-error">{error}</p> : !data ? <LoaderCircle className="spin" size={22} /> : <ol className={styles.historyList}>{data.revisions.map((revision) => <li key={revision.revision}><div><strong>{historicalDate(revision.effectiveDay, calendar)}</strong><span className="pill subtle">{revision.deleted ? "Удаление" : `Состояние ${revision.version}`}</span></div>{revision.data && <><p>{String(revision.data.name || feature.name)}</p>{revision.data.eventId && <small>Событие: {events.find((event) => event.id === revision.data!.eventId)?.name || "Событие из прежней истории"}</small>}</>}</li>)}</ol>}</div><div className="editor-footer"><span /><button className="button secondary" onClick={onClose}>Закрыть</button></div></HistoryDialog>;
}
