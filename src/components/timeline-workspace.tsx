"use client";

import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  Background, BackgroundVariant, ConnectionLineType, Handle, MarkerType,
  MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Connection, type Edge, type Node, type NodeChange, type NodeProps,
} from "@xyflow/react";
import { Check, GitBranch, GitCompareArrows, Layers3, Link2, LoaderCircle, Maximize, Minus, Pencil, Plus, RotateCcw, Save, Shield, Trash2 } from "lucide-react";
import "@xyflow/react/dist/style.css";
import type { CalendarDefinition } from "@/lib/calendar";
import type { HistoryContext, Timeline } from "@/lib/history-types";
import type { TimelineConnection, TimelineGraph } from "@/lib/workspace-types";
import { historicalDate } from "./history-controls";
import { HistoryDialog, TimelineDialog } from "./history-dialogs";
import { historyApi } from "./history-api";
import styles from "./timeline-workspace.module.css";

type WorkspaceProps = {
  worldId: string;
  context: HistoryContext;
  calendar: CalendarDefinition;
  onSelect: (id: string) => Promise<void>;
  onTimelineChanged: () => Promise<void>;
  canEdit?: boolean;
};
type LineNodeData = {
  line: Timeline;
  dateLabel: string;
  current: boolean;
  canEdit: boolean;
  onFork: (line: Timeline) => void;
};
type LineNode = Node<LineNodeData, "timeline">;
type ConnectionDraft = TimelineConnection & { editing: boolean };
const kindLabels = { intersection: "Пересечение", influence: "Влияние", travel: "Переход" };
const kindColors = { intersection: "#b69ae6", influence: "#d3b27d", travel: "#7dbdb4" };
const subscribeViewport = (callback: () => void) => {
  window.addEventListener("resize", callback);
  return () => window.removeEventListener("resize", callback);
};
const compactViewport = () => window.innerWidth < 680;
const serverCompactViewport = () => false;

function TimelineNode({ id, data }: NodeProps<LineNode>) {
  return <div data-testid={`timeline-node-${id}`} className={`${styles.node} ${data.current ? styles.currentNode : ""}`}>
    <Handle id="story-target" type="target" position={Position.Left} isConnectable={data.canEdit} data-testid={`timeline-target-${id}`} aria-label={`Вход линии ${data.line.name}`} className={styles.handle} />
    <div className={styles.nodeEyebrow}><GitBranch size={13} /><span>{data.line.isMain ? "ОСНОВНАЯ ИСТОРИЯ" : data.line.parentId ? "ОТВЕТВЛЕНИЕ" : "НЕЗАВИСИМАЯ ЛИНИЯ"}</span>{data.line.isCanon && <span title="Каноническая линия" className={styles.canonDot} />}</div>
    <strong>{data.line.name}</strong>
    <p>{data.dateLabel}</p>
    <div className={styles.nodeFooter}><span>{data.current ? "Открыта сейчас" : data.line.isCanon ? "Каноническая" : "Альтернативная"}</span>{data.canEdit && <button type="button" className={`nodrag nopan ${styles.forkButton}`} title={`Создать ответвление от ${data.line.name}`} aria-label={`Ответвление от ${data.line.name}`} onClick={(event) => { event.stopPropagation(); data.onFork(data.line); }}><Plus size={13} /></button>}</div>
    <Handle id="story-source" type="source" position={Position.Right} isConnectable={data.canEdit} data-testid={`timeline-source-${id}`} aria-label={`Выход линии ${data.line.name}`} className={styles.handle} />
  </div>;
}
const nodeTypes = { timeline: TimelineNode };

function fallbackPositions(lines: Timeline[]): Record<string, { x: number; y: number }> {
  const known = new Set(lines.map((line) => line.id));
  const children = new Map(lines.map((line) => [line.id, [] as string[]]));
  const queue = lines.filter((line) => !line.parentId || !known.has(line.parentId)).map((line) => line.id);
  const depth = new Map(queue.map((id) => [id, 0]));
  for (const line of lines) if (line.parentId) children.get(line.parentId)?.push(line.id);
  for (let index = 0; index < queue.length; index++) for (const child of children.get(queue[index]) || []) {
    if (depth.has(child)) continue;
    depth.set(child, (depth.get(queue[index]) || 0) + 1); queue.push(child);
  }
  const rows = new Map<number, number>();
  return Object.fromEntries(lines.map((line) => {
    const level = depth.get(line.id) || 0, row = rows.get(level) || 0;
    rows.set(level, row + 1);
    return [line.id, { x: level * 330 + 40, y: row * 200 + 50 }];
  }));
}

export function TimelineWorkspace(props: WorkspaceProps) {
  return <ReactFlowProvider key={props.worldId}><TimelineCanvas {...props} /></ReactFlowProvider>;
}

function TimelineCanvas({ worldId, context, calendar, onSelect, onTimelineChanged, canEdit = true }: WorkspaceProps) {
  const flow = useReactFlow<LineNode>();
  const [graph, setGraph] = useState<TimelineGraph | null>(null);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [forkParent, setForkParent] = useState<Timeline | null>(null);
  const [creatingLine, setCreatingLine] = useState(false);
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [measurements, setMeasurements] = useState<Record<string, NonNullable<LineNode["measured"]>>>({});
  const defaults = useMemo(() => fallbackPositions(context.timelines), [context.timelines]);
  const compact = useSyncExternalStore(subscribeViewport, compactViewport, serverCompactViewport);
  const graphReady = graph !== null;

  useEffect(() => {
    let cancelled = false;
    historyApi<TimelineGraph>(`/worlds/${worldId}/timeline-graph`).then((result) => {
      if (!cancelled) { setGraph(result); setDirty(false); }
    }).catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [worldId]);
  useEffect(() => {
    if (!compact || !graphReady) return;
    // A saved desktop viewport must still make the whole graph reachable on a
    // narrow screen. Automatic fitting does not mark the shared layout dirty.
    const frame = requestAnimationFrame(() => void flow.fitView({ padding: 0.22, maxZoom: 1.1 }));
    return () => cancelAnimationFrame(frame);
  }, [compact, graphReady, flow]);

  const nodes: LineNode[] = context.timelines.map((line) => ({
    id: line.id, type: "timeline", position: graph?.positions[line.id] || defaults[line.id],
    measured: measurements[line.id],
    sourcePosition: Position.Right, targetPosition: Position.Left,
    draggable: canEdit && !busy, connectable: canEdit && !busy, deletable: false,
    selected: line.id === context.timeline.id,
    ariaLabel: `Временная линия ${line.name}`,
    data: {
      line, dateLabel: line.parentId ? historicalDate(line.forkDay, calendar) : "Начало самостоятельной истории",
      current: line.id === context.timeline.id, canEdit: canEdit && !busy,
      onFork: (parent) => { setForkParent(parent); setCreatingLine(true); },
    },
  }));
  const edges: Edge[] = [
    ...context.timelines.filter((line) => line.parentId).map((line) => ({
      id: `ancestry:${line.id}`, source: line.parentId!, target: line.id,
      sourceHandle: "story-source", targetHandle: "story-target",
      type: "smoothstep", label: "Ответвление", deletable: false, selectable: false,
      style: { stroke: "#737080", strokeWidth: 1.5, strokeDasharray: "5 5" },
      labelStyle: { fill: "#93909f", fontSize: 10 }, labelBgStyle: { fill: "var(--surface)" },
    })),
    ...(graph?.connections || []).map((edge) => ({
      id: `story:${edge.id}`, source: edge.sourceId, target: edge.targetId,
      sourceHandle: "story-source", targetHandle: "story-target",
      type: "default", label: edge.label || kindLabels[edge.kind], deletable: false,
      markerEnd: { type: MarkerType.ArrowClosed, color: kindColors[edge.kind], width: 16, height: 16 },
      style: { stroke: kindColors[edge.kind], strokeWidth: 2 },
      labelStyle: { fill: kindColors[edge.kind], fontSize: 11 },
      labelBgStyle: { fill: "var(--surface)" },
      ariaLabel: `Переплетение ${edge.label || kindLabels[edge.kind]}`,
    })),
  ];

  function changeNodes(changes: NodeChange<LineNode>[]) {
    // React Flow re-adopts controlled nodes after a history/context refresh.
    // Keep measured dimensions so that refresh cannot hide a newly added node
    // after its ResizeObserver has already measured an unchanged element.
    const dimensions = changes.filter((change) => change.type === "dimensions" && change.dimensions);
    if (dimensions.length) setMeasurements((old) => {
      let next = old;
      for (const change of dimensions) {
        if (change.type !== "dimensions" || !change.dimensions) continue;
        const previous = next[change.id];
        if (previous?.width === change.dimensions.width && previous?.height === change.dimensions.height) continue;
        if (next === old) next = { ...old };
        next[change.id] = change.dimensions;
      }
      return next;
    });
    if (!canEdit || busy) return;
    const moves = changes.filter((change) => change.type === "position" && change.position);
    if (!moves.length) return;
    setGraph((old) => {
      if (!old) return old;
      const positions = { ...old.positions };
      for (const change of moves) if (change.type === "position" && change.position) positions[change.id] = change.position;
      return { ...old, positions };
    });
    setDirty(true); setNotice("");
  }
  function connect(connection: Connection) {
    if (!canEdit || busy || !connection.source || !connection.target) return;
    if (connection.source === connection.target) { setError("Выберите две разные временные линии"); return; }
    setDraft({ id: crypto.randomUUID(), sourceId: connection.source, targetId: connection.target, kind: "intersection", label: "", editing: false });
    setError("");
  }
  function addConnection() {
    const sourceId = context.timeline.id;
    const targetId = context.timelines.find((line) => line.id !== sourceId)?.id;
    if (targetId) setDraft({ id: crypto.randomUUID(), sourceId, targetId, kind: "intersection", label: "", editing: false });
  }
  async function save() {
    if (!graph || !canEdit) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const positions = Object.fromEntries(context.timelines.map((line) => [line.id, graph.positions[line.id] || defaults[line.id]]));
      const value = await historyApi<TimelineGraph>(`/worlds/${worldId}/timeline-graph`, "PUT", { ...graph, positions });
      setGraph(value); setDirty(false); setNotice("Схема сохранена");
    } catch (err) { setError(err instanceof Error ? err.message : "Не удалось сохранить схему"); }
    finally { setBusy(false); }
  }
  async function reload() {
    if (dirty && !window.confirm("Перечитать сохранённую схему? Ваши несохранённые перемещения и связи будут заменены.")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await historyApi<TimelineGraph>(`/worlds/${worldId}/timeline-graph`);
      setGraph(result); setDirty(false); await flow.setViewport(result.viewport);
    } catch (err) { setError(err instanceof Error ? err.message : "Не удалось перечитать схему"); }
    finally { setBusy(false); }
  }
  async function selectLine(id: string) {
    setError("");
    try { await onSelect(id); } catch (err) { setError(err instanceof Error ? err.message : "Не удалось открыть линию"); }
  }
  async function fit() {
    await flow.fitView({ padding: 0.22, maxZoom: 1.1, duration: 250 });
    setGraph((old) => old ? { ...old, viewport: flow.getViewport() } : old);
    if (canEdit) setDirty(true);
  }

  return <section className={styles.workspace} aria-label="Редактор временных линий">
    <div className="page-heading entity-heading"><div><p className="eyebrow">ИСТОРИИ, КОТОРЫЕ ПЕРЕПЛЕТАЮТСЯ</p><h1>Редактор временных линий</h1><p className="subtitle">Размещайте ветви на полотне и связывайте разные пути вашей вселенной.</p></div><div className={styles.headingActions}><span className="pill subtle"><Layers3 size={13} />{context.timelines.length} линий</span>{canEdit && <button className="button primary" disabled={busy} onClick={() => { setForkParent(null); setCreatingLine(true); }}><Plus size={16} />Добавить линию</button>}</div></div>
    <div className={styles.toolbar}><div className={styles.legend}><span><i className={styles.structuralKey} />Ответвление</span><span><i />Переплетение</span></div><span className={styles.savedState}>{dirty ? "Есть несохранённые изменения" : "Схема сохранена"}</span><button className="button secondary" onClick={() => void reload()} disabled={busy}><RotateCcw size={14} />Перечитать схему</button>{canEdit && <><button className="button secondary" disabled={busy || context.timelines.length < 2 || !graph} onClick={addConnection}><Link2 size={14} />Добавить переплетение</button><button className="button primary" disabled={busy || !graph || !dirty} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}Сохранить схему</button></>}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className={styles.success} role="status"><Check size={15} />{notice}</p>}
    {!graph ? <div className={styles.loading}><LoaderCircle size={25} className="spin" /><p>{error ? "Схема недоступна. Попробуйте перечитать её." : "Открываем пространство историй…"}</p></div> : <div className={`${styles.canvas} ${busy ? styles.canvasBusy : ""}`} data-testid="timeline-canvas">
      <ReactFlow<LineNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={changeNodes}
        onNodeClick={(_, node) => void selectLine(node.id)} onConnect={connect}
        onEdgeClick={(_, edge) => { if (canEdit && !busy && edge.id.startsWith("story:")) { const item = graph.connections.find((value) => value.id === edge.id.slice(6)); if (item) setDraft({ ...item, editing: true }); } }}
        onMoveEnd={(event, viewport) => { setGraph((old) => old ? { ...old, viewport } : old); if (event && canEdit && !busy) { setDirty(true); setNotice(""); } }}
        defaultViewport={graph.viewport} fitView={compact || Object.keys(graph.positions).length === 0} fitViewOptions={{ padding: 0.22, maxZoom: 1.1 }}
        minZoom={0.1} maxZoom={3} deleteKeyCode={null} connectionLineType={ConnectionLineType.Bezier}
        nodesConnectable={canEdit && !busy} nodesDraggable={canEdit && !busy} panOnDrag={!busy} zoomOnScroll={!busy}
        aria-label="Полотно временных линий" colorMode="dark"
        ariaLabelConfig={{ "node.a11yDescription.default": "Нажмите для открытия линии. Перемещайте узел мышью или клавишами со стрелками.", "edge.a11yDescription.default": "Выберите переплетение для изменения.", "minimap.ariaLabel": "Обзор схемы", "handle.ariaLabel": "Соединение временных линий" }}>
        <Background variant={BackgroundVariant.Dots} color="var(--border)" gap={22} size={1} />
        <MiniMap<LineNode> ariaLabel="Обзор схемы" pannable zoomable bgColor="var(--surface)" maskColor="rgba(17,17,22,.35)" nodeColor={(node) => node.data.line.isCanon ? "#9b7fc5" : "#626576"} nodeStrokeColor="transparent" className={styles.minimap} />
      </ReactFlow>
      <div className={styles.canvasControls}><button aria-label="Увеличить схему" title="Увеличить" onClick={() => void flow.zoomIn()}><Plus size={17} /></button><button aria-label="Уменьшить схему" title="Уменьшить" onClick={() => void flow.zoomOut()}><Minus size={17} /></button><button aria-label="Уместить схему" title="Уместить схему" onClick={() => void fit()}><Maximize size={16} /></button></div>
      <div className={styles.canvasHint}><GitCompareArrows size={15} /><span>{compact ? "Перемещайте фон и меняйте масштаб кнопками. Связь можно добавить над полотном." : "Потяните от точки справа к точке другой линии, чтобы создать переплетение."}</span></div>
    </div>}
    <div className={styles.explanation}><Shield size={16} /><p>Ответвления сохраняют свою историю. Переплетения обозначают пересечение, влияние или переход между историями. Для переноса персонажей и событий используйте «Сравнить временные линии».</p></div>
    <div className={styles.connectionsPanel}><div className={styles.connectionsHeading}><h2>Переплетения историй</h2><span>{graph?.connections.length || 0}</span></div>{graph?.connections.length ? <div className={styles.connectionsList}>{graph.connections.map((edge) => <div className={styles.connectionRow} key={edge.id}><span className={styles.connectionIcon} style={{ color: kindColors[edge.kind] }}><Link2 size={16} /></span><div><strong>{edge.label || kindLabels[edge.kind]}</strong><p>{context.timelines.find((line) => line.id === edge.sourceId)?.name} <span>→</span> {context.timelines.find((line) => line.id === edge.targetId)?.name}</p></div><span className="pill subtle">{kindLabels[edge.kind]}</span>{canEdit && <button className="icon-button" disabled={busy} aria-label={`Изменить переплетение ${edge.label || kindLabels[edge.kind]}`} onClick={() => setDraft({ ...edge, editing: true })}><Pencil size={15} /></button>}</div>)}</div> : <p className={styles.emptyConnections}>Создайте связь между двумя линиями, чтобы отметить общую точку их историй.</p>}</div>
    {creatingLine && <TimelineDialog worldId={worldId} context={{ ...context, timeline: forkParent || context.timeline }} calendar={calendar} onClose={() => setCreatingLine(false)} onSaved={async (line) => { await onTimelineChanged(); await onSelect(line.id); setDirty(true); setNotice("Линия добавлена. Сохраните расположение на схеме."); }} />}
    {draft && <ConnectionDialog lines={context.timelines} value={draft} onClose={() => setDraft(null)} onSave={(value) => { setGraph((old) => old ? { ...old, connections: [...old.connections.filter((edge) => edge.id !== value.id), value] } : old); setDirty(true); setNotice(""); setDraft(null); }} onDelete={draft.editing ? () => { setGraph((old) => old ? { ...old, connections: old.connections.filter((edge) => edge.id !== draft.id) } : old); setDirty(true); setNotice(""); setDraft(null); } : undefined} />}
  </section>;
}

function ConnectionDialog({ lines, value, onClose, onSave, onDelete }: { lines: Timeline[]; value: ConnectionDraft; onClose: () => void; onSave: (edge: TimelineConnection) => void; onDelete?: () => void }) {
  const [error, setError] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const sourceId = String(form.get("sourceId")), targetId = String(form.get("targetId"));
    if (sourceId === targetId) { setError("Выберите две разные временные линии"); return; }
    onSave({ id: value.id, sourceId, targetId, kind: String(form.get("kind")) as TimelineConnection["kind"], label: String(form.get("label") || "").trim() });
  }
  return <HistoryDialog title="Переплетение историй" onClose={onClose}><form onSubmit={submit}><div className="editor-content"><p className="field-hint">Свяжите пути разных историй и подпишите, что их объединяет.</p><label className="field"><span>Линия-источник</span><select name="sourceId" aria-label="Линия-источник" defaultValue={value.sourceId}>{lines.map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}</select></label><label className="field"><span>Линия-цель</span><select name="targetId" aria-label="Линия-цель" defaultValue={value.targetId}>{lines.map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}</select></label><label className="field"><span>Тип переплетения</span><select name="kind" aria-label="Тип переплетения" defaultValue={value.kind}><option value="intersection">Пересечение историй</option><option value="influence">Влияние одной истории на другую</option><option value="travel">Переход между историями</option></select></label><label className="field"><span>Название переплетения</span><input name="label" aria-label="Название переплетения" defaultValue={value.label} maxLength={160} placeholder="Например, Встреча у Серебряного древа" autoFocus /></label>{error && <p role="alert" className="form-error">{error}</p>}</div><div className="editor-footer">{onDelete && <button type="button" className="button danger-quiet" onClick={onDelete}><Trash2 size={15} />Удалить переплетение</button>}<span /><button type="button" className="button secondary" onClick={onClose}>Отмена</button><button className="button primary"><Check size={15} />{value.editing ? "Изменить связь" : "Добавить связь"}</button></div></form></HistoryDialog>;
}
