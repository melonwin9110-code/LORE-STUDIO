"use client";

import { useEffect, useRef, useState } from "react";
import { Compass, Expand, LocateFixed, Minus, Plus, Shrink } from "lucide-react";
import OLMap from "ol/Map";
import View from "ol/View";
import Feature from "ol/Feature";
import Collection from "ol/Collection";
import GeoJSON from "ol/format/GeoJSON";
import Geometry from "ol/geom/Geometry";
import Polygon from "ol/geom/Polygon";
import LineString from "ol/geom/LineString";
import Projection from "ol/proj/Projection";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import Draw from "ol/interaction/Draw";
import Modify from "ol/interaction/Modify";
import Select from "ol/interaction/Select";
import Translate from "ol/interaction/Translate";
import { defaults as defaultInteractions } from "ol/interaction/defaults";
import { primaryAction, shiftKeyOnly } from "ol/events/condition";
import { Fill, Stroke, Style, Text, Circle as CircleStyle, RegularShape } from "ol/style";
import type { FeatureLike } from "ol/Feature";
import type Interaction from "ol/interaction/Interaction";
import "ol/ol.css";
import type { AtlasMap, MapFeature, MapGeometry, MapLayer, MapTool, MapView } from "@/lib/map-types";
import styles from "./map-canvas.module.css";

export type MapCanvasProps = {
  map: AtlasMap;
  features: MapFeature[];
  layers: MapLayer[];
  selectedIds: string[];
  tool: MapTool;
  activeLayerId: string | null;
  canEdit: boolean;
  view: MapView;
  onSelect: (ids: string[]) => void;
  onCreateGeometry: (geometry: MapGeometry) => void;
  onGeometriesChanged: (changes: { id: string; geometry: MapGeometry }[]) => void;
  onSplitGeometry: (cutter: Extract<MapGeometry, { type: "LineString" }>) => void;
};

type VectorMapLayer = VectorLayer<VectorSource<Feature<Geometry>>>;
type CanvasRuntime = {
  map: OLMap;
  projection: Projection;
  baseSource: VectorSource<Feature<Geometry>>;
  baseLayer: VectorMapLayer;
  layers: Map<string, VectorMapLayer>;
  features: Map<string, Feature<Geometry>>;
  select: Select;
};
const formatter = new GeoJSON();
const geographyOrder: Record<MapFeature["kind"], number> = {
  ocean: 0, sea: 10, continent: 20, island: 30,
  plain: 40, desert: 45, biome: 50, forest: 60, mountain: 70, lake: 80,
  state: 90, province: 100, custom: 130,
  coastline: 150, border: 200, river: 210, road: 220,
  city: 1000, settlement: 1000, port: 1000, fortress: 1000, label: 9000,
};
const toolHints: Record<MapTool, string> = {
  select: "Нажмите на объект. Shift + щелчок — выбрать несколько.",
  pan: "Перемещайте карту мышью или одним пальцем. Два пальца — масштаб.",
  point: "Нажмите на карту, чтобы разместить объект.",
  line: "Добавляйте точки. Двойной щелчок завершит линию, Esc отменит.",
  polygon: "Обведите территорию и дважды нажмите на последнюю точку. Esc — отмена.",
  modify: "Потяните узел выбранного объекта. Alt + щелчок удаляет узел.",
  move: "Перетащите выбранные объекты в новое место.",
  split: "Проведите линию насквозь через выбранную территорию. Двойной щелчок — закончить.",
};

function layerVisible(layer: MapLayer, view: MapView) {
  return layer.visible && layer.opacity > 0 && !(view === "physical" && layer.kind === "political");
}

function inside(geometry: Geometry, map: AtlasMap) {
  const extent = geometry.getExtent();
  return extent.every(Number.isFinite) && extent[0] >= 0 && extent[1] >= 0 && extent[2] <= map.width && extent[3] <= map.height;
}

function geographyStyle(record: MapFeature, selected: boolean): Style {
  const point = record.geometry.type === "Point";
  const textOnly = record.kind === "label";
  const stroke = new Stroke({
    color: selected ? "#e1bfff" : record.stroke,
    width: record.strokeWidth + (selected ? 2 : 0),
    lineDash: record.kind === "border" ? [9, 5] : record.kind === "road" ? [6, 3] : undefined,
    lineCap: "round", lineJoin: "round",
  });
  const fill = new Fill({ color: record.fill });
  const symbol = record.kind === "fortress"
    ? new RegularShape({ points: 4, radius: selected ? 9 : 7, angle: Math.PI / 4, fill, stroke })
    : record.kind === "port"
      ? new RegularShape({ points: 3, radius: selected ? 9 : 7, rotation: Math.PI, fill, stroke })
      : new CircleStyle({ radius: textOnly ? 0 : selected ? 8 : record.kind === "city" ? 6 : 5, fill, stroke });
  return new Style({
    fill, stroke, image: point ? symbol : undefined,
    text: record.label || textOnly ? new Text({
      text: record.name, font: `${record.kind === "state" ? "600 14px" : "500 12px"} Georgia, serif`,
      fill: new Fill({ color: selected ? "#f2ddff" : "#f4ead3" }),
      stroke: new Stroke({ color: "#11202cee", width: 3 }),
      offsetY: point && !textOnly ? -17 : 0, overflow: false,
      padding: [3, 4, 3, 4],
    }) : undefined,
    zIndex: selected ? 10000 : record.kind === "label" ? 9000 : point ? 1000 : geographyOrder[record.kind],
  });
}

function drawBase(runtime: CanvasRuntime, map: AtlasMap) {
  const features: Feature<Geometry>[] = [];
  const outline = new Feature(new Polygon([[[0, 0], [map.width, 0], [map.width, map.height], [0, map.height], [0, 0]]]));
  outline.setStyle(new Style({ fill: new Fill({ color: map.background }), stroke: new Stroke({ color: "#99bbb85c", width: 1.3 }) }));
  features.push(outline);
  for (let index = 1; index < 10; index++) {
    const vertical = new Feature(new LineString([[map.width * index / 10, 0], [map.width * index / 10, map.height]]));
    const horizontal = new Feature(new LineString([[0, map.height * index / 10], [map.width, map.height * index / 10]]));
    const gridStyle = new Style({ stroke: new Stroke({ color: "#97bbb51c", width: 0.65, lineDash: [2, 6] }) });
    vertical.setStyle(gridStyle); horizontal.setStyle(gridStyle); features.push(vertical, horizontal);
  }
  runtime.baseSource.clear(); runtime.baseSource.addFeatures(features);
}

export function MapCanvas(props: MapCanvasProps) {
  const host = useRef<HTMLDivElement>(null), frame = useRef<HTMLDivElement>(null);
  const runtime = useRef<CanvasRuntime | null>(null), latest = useRef(props);
  const [coordinate, setCoordinate] = useState<string>("");
  const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [readyMapId, setReadyMapId] = useState<string | null>(null);
  useEffect(() => { latest.current = props; }, [props]);

  useEffect(() => {
    if (!host.current) return;
    const current = latest.current;
    const projection = new Projection({ code: `LORE:${current.map.id}`, units: "pixels", extent: [0, 0, current.map.width, current.map.height] });
    const baseSource = new VectorSource<Feature<Geometry>>();
    const baseLayer = new VectorLayer({ source: baseSource, zIndex: -100 });
    const select = new Select({
      style: null, hitTolerance: 7, multi: true, toggleCondition: shiftKeyOnly,
      layers: (layer) => Boolean(layer.get("loreLayer")),
      filter: (feature) => typeof feature.getId() === "string",
    });
    const map = new OLMap({
      target: host.current,
      layers: [baseLayer],
      controls: [],
      interactions: defaultInteractions({ altShiftDragRotate: false, pinchRotate: false }),
      keyboardEventTarget: host.current,
      view: new View({ projection, center: [current.map.width / 2, current.map.height / 2], resolution: 1, minResolution: 0.01, maxResolution: Math.max(current.map.width, current.map.height), extent: [0, 0, current.map.width, current.map.height], constrainOnlyCenter: true, showFullExtent: true, smoothExtentConstraint: false }),
    });
    map.addInteraction(select);
    const state: CanvasRuntime = { map, projection, baseSource, baseLayer, select, layers: new Map(), features: new Map() };
    runtime.current = state;
    drawBase(state, current.map);
    select.on("select", () => {
      latest.current.onSelect(select.getFeatures().getArray().map((feature) => String(feature.getId())));
    });
    map.on("pointermove", (event) => {
      if (event.dragging) return;
      const [x, y] = event.coordinate;
      setCoordinate(x >= 0 && y >= 0 && x <= latest.current.map.width && y <= latest.current.map.height ? `${Math.round(x)} · ${Math.round(y)}` : "");
    });
    const resize = new ResizeObserver(() => map.updateSize());
    resize.observe(host.current);
    const fit = requestAnimationFrame(() => {
      map.updateSize();
      map.getView().fit([0, 0, current.map.width, current.map.height], { padding: [42, 32, 42, 32], duration: 0 });
      map.once("rendercomplete", () => setReadyMapId(current.map.id));
      map.render();
    });
    return () => {
      cancelAnimationFrame(fit); resize.disconnect(); map.setTarget(undefined); map.dispose();
      if (runtime.current === state) runtime.current = null;
    };
  }, [props.map.id, props.map.width, props.map.height]);

  useEffect(() => {
    const state = runtime.current;
    if (!state) return;
    drawBase(state, props.map);
    const wantedLayers = new Set(props.layers.map((layer) => layer.id));
    for (const [id, layer] of state.layers) if (!wantedLayers.has(id)) { state.map.removeLayer(layer); state.layers.delete(id); }
    const selected = new Set(props.selectedIds);
    const styleCache = new Map<string, Style>();
    for (const layer of props.layers) {
      let rendered = state.layers.get(layer.id);
      if (!rendered) {
        rendered = new VectorLayer({ source: new VectorSource<Feature<Geometry>>(), declutter: true });
        rendered.set("loreLayer", layer.id); state.layers.set(layer.id, rendered); state.map.addLayer(rendered);
      }
      rendered.setZIndex(100 + layer.order); rendered.setOpacity(layer.opacity); rendered.setVisible(layerVisible(layer, props.view));
      rendered.setStyle((feature: FeatureLike) => {
        const record = feature.get("loreRecord") as MapFeature | undefined;
        if (!record) return undefined;
        let style = styleCache.get(record.id);
        if (!style) { style = geographyStyle(record, selected.has(record.id)); styleCache.set(record.id, style); }
        return style;
      });
    }
    const wantedFeatures = new Set(props.features.map((feature) => feature.id));
    for (const [id, feature] of state.features) if (!wantedFeatures.has(id)) {
      for (const layer of state.layers.values()) layer.getSource()?.removeFeature(feature);
      state.features.delete(id);
    }
    for (const record of props.features) {
      const targetLayer = state.layers.get(record.layerId), source = targetLayer?.getSource();
      if (!source) continue;
      let feature = state.features.get(record.id);
      const serialized = JSON.stringify(record.geometry);
      if (!feature) {
        const geometry = formatter.readGeometry(record.geometry, { dataProjection: state.projection, featureProjection: state.projection });
        if (!geometry) continue;
        feature = new Feature(geometry);
        feature.setId(record.id); state.features.set(record.id, feature);
      } else if (feature.get("loreGeometry") !== serialized) {
        feature.setGeometry(formatter.readGeometry(record.geometry, { dataProjection: state.projection, featureProjection: state.projection }));
      }
      feature.set("loreGeometry", serialized, true); feature.set("loreRecord", record, true);
      for (const [layerId, layer] of state.layers) if (layerId !== record.layerId && layer.getSource()?.hasFeature(feature)) layer.getSource()?.removeFeature(feature);
      if (!source.hasFeature(feature)) source.addFeature(feature);
    }
    const collection = state.select.getFeatures(); collection.clear();
    for (const id of props.selectedIds) {
      const feature = state.features.get(id), record = props.features.find((item) => item.id === id);
      const layer = record && props.layers.find((item) => item.id === record.layerId);
      if (feature && layer && layerVisible(layer, props.view)) collection.push(feature);
    }
    for (const layer of state.layers.values()) layer.changed();
  }, [props.map, props.features, props.layers, props.view, props.selectedIds]);

  useEffect(() => {
    const state = runtime.current;
    if (!state) return;
    const projection = state.projection;
    const additions: Interaction[] = [];
    const canEdit = props.canEdit;
    const selected = new Collection<Feature<Geometry>>();
    for (const id of props.selectedIds) {
      const feature = state.features.get(id), record = props.features.find((item) => item.id === id);
      const layer = record && props.layers.find((item) => item.id === record.layerId);
      if (feature && layer && !layer.locked && layerVisible(layer, props.view)) selected.push(feature);
    }
    state.select.setActive(!canEdit || props.tool === "select" || props.tool === "modify" || props.tool === "move");
    let draw: Draw | null = null;
    const layer = props.layers.find((item) => item.id === props.activeLayerId);
    const drawing = ["point", "line", "polygon", "split"].includes(props.tool);
    if (canEdit && drawing && (props.tool === "split" || layer && !layer.locked && layerVisible(layer, props.view))) {
      const type = props.tool === "point" ? "Point" : props.tool === "polygon" ? "Polygon" : "LineString";
      draw = new Draw({
        type, stopClick: true,
        condition: (event) => primaryAction(event) && event.coordinate[0] >= 0 && event.coordinate[1] >= 0 && event.coordinate[0] <= latest.current.map.width && event.coordinate[1] <= latest.current.map.height,
        style: new Style({ fill: new Fill({ color: "#b69ae63d" }), stroke: new Stroke({ color: "#e2c4ff", width: 2, lineDash: props.tool === "split" ? [7, 5] : undefined }), image: new CircleStyle({ radius: 5, fill: new Fill({ color: "#e2c4ff" }), stroke: new Stroke({ color: "#49375f", width: 2 }) }) }),
      });
      draw.on("drawstart", () => setMessage(""));
      draw.on("drawend", (event) => {
        const geometry = event.feature.getGeometry();
        if (!geometry || !inside(geometry, latest.current.map)) { setMessage("Объект должен полностью находиться в границах карты."); return; }
        const value = formatter.writeGeometryObject(geometry, { dataProjection: projection, featureProjection: projection }) as MapGeometry;
        if (latest.current.tool === "split" && value.type === "LineString") latest.current.onSplitGeometry(value);
        else latest.current.onCreateGeometry(value);
      });
      additions.push(draw);
    }
    const before = new Map<Feature<Geometry>, Geometry>();
    function beginEdit() { before.clear(); for (const feature of selected.getArray()) { const geometry = feature.getGeometry(); if (geometry) before.set(feature, geometry.clone()); } setMessage(""); }
    function finishEdit() {
      const changes: { id: string; geometry: MapGeometry }[] = [];
      for (const feature of selected.getArray()) {
        const geometry = feature.getGeometry();
        if (!geometry || !inside(geometry, latest.current.map)) {
          for (const [changed, original] of before) changed.setGeometry(original);
          setMessage("Перемещение отменено: объект вышел за границы карты."); return;
        }
        const value = formatter.writeGeometryObject(geometry, { dataProjection: projection, featureProjection: projection }) as MapGeometry;
        const original = before.get(feature);
        if (original && JSON.stringify(formatter.writeGeometryObject(original)) !== JSON.stringify(value)) changes.push({ id: String(feature.getId()), geometry: value });
      }
      if (changes.length) latest.current.onGeometriesChanged(changes);
      before.clear();
    }
    if (canEdit && selected.getLength() && props.tool === "modify") {
      const modify = new Modify({ features: selected, pixelTolerance: 10 });
      modify.on("modifystart", beginEdit); modify.on("modifyend", finishEdit); additions.push(modify);
    }
    if (canEdit && selected.getLength() && props.tool === "move") {
      const translate = new Translate({ features: selected, hitTolerance: 7 });
      translate.on("translatestart", beginEdit); translate.on("translateend", finishEdit); additions.push(translate);
    }
    for (const interaction of additions) state.map.addInteraction(interaction);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { draw?.abortDrawing(); if (props.tool === "select") latest.current.onSelect([]); setMessage(""); }
    };
    const element = host.current; element?.addEventListener("keydown", key);
    return () => { element?.removeEventListener("keydown", key); for (const interaction of additions) state.map.removeInteraction(interaction); };
  }, [props.map.id, props.canEdit, props.tool, props.activeLayerId, props.layers, props.features, props.selectedIds, props.view]);

  useEffect(() => {
    const fullscreen = () => { setExpanded(document.fullscreenElement === frame.current); };
    document.addEventListener("fullscreenchange", fullscreen);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.fullscreenElement) setExpanded(false); };
    window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("fullscreenchange", fullscreen); window.removeEventListener("keydown", escape); };
  }, []);

  function fit() {
    const current = runtime.current;
    if (current) current.map.getView().fit([0, 0, props.map.width, props.map.height], { padding: [42, 32, 42, 32], duration: 200 });
  }
  function zoom(direction: number) {
    const view = runtime.current?.map.getView();
    if (view) view.animate({ zoom: (view.getZoom() ?? 0) + direction, duration: 180 });
  }
  async function fullscreen() {
    if (document.fullscreenElement === frame.current) { await document.exitFullscreen(); return; }
    if (expanded) { setExpanded(false); return; }
    try {
      if (!frame.current?.requestFullscreen) { setExpanded(true); return; }
      await frame.current.requestFullscreen();
    } catch { setExpanded(true); }
  }

  return <div ref={frame} className={`${styles.frame} ${expanded ? styles.expanded : ""}`}>
    <div ref={host} className={`${styles.canvas} ${["point", "line", "polygon", "split"].includes(props.tool) && props.canEdit ? styles.drawing : props.tool === "move" || props.tool === "pan" ? styles.moving : ""}`} role="region" aria-label={`Полотно карты ${props.map.name}`} tabIndex={0} data-testid="map-canvas" data-ready={readyMapId === props.map.id ? "true" : "false"} />
    <div className={styles.caption}><span className={styles.captionDot} /><span>{props.view === "political" ? "ПОЛИТИЧЕСКАЯ КАРТА" : "ФИЗИЧЕСКАЯ КАРТА"}</span></div>
    <div className={styles.compass} aria-hidden="true"><span>С</span><Compass size={38} strokeWidth={0.8} /><small>Ю</small></div>
    <div className={styles.controls}><button type="button" aria-label="Увеличить карту" title="Увеличить карту" onClick={() => zoom(1)}><Plus size={17} /></button><button type="button" aria-label="Уменьшить карту" title="Уменьшить карту" onClick={() => zoom(-1)}><Minus size={17} /></button><button type="button" aria-label="Уместить карту" title="Уместить карту" onClick={fit}><LocateFixed size={17} /></button><button type="button" aria-label={expanded ? "Свернуть карту" : "Карта на весь экран"} title={expanded ? "Свернуть карту" : "На весь экран"} onClick={() => void fullscreen()}>{expanded ? <Shrink size={16} /> : <Expand size={16} />}</button></div>
    <div className={styles.hint}>{props.canEdit ? toolHints[props.tool] : "Просмотр карты. Перемещайте фон и меняйте масштаб."}</div>
    <div className={styles.coordinates}><span>{coordinate || `${props.map.width} × ${props.map.height}`}</span><small>КООРДИНАТЫ МИРА</small></div>
    {message && <div className={styles.message} role="alert">{message}</div>}
  </div>;
}
