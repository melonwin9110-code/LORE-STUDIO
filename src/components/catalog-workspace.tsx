"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, GitBranch, Globe2, LoaderCircle, Search, Users } from "lucide-react";
import type { CatalogEntry, CatalogResult } from "@/lib/workspace-types";
import type { Project, World } from "@/lib/types";
import type { Timeline } from "@/lib/history-types";
import { historyApi } from "./history-api";

export function CatalogWorkspace({ projects, onOpen }: { projects: Project[]; onOpen: (entry: CatalogEntry) => Promise<void> }) {
  const [data, setData] = useState<CatalogResult | null>(null), [error, setError] = useState("");
  const [draft, setDraft] = useState(""), [query, setQuery] = useState("");
  const [project, setProject] = useState(""), [world, setWorld] = useState(""), [timeline, setTimeline] = useState("");
  const [worlds, setWorlds] = useState<World[]>([]), [timelines, setTimelines] = useState<Timeline[]>([]);
  const [cursor, setCursor] = useState("0"), [loading, setLoading] = useState(false), [opening, setOpening] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(async () => {
      if (!cancelled) { setLoading(true); setError(""); }
      const params = new URLSearchParams({ limit: "40", cursor });
      if (query) params.set("q", query); if (project) params.set("project", project); if (world) params.set("world", world); if (timeline) params.set("timeline", timeline);
      return historyApi<CatalogResult>(`/characters/catalog?${params}`);
    }).then((result) => { if (!cancelled) setData(result); }).catch((err: Error) => { if (!cancelled) setError(err.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query, project, world, timeline, cursor]);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(async () => {
      if (!project) return [];
      return (await historyApi<{ worlds: World[] }>(`/projects/${project}/worlds`)).worlds;
    }).then((items) => { if (!cancelled) setWorlds(items); }).catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [project]);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(async () => {
      if (!world) return [];
      return (await historyApi<{ timelines: Timeline[] }>(`/worlds/${world}/timelines`)).timelines;
    }).then((items) => { if (!cancelled) setTimelines(items); }).catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [world]);
  async function open(entry: CatalogEntry) {
    setOpening(entry.key); setError("");
    try { await onOpen(entry); } catch (err) { setError(err instanceof Error ? err.message : "Не удалось открыть персонажа"); }
    finally { setOpening(null); }
  }
  return <section className="catalog-workspace">
    <div className="page-heading"><div><p className="eyebrow">ЛИЦА ВСЕХ ВАШИХ ВСЕЛЕННЫХ</p><h1>Все персонажи<span className="heading-dot" aria-hidden="true">.</span></h1><p className="subtitle">Общий каталог доступных проектов. У каждой версии героя есть свой источник.</p></div><span className="catalog-count"><Users size={18} />{data?.total ?? "—"}</span></div>
    <form className="catalog-filters" onSubmit={(e) => { e.preventDefault(); setCursor("0"); setQuery(draft); }}>
      <label className="search-field"><Search size={17} /><input aria-label="Поиск по всем персонажам" placeholder="Имя, титул или вид…" value={draft} onChange={(e) => setDraft(e.target.value)} /></label><button className="button secondary" disabled={loading}>Найти</button>
      <label className="field"><span>Проект</span><select aria-label="Проект каталога" value={project} onChange={(e) => { setProject(e.target.value); setWorld(""); setTimeline(""); setCursor("0"); }}><option value="">Все проекты</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="field"><span>Мир</span><select aria-label="Мир каталога" value={world} disabled={!project} onChange={(e) => { setWorld(e.target.value); setTimeline(""); setCursor("0"); }}><option value="">Все миры</option>{worlds.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
      <label className="field"><span>Линия</span><select aria-label="Линия каталога" value={timeline} disabled={!world} onChange={(e) => { setTimeline(e.target.value); setCursor("0"); }}><option value="">Все линии</option>{timelines.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
    </form>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {loading ? <div className="loading-state"><LoaderCircle className="spin" size={26} /><p>Собираем персонажей…</p></div> : data?.characters.length ? <div className="catalog-grid">{data.characters.map((entry) => <article className="catalog-card" key={entry.key}>
      <button className="catalog-card-open" disabled={opening !== null} onClick={() => void open(entry)} aria-label={`Открыть ${entry.character.name} — ${entry.world.name} — ${entry.timeline.name}`}>
        <div className="catalog-portrait">{entry.character.portraitUrl ? <Image src={entry.character.portraitUrl} alt={`Портрет ${entry.character.name}`} fill unoptimized sizes="300px" /> : <span>{entry.character.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("")}</span>}<span className={`status-badge ${entry.character.status}`}>{entry.character.status === "canon" ? "Канон" : "Черновик"}</span></div>
        <div className="catalog-card-copy"><small>{entry.character.species || "Персонаж"}</small><h2>{entry.character.name}</h2><p>{entry.character.title || entry.character.biography || "История ещё не написана"}</p></div>
        <div className="catalog-source" aria-label="Источник персонажа"><span>{entry.project.name}</span><span><Globe2 size={11} />{entry.world.name}</span><span><GitBranch size={11} />{entry.timeline.name}</span></div>
        <div className="catalog-open-hint">{opening === entry.key ? <LoaderCircle className="spin" size={14} /> : <>Открыть в исходной линии<ArrowRight size={14} /></>}</div>
      </button>
    </article>)}</div> : <div className="catalog-empty"><Users size={34} strokeWidth={1.2} /><h2>Персонажи не найдены</h2><p>Измените фильтры или создайте персонажа в одном из своих миров.</p></div>}
    {data && (Number(cursor) > 0 || data.nextCursor) && <div className="catalog-pagination"><button className="button secondary" disabled={loading || Number(cursor) === 0} onClick={() => setCursor(String(Math.max(0, Number(cursor) - 40)))}><ChevronLeft size={15} />Назад</button><span>{Number(cursor) + 1}–{Number(cursor) + data.characters.length} из {data.total}</span><button className="button secondary" disabled={loading || !data.nextCursor} onClick={() => setCursor(data.nextCursor!)}>Далее<ChevronRight size={15} /></button></div>}
  </section>;
}
