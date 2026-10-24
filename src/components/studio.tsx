"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ArrowRight, BookOpen, Check, ChevronDown, ChevronRight, CircleHelp, Clock3, Compass, Feather, GitBranch, Globe2, LayoutDashboard, Link2, LoaderCircle, LogOut, Moon, MoreHorizontal, Pencil, Plus, Search, Shield, Sparkles, Sun, Trash2, Users, X } from "lucide-react";
import type { Character, LoreEvent, Project, Relation, User, World, WorldData } from "@/lib/types";
import type { Timeline, CalendarRecord } from "@/lib/history-types";
import { GREGORIAN, type CalendarDefinition } from "@/lib/calendar";
import { HistoryControls, historicalDate } from "./history-controls";
import { TimelineDialog, CompareDialog } from "./history-dialogs";
import { CalendarWorkspace } from "./calendar-workspace";
import { FamilyView } from "./family-view";
import { RevisionHistory } from "./revision-history";

type Section = "overview" | "characters" | "events" | "relations" | "family" | "calendars";
type Editor = { kind: "project"; value?: Project } | { kind: "world"; value?: World } | { kind: "character"; value?: Character } | { kind: "event"; value?: LoreEvent } | { kind: "relation"; value?: Relation; family?: boolean };
class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { method, credentials: "same-origin", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || "Не удалось выполнить запрос. Попробуйте ещё раз.", response.status);
  return data as T;
}
const navigation: { id: Section; label: string; icon: typeof Compass }[] = [
  { id: "overview", label: "Обзор мира", icon: LayoutDashboard },
  { id: "characters", label: "Персонажи", icon: Users },
  { id: "events", label: "Хронология", icon: Clock3 },
  { id: "relations", label: "Отношения", icon: GitBranch },
  { id: "family", label: "Семейное древо", icon: Users },
  { id: "calendars", label: "Календари", icon: Clock3 },
];
const letters = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
const year = (value: number | null) => value === null ? "Дата не указана" : `${value.toLocaleString("ru-RU")} г.`;
const statusLabel = (value: string) => value === "canon" ? "Канон" : "Черновик";

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? "compact" : ""}`}><span className="brand-symbol"><Compass size={25} strokeWidth={1.4} /></span><div><strong>LORE<span>STUDIO</span></strong>{!compact && <small>МАСТЕРСКАЯ МИРОВ</small>}</div></div>;
}

export default function Studio() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [theme, setTheme] = useState("dark");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [worlds, setWorlds] = useState<World[]>([]);
  const [worldId, setWorldId] = useState("");
  const [data, setData] = useState<WorldData | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<Section>("overview");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [projectsView, setProjectsView] = useState(false);
  const [calendarId, setCalendarId] = useState("");
  const [historyDialog, setHistoryDialog] = useState<"new" | "manage" | "compare" | null>(null);
  const selectedCalendar = data?.history?.calendars.find((record) => record.id === calendarId)?.definition || GREGORIAN;
  const beforeFork = data?.history?.day !== null && data?.history?.day !== undefined && data.history.timeline.forkDay !== null && BigInt(data.history.day) < BigInt(data.history.timeline.forkDay);
  function scoped(path: string) {
    const params = new URLSearchParams();
    if (data?.history) { params.set("timeline", data.history.timeline.id); if (data.history.day !== null) params.set("day", data.history.day); }
    return params.size ? `${path}?${params}` : path;
  }
  function rememberContext(timelineId: string, day: string | null, nextCalendarId = calendarId) {
    if (!user || !worldId) return;
    try { localStorage.setItem(`lore-context:${user.id}:${worldId}`, JSON.stringify({ timelineId, day, calendarId: nextCalendarId })); } catch { /* Preferences are optional; lore remains in PostgreSQL. */ }
  }
  const project = projects.find((item) => item.id === projectId);
  const world = worlds.find((item) => item.id === worldId);

  useEffect(() => {
    const saved = localStorage.getItem("lore-theme");
    Promise.resolve().then(() => { if (saved === "light") setTheme("light"); });
    api<{ user: User | null }>("/session").then((result) => setUser(result.user)).catch((err: Error) => setError(err.message)).finally(() => setBooting(false));
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("lore-theme", theme); }, [theme]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 4500); return () => clearTimeout(timer); }, [notice]);
  const report = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) { setUser(null); setData(null); setProjects([]); }
    setError(err instanceof Error ? err.message : "Произошла непредвиденная ошибка.");
  }, []);
  const loadProjects = useCallback(async () => {
    const result = await api<{ projects: Project[] }>("/projects");
    setProjects(result.projects);
    setProjectId((old) => result.projects.some((p) => p.id === old) ? old : result.projects[0]?.id || "");
    return result.projects;
  }, []);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    Promise.resolve().then(() => { if (!cancelled) setLoading(true); return api<{ projects: Project[] }>("/projects"); }).then(({ projects: items }) => {
      if (!cancelled) { setProjects(items); setProjectId(items[0]?.id || ""); }
    }).catch(report).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user, report]);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(async () => {
      if (cancelled) return null;
      setWorlds([]); setWorldId(""); setData(null);
      if (!projectId || !user) return null;
      setLoading(true);
      return api<{ worlds: World[] }>(`/projects/${projectId}/worlds`);
    }).then((result) => {
      const items = result?.worlds || [];
      if (!cancelled) { setWorlds(items); setWorldId(items[0]?.id || ""); }
    }).catch(report).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, user, report]);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(async () => {
      if (cancelled) return null;
      setData(null);
      if (!worldId || !user) return null;
      setLoading(true);
      let saved: { timelineId?: string; day?: string | null; calendarId?: string } | null = null;
      try { saved = JSON.parse(localStorage.getItem(`lore-context:${user.id}:${worldId}`) || "null"); } catch { /* Ignore invalid local preferences. */ }
      const params = new URLSearchParams();
      if (typeof saved?.timelineId === "string") params.set("timeline", saved.timelineId);
      if (typeof saved?.day === "string") params.set("day", saved.day);
      let result: WorldData;
      try { result = await api<WorldData>(`/worlds/${worldId}${params.size ? `?${params}` : ""}`); }
      catch (err) { if (!params.size || !(err instanceof ApiError) || err.status !== 404) throw err; result = await api<WorldData>(`/worlds/${worldId}`); }
      if (!cancelled) setCalendarId(result.history?.calendars.find((record) => record.id === saved?.calendarId)?.id || result.history?.calendars.find((record) => record.isDefault)?.id || result.history?.calendars[0]?.id || "");
      return result;
    }).then((result) => { if (!cancelled) setData(result); }).catch(report).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [worldId, user, report]);
  const refreshWorld = async () => { if (worldId) setData(await api<WorldData>(scoped(`/worlds/${worldId}`))); };
  async function changeHistory(timelineId: string, day: string | null) {
    await run(async () => {
      const params = new URLSearchParams({ timeline: timelineId }); if (day !== null) params.set("day", day);
      const next = await api<WorldData>(`/worlds/${worldId}?${params}`);
      setData(next); rememberContext(timelineId, day); setEditor(null);
    });
  }
  async function timelineSaved(line: Timeline, day: string | null) {
    const params = new URLSearchParams({ timeline: line.id }); if (day !== null) params.set("day", day);
    setData(await api<WorldData>(`/worlds/${worldId}?${params}`)); rememberContext(line.id, day); setNotice("Временная линия сохранена");
  }
  async function calendarCreated(record: CalendarRecord) {
    await refreshWorld(); setCalendarId(record.id);
    if (data?.history) rememberContext(data.history.timeline.id, data.history.day, record.id);
    setNotice("Календарь создан");
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (err) { report(err); if (err instanceof ApiError && err.status === 409) { await refreshWorld().catch(report); } }
    finally { setBusy(false); }
  }
  async function createDemo() {
    await run(async () => {
      const { project: demo } = await api<{ project: Project }>("/projects/demo", "POST", {});
      await loadProjects(); setProjectId(demo.id); setProjectsView(false); setSection("overview"); setNotice("Демонстрационная вселенная «Элирия» готова");
    });
  }
  async function saveEditor(payload: Record<string, unknown>) {
    if (!editor) return;
    await run(async () => {
      const existing = editor.value;
      if (editor.kind === "project") {
        const { project: saved } = await api<{ project: Project }>(existing ? `/projects/${existing.id}` : "/projects", existing ? "PATCH" : "POST", payload);
        await loadProjects(); setProjectId(saved.id); setProjectsView(false);
      } else if (editor.kind === "world") {
        const { world: saved } = await api<{ world: World }>(existing ? `/worlds/${existing.id}` : `/projects/${projectId}/worlds`, existing ? "PATCH" : "POST", payload);
        const result = await api<{ worlds: World[] }>(`/projects/${projectId}/worlds`);
        setWorlds(result.worlds); setWorldId(saved.id); if (existing) await refreshWorld();
      } else {
        const resource = editor.kind === "character" ? "characters" : editor.kind === "event" ? "events" : "relations";
        const versioned = existing && "version" in existing ? { ...payload, version: existing.version } : payload;
        await api(scoped(existing ? `/${resource}/${existing.id}` : `/worlds/${worldId}/${resource}`), existing ? "PATCH" : "POST", versioned);
        await refreshWorld();
      }
      setEditor(null); setNotice(existing ? "Изменения сохранены" : "Создано и сохранено");
    });
  }
  async function remove(kind: "project" | "world" | "character" | "event" | "relation", id: string, name: string) {
    const scope = kind === "project" ? " Все миры, линии и их история также будут удалены. Это действие нельзя отменить." : kind === "world" ? " Все линии и история мира также будут удалены. Это действие нельзя отменить." : kind === "character" ? " Связанные отношения и участие в событиях будут сняты в выбранной линии. Ранее сохранённые состояния останутся в истории." : " Ранее сохранённые состояния останутся в истории выбранной линии.";
    if (!window.confirm(`Удалить «${name}»?${scope}`)) return;
    await run(async () => {
      const resource = { project: "projects", world: "worlds", character: "characters", event: "events", relation: "relations" }[kind];
      await api(kind === "project" || kind === "world" ? `/${resource}/${id}` : scoped(`/${resource}/${id}`), "DELETE");
      if (kind === "project") { await loadProjects(); }
      else if (kind === "world") { const result = await api<{ worlds: World[] }>(`/projects/${projectId}/worlds`); setWorlds(result.worlds); setWorldId(result.worlds[0]?.id || ""); }
      else await refreshWorld();
      setEditor(null); setNotice("Удалено");
    });
  }
  const toggleTheme = () => setTheme((old) => old === "dark" ? "light" : "dark");
  if (booting) return <main className="boot-screen"><Brand /><LoaderCircle className="spin" /><p>Открываем мастерскую…</p></main>;
  if (!user) return <AuthScreen onAuth={(next) => { setError(""); setUser(next); }} theme={theme} toggleTheme={toggleTheme} initialError={error} />;

  const filteredCharacters = data?.characters.filter((c) => `${c.name} ${c.title} ${c.species} ${c.biography}`.toLowerCase().includes(query.toLowerCase())) || [];
  const filteredEvents = data?.events.filter((e) => `${e.name} ${e.type} ${e.description}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.startYear - b.startYear) || [];
  const characterName = (id: string) => data?.characters.find((c) => c.id === id)?.name || "Неизвестный персонаж";
  const filteredRelations = data?.relations.filter((r) => `${characterName(r.fromId)} ${characterName(r.toId)} ${r.kind}`.toLowerCase().includes(query.toLowerCase())) || [];
  const openSection = (next: Section) => { setSection(next); setProjectsView(false); setQuery(""); };
  const sectionTitles = { overview: "Обзор мира", characters: "Персонажи", events: "Хронология", relations: "Отношения", family: "Семейное древо", calendars: "Календари" };

  return <div className="studio-shell">
    <aside className="sidebar">
      <Brand />
      <button aria-label="Мои проекты" title="Мои проекты" className={`all-projects ${projectsView ? "selected" : ""}`} onClick={() => { setProjectsView(true); setQuery(""); }}><BookOpen size={17} />Мои проекты<ChevronRight size={14} /></button>
      <div className="sidebar-divider" />
      <div className="workspace-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
      <label className="sidebar-select"><span className="sr-only">Текущий проект</span><span className="project-glyph"><Globe2 size={18} /></span><select value={projectId} onChange={(event) => { setProjectId(event.target.value); setProjectsView(false); }} aria-label="Текущий проект"><option value="" disabled>Выберите проект</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={14} /></label>
      <nav aria-label="Разделы мира">{navigation.map(({ id, label, icon: Icon }) => <button key={id} aria-label={label} title={label} className={`nav-item ${section === id && !projectsView ? "active" : ""}`} onClick={() => openSection(id)}><Icon size={18} /><span>{label}</span>{id === "characters" && data && <span className="nav-count">{data.characters.length}</span>}</button>)}</nav>
      <div className="sidebar-divider" />
      <div className="workspace-label">БУДУЩИЕ ГЛАВЫ</div>
      <div className="planned-feature"><Globe2 size={16} /><span>Атлас мира</span><small>Позже</small></div>
      <div className="planned-feature"><BookOpen size={16} /><span>Энциклопедия</span><small>Позже</small></div>
      <div className="sidebar-bottom"><div className="private-note"><Shield size={15} /><span>Ваши миры приватны</span></div><div className="author-credit">Создано <strong>ElpisHeart</strong><span>LORE STUDIO · ИСТОРИИ И ВЕТКИ</span></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><span>{project?.name || "Мои проекты"}</span><ChevronRight size={13} /><strong>{projectsView ? "Все проекты" : world?.name || "Рабочее пространство"}</strong></div><div className="top-actions"><span className="saved-indicator"><span />{busy ? "Сохраняем…" : "Изменения сохранены"}</span><button className="icon-button" aria-label={theme === "dark" ? "Светлая тема" : "Тёмная тема"} title="Сменить тему" onClick={toggleTheme}>{theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}</button><span className="topbar-separator" /><span className="user-avatar" title={user.name}>{letters(user.name)}</span><button className="icon-button" aria-label="Выйти" onClick={() => run(async () => { await api("/auth/logout", "POST", {}); setUser(null); setProjects([]); setData(null); setProjectId(""); })}><LogOut size={17} /></button></div></header>
      <main className="workspace">
        {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="Закрыть ошибку"><X size={16} /></button></div>}
        {notice && <div className="toast" role="status"><Check size={17} />{notice}</div>}
        {projectsView || !projects.length && !loading ? <>
          <div className="page-heading"><div><p className="eyebrow">КАЖДАЯ ИСТОРИЯ НАЧИНАЕТСЯ С ИДЕИ</p><h1>Ваши вселенные<span className="heading-dot" aria-hidden="true">.</span></h1><p className="subtitle">Место, где замыслы обретают собственную историю.</p></div><button className="button primary" onClick={() => setEditor({ kind: "project" })}><Plus size={17} />Создать проект</button></div>
          <div className="project-grid">{projects.map((item, index) => <article className={`project-card tone-${index % 4}`} key={item.id}><div className="project-card-art"><OrbitArtwork /><span className="pill"><Shield size={12} />Приватный проект</span></div><div className="project-card-body"><button className="project-title" onClick={() => { setProjectId(item.id); setProjectsView(false); setSection("overview"); }}>{item.name}<ArrowRight size={18} /></button><p>{item.description || "Новая вселенная, ожидающая своей истории."}</p><div className="card-footer"><span>Автор: {user.name}</span><div><button className="icon-button" aria-label={`Настройки проекта ${item.name}`} onClick={() => setEditor({ kind: "project", value: item })}><Pencil size={15} /></button><button className="icon-button danger" aria-label={`Удалить проект ${item.name}`} disabled={busy} onClick={() => remove("project", item.id, item.name)}><Trash2 size={15} /></button></div></div></div></article>)}</div>
          <div className="demo-callout"><span className="callout-icon"><Sparkles size={25} /></span><div><h3>Загляните в Элирию</h3><p>Познакомьтесь с мастерской на примере мира, его героев и событий. Это будет ваша личная копия.</p></div><button className="button secondary" disabled={busy} onClick={createDemo}>Открыть демомир<ArrowRight size={16} /></button></div>
        </> : <>
          <div className="context-row"><label><span className="context-label">МИР</span><span className="world-switch"><Globe2 size={15} /><select aria-label="Текущий мир" value={worldId} disabled={busy} onChange={(event) => setWorldId(event.target.value)}><option value="" disabled>Выберите мир</option>{worlds.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={13} /></span></label><button className="text-button" onClick={() => setEditor({ kind: "world" })}><Plus size={15} />Новый мир</button>{world && <button className="icon-button" aria-label="Настройки мира" onClick={() => setEditor({ kind: "world", value: world })}><MoreHorizontal size={19} /></button>}<span className="context-spacer" /><span className="pill subtle"><GitBranch size={12} />{data?.history?.timeline.name || "Основная история"}</span></div>
          {data?.history && <HistoryControls context={data.history} calendarId={calendarId} onCalendarChange={(id) => { setCalendarId(id); rememberContext(data.history!.timeline.id, data.history!.day, id); }} onChange={changeHistory} onNew={() => setHistoryDialog("new")} onManage={() => setHistoryDialog("manage")} onCompare={() => setHistoryDialog("compare")} busy={busy} />}
          {loading ? <div className="loading-state"><LoaderCircle className="spin" size={25} /><p>Загружаем историю…</p></div> : !world ? <Empty icon={Globe2} title="Дайте миру имя" description="В проекте может быть несколько миров. Создайте первый, чтобы начать собирать его историю."><button className="button primary" onClick={() => setEditor({ kind: "world" })}><Plus size={16} />Создать мир</button></Empty> : data ? <>
            {section === "family" ? <FamilyView characters={data.characters} relations={data.relations} day={data.history?.day ?? null} calendar={selectedCalendar} onAdd={() => setEditor({ kind: "relation", family: true })} onCharacter={(character) => setEditor({ kind: "character", value: character })} /> : section === "calendars" ? <CalendarWorkspace worldId={worldId} calendars={data.history?.calendars || []} onCreated={calendarCreated} /> : section === "overview" ? <>
              <div className="world-hero"><div className="hero-content"><span className="hero-eyebrow"><span />ВАША ВСЕЛЕННАЯ</span><h1>{world.name}</h1><p>{world.description || "У каждого мира есть история. Напишите свою."}</p><div className="hero-footer"><span><Shield size={14} />Приватный мир</span><span><Feather size={14} />{user.name}</span></div></div><div className="hero-art"><OrbitArtwork /></div><button className="hero-edit icon-button" aria-label="Редактировать мир" onClick={() => setEditor({ kind: "world", value: world })}><Pencil size={16} /></button></div>
              <div className="stats-grid"><Stat label="Персонажи" count={data.characters.length} icon={Users} note="Герои вашей истории" onClick={() => openSection("characters")} /><Stat label="События" count={data.events.length} icon={Clock3} note="Моменты, меняющие мир" onClick={() => openSection("events")} /><Stat label="Отношения" count={data.relations.length} icon={GitBranch} note="Переплетённые судьбы" onClick={() => openSection("relations")} /></div>
              <div className="overview-columns"><section><div className="section-heading"><h2>Лица вашей истории</h2><button className="text-button" onClick={() => openSection("characters")}>Все персонажи<ArrowRight size={15} /></button></div><div className="character-preview-grid">{data.characters.slice(0, 3).map((c, index) => <CharacterCard key={c.id} character={c} index={index} onClick={() => setEditor({ kind: "character", value: c })} />)}<button className="add-character-card" onClick={() => setEditor({ kind: "character" })}><span><Plus size={22} /></span><strong>Новый персонаж</strong><small>У каждой истории есть герой</small></button></div></section><section className="timeline-preview"><div className="section-heading"><h2>Страницы истории</h2><button className="icon-button" aria-label="Добавить событие" onClick={() => setEditor({ kind: "event" })}><Plus size={19} /></button></div>{data.events.length ? <div className="mini-timeline">{[...data.events].sort((a, b) => a.startYear - b.startYear).slice(0, 4).map((event) => <button key={event.id} onClick={() => setEditor({ kind: "event", value: event })}><span className="timeline-dot" /><small>{year(event.startYear)}</small><strong>{event.name}</strong><span>{event.type}</span></button>)}</div> : <p className="muted empty-copy">Пока здесь чистая страница. Добавьте первое событие.</p>}<button className="timeline-link text-button" onClick={() => openSection("events")}>Открыть хронологию<ArrowRight size={15} /></button></section></div>
              <div className="workspace-tip"><Feather size={20} /><p><strong>Большие миры растут из маленьких деталей.</strong> Добавьте биографию герою или событие в историю — всё останется в вашей вселенной.</p></div>
            </> : <>
              <div className="page-heading entity-heading"><div><p className="eyebrow">{world.name} / {data.history?.timeline.name || "ОСНОВНАЯ ИСТОРИЯ"}</p><h1>{sectionTitles[section]}<span className="heading-dot" aria-hidden="true">.</span></h1><p className="subtitle">{section === "characters" ? "Герои, чьи решения создают историю." : section === "events" ? "События, которые сделали ваш мир таким, какой он есть." : "Дружба, соперничество и всё, что связывает героев."}</p></div><button className="button primary" disabled={section === "relations" && data.characters.length < 2} onClick={() => setEditor({ kind: section === "characters" ? "character" : section === "events" ? "event" : "relation" })}><Plus size={17} />{section === "characters" ? "Создать персонажа" : section === "events" ? "Добавить событие" : "Добавить отношение"}</button></div>
              <div className="list-toolbar"><div className="search-field"><Search size={17} /><input aria-label="Поиск" placeholder={section === "characters" ? "Найти персонажа…" : section === "events" ? "Найти событие…" : "Найти отношение…"} value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button aria-label="Очистить поиск" onClick={() => setQuery("")}><X size={14} /></button>}</div><span>{section === "characters" ? `${filteredCharacters.length} персонажей` : section === "events" ? `${filteredEvents.length} событий · по годам` : `${filteredRelations.length} отношений`}</span></div>
              {section === "characters" && (filteredCharacters.length ? <div className="characters-grid">{filteredCharacters.map((c, index) => <CharacterCard key={c.id} character={c} index={index} onClick={() => setEditor({ kind: "character", value: c })} />)}</div> : <Empty icon={Users} title={query ? "Персонажи не найдены" : "Познакомимся с первым героем?"} description={query ? "Попробуйте изменить поисковый запрос." : "Создайте персонажа, опишите его характер, мечты и историю."} />)}
              {section === "events" && (filteredEvents.length ? <div className="full-timeline">{filteredEvents.map((event) => <article className="event-row" key={event.id}><div className="event-date"><strong>{year(event.startYear)}</strong>{event.endYear !== null && <small>до {year(event.endYear)}</small>}</div><span className="event-marker" /><button className="event-card" onClick={() => setEditor({ kind: "event", value: event })}><div className="event-card-top"><span className="event-type">{event.type || "Событие"}</span><span className={`status-badge ${event.status}`}>{statusLabel(event.status)}</span></div><h3>{event.name}</h3><p>{event.description || "Описание ещё не добавлено."}</p>{event.characterIds.length > 0 && <div className="participant-tags">{event.characterIds.map((id) => <span key={id}><Users size={11} />{characterName(id)}</span>)}</div>}</button></article>)}</div> : <Empty icon={Clock3} title={query ? "События не найдены" : "Запишите первое событие"} description={query ? "Попробуйте изменить поисковый запрос." : "Основание королевства, встреча или великая битва — ваша история начинается здесь."} />)}
              {section === "relations" && (filteredRelations.length ? <div className="relations-list">{filteredRelations.map((relation) => <button className="relation-card" key={relation.id} onClick={() => setEditor({ kind: "relation", value: relation })}><div className="relation-person"><span className="person-avatar">{letters(characterName(relation.fromId))}</span><strong>{characterName(relation.fromId)}</strong></div><div className="relation-kind"><span>{relation.kind}</span><div>{relation.mutual ? <Link2 size={18} /> : <ArrowRight size={18} />}</div><small>{relation.startYear === null ? "Начало не указано" : year(relation.startYear)}{relation.endYear !== null && ` — ${year(relation.endYear)}`}</small></div><div className="relation-person"><span className="person-avatar secondary-avatar">{letters(characterName(relation.toId))}</span><strong>{characterName(relation.toId)}</strong></div><Pencil size={15} className="relation-edit" /></button>)}</div> : <Empty icon={GitBranch} title={query ? "Отношения не найдены" : "Соедините судьбы героев"} description={data.characters.length < 2 ? "Для отношения нужны хотя бы два персонажа. Сначала создайте их в разделе «Персонажи»." : "Добавьте дружбу, вражду, союз или собственный тип отношения."} />)}
            </>}
          </> : <Empty icon={CircleHelp} title="Не удалось загрузить мир" description="Проверьте соединение и попробуйте обновить данные."><button className="button secondary" onClick={() => run(refreshWorld)}>Повторить</button></Empty>}
        </>}
      </main><footer className="workspace-footer"><span>Lore Studio</span><span>Мир начинается с вас.</span><span>Автор · ElpisHeart</span></footer>
    </div>
    {data?.history && historyDialog !== null && (historyDialog === "compare" ? <CompareDialog context={data.history} calendar={selectedCalendar} onTransferred={refreshWorld} onClose={() => setHistoryDialog(null)} /> : <TimelineDialog worldId={worldId} context={data.history} calendar={selectedCalendar} editing={historyDialog === "manage"} onSaved={timelineSaved} onClose={() => setHistoryDialog(null)} />)}
    {editor && <EntityEditor history={data?.history ? { timelineId: data.history.timeline.id, calendar: selectedCalendar, label: `${data.history.timeline.name} · ${historicalDate(data.history.day, selectedCalendar)}` } : undefined} readOnly={Boolean(beforeFork)} error={error} editor={editor} characters={data?.characters || []} busy={busy} onSave={saveEditor} onClose={() => !busy && setEditor(null)} onDelete={editor.value ? () => remove(editor.kind, editor.value!.id, "name" in editor.value! ? editor.value!.name : "Отношение") : undefined} />}
  </div>;
}

function Stat({ label, count, icon: Icon, note, onClick }: { label: string; count: number; icon: typeof Compass; note: string; onClick: () => void }) {
  return <button className="stat-card" onClick={onClick}><div><span className="stat-label">{label}</span><strong>{count.toString().padStart(2, "0")}</strong><small>{note}</small></div><span className="stat-icon"><Icon size={21} /></span><ArrowRight size={15} className="stat-arrow" /></button>;
}
function CharacterCard({ character, index, onClick }: { character: Character; index: number; onClick: () => void }) {
  return <button className={`character-card tone-${index % 4}`} onClick={onClick}><div className="portrait"><div className="portrait-orbit" /><span className="portrait-monogram">{letters(character.name)}</span><span className={`status-badge ${character.status}`}>{statusLabel(character.status)}</span></div><div className="character-card-body"><small>{character.species || "Персонаж"}</small><h3>{character.name}</h3><p>{character.title || character.biography || "История ещё не написана"}</p><span className="card-open">Открыть карточку<ArrowRight size={14} /></span></div></button>;
}
function Empty({ icon: Icon, title, description, children }: { icon: typeof Compass; title: string; description: string; children?: ReactNode }) {
  return <div className="empty-state"><span><Icon size={29} strokeWidth={1.3} /></span><h2>{title}</h2><p>{description}</p>{children}</div>;
}
function OrbitArtwork() {
  return <svg viewBox="0 0 480 360" fill="none" aria-hidden="true"><circle cx="245" cy="180" r="105" stroke="currentColor" strokeWidth=".6" /><circle cx="245" cy="180" r="145" stroke="currentColor" strokeWidth=".5" strokeDasharray="2 8" /><ellipse cx="245" cy="180" rx="175" ry="60" transform="rotate(-35 245 180)" stroke="currentColor" strokeWidth=".7" /><ellipse cx="245" cy="180" rx="70" ry="135" transform="rotate(-35 245 180)" stroke="currentColor" strokeWidth=".6" /><path d="M245 66L265 160L357 180L265 200L245 294L225 200L133 180L225 160L245 66Z" fill="currentColor" fillOpacity=".1" stroke="currentColor" strokeWidth=".7" /><path d="M245 119L253 172L305 180L253 188L245 241L237 188L185 180L237 172L245 119Z" fill="currentColor" fillOpacity=".45" /><circle cx="245" cy="180" r="7" fill="currentColor" /><circle cx="378" cy="90" r="4" fill="currentColor" /><circle cx="93" cy="252" r="3" fill="currentColor" /><path d="M93 64V78M86 71H100M367 278V292M360 285H374" stroke="currentColor" /><circle cx="165" cy="51" r="1.5" fill="currentColor" /><circle cx="419" cy="223" r="1.5" fill="currentColor" /></svg>;
}

function AuthScreen({ onAuth, theme, toggleTheme, initialError }: { onAuth: (user: User) => void; theme: string; toggleTheme: () => void; initialError: string }) {
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const fields = new FormData(event.currentTarget);
    try { const result = await api<{ user: User }>(register ? "/auth/register" : "/auth/login", "POST", { ...(register ? { name: fields.get("name") } : {}), email: fields.get("email"), password: fields.get("password") }); onAuth(result.user); }
    catch (err) { setError(err instanceof Error ? err.message : "Не удалось войти"); } finally { setBusy(false); }
  }
  return <main className="auth-shell"><section className="auth-story"><Brand /><div className="auth-constellation"><OrbitArtwork /></div><div className="auth-story-copy"><span className="eyebrow">ДЛЯ ТЕХ, КТО СОЗДАЁТ МИРЫ</span><h1>У каждой вселенной<br />есть <em>свой автор.</em></h1><p>Дайте героям имена. Соедините их судьбы.<br />Сохраните историю, которую можете рассказать только вы.</p><div className="auth-features"><span><Users size={15} />Персонажи</span><span><GitBranch size={15} />Отношения</span><span><Clock3 size={15} />Хронология</span></div></div><div className="auth-credit"><span>LORE STUDIO</span><span>Автор проекта · <strong>ElpisHeart</strong></span></div></section><section className="auth-form-section"><button className="icon-button auth-theme" onClick={toggleTheme} aria-label="Сменить тему">{theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}</button><div className="auth-form-wrap"><div className="auth-small-icon"><Feather size={26} strokeWidth={1.4} /></div><p className="eyebrow">ВАША НОВАЯ ГЛАВА</p><h2>{register ? "Начните свою историю" : "С возвращением"}</h2><p className="subtitle">{register ? "Создайте аккаунт и найдите место для своей вселенной." : "Ваши миры ждут продолжения."}</p><div className="auth-tabs"><button className={!register ? "active" : ""} onClick={() => { setRegister(false); setError(""); }}>Вход</button><button className={register ? "active" : ""} onClick={() => { setRegister(true); setError(""); }}>Регистрация</button></div><form onSubmit={submit} key={register ? "register" : "login"}>{register && <Field label="Ваше имя" name="name" required maxLength={80} autoComplete="name" placeholder="Как к вам обращаться?" />}<Field label="Электронная почта" name="email" type="email" required maxLength={254} autoComplete="email" placeholder="author@example.com" /><Field label="Пароль" name="password" type="password" required minLength={register ? 10 : undefined} maxLength={128} autoComplete={register ? "new-password" : "current-password"} placeholder={register ? "Не менее 10 символов" : "Ваш пароль"} />{error && <div className="form-error" role="alert">{error}</div>}<button className="button primary auth-submit" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : null}{register ? "Создать аккаунт" : "Войти в мастерскую"}<ArrowRight size={17} /></button></form><p className="auth-privacy"><Shield size={14} />Проекты видны только вам. Без платных API.</p><p className="auth-bottom">Мастерская миров <span>·</span> ElpisHeart</p></div></section></main>;
}

type FieldProps = { label: string } & React.InputHTMLAttributes<HTMLInputElement>;
function Field({ label, name, ...props }: FieldProps) { return <label className="field"><span>{label}{props.required && <b aria-hidden="true"> *</b>}</span><input name={name} {...props} /></label>; }
function TextArea({ label, name, value = "", rows = 4, placeholder = "", maxLength = 40000 }: { label: string; name: string; value?: string; rows?: number; placeholder?: string; maxLength?: number }) { return <label className="field"><span>{label}</span><textarea name={name} defaultValue={value} rows={rows} maxLength={maxLength} placeholder={placeholder} /></label>; }
function SelectField({ label, name, value, children }: { label: string; name: string; value?: string; children: ReactNode }) { return <label className="field"><span>{label}</span><select name={name} defaultValue={value}>{children}</select></label>; }
const text = (form: FormData, name: string) => String(form.get(name) || "");
const numberOrNull = (form: FormData, name: string) => text(form, name).trim() === "" ? null : Number(form.get(name));

function EntityEditor({ editor, characters, busy, error, history, readOnly, onSave, onClose, onDelete }: { history?: { timelineId: string; calendar: CalendarDefinition; label: string }; readOnly?: boolean; error: string; editor: Editor; characters: Character[]; busy: boolean; onSave: (data: Record<string, unknown>) => Promise<void>; onClose: () => void; onDelete?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState("main");
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  const char = editor.kind === "character" ? editor.value : undefined;
  const event = editor.kind === "event" ? editor.value : undefined;
  const relation = editor.kind === "relation" ? editor.value : undefined;
  const simple = editor.kind === "project" || editor.kind === "world";
  const title = { project: editor.value ? "Настройки проекта" : "Новый проект", world: editor.value ? "Настройки мира" : "Новый мир", character: editor.value ? "Карточка персонажа" : "Новый персонаж", event: editor.value ? "Историческое событие" : "Новое событие", relation: editor.value ? "Отношение" : "Новое отношение" }[editor.kind];
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = new FormData(e.currentTarget); let payload: Record<string, unknown>;
    if (simple) payload = { name: text(form, "name"), description: text(form, "description") };
    else if (editor.kind === "character") payload = { ...Object.fromEntries(["name", "title", "species", "gender", "appearance", "personality", "biography", "motivation", "abilities", "secrets", "status"].map((key) => [key, text(form, key)])), birthYear: numberOrNull(form, "birthYear"), deathYear: numberOrNull(form, "deathYear") };
    else if (editor.kind === "event") payload = { name: text(form, "name"), type: text(form, "type"), startYear: numberOrNull(form, "startYear"), endYear: numberOrNull(form, "endYear"), description: text(form, "description"), status: text(form, "status"), characterIds: form.getAll("characterIds").map(String) };
    else payload = { fromId: text(form, "fromId"), toId: text(form, "toId"), kind: text(form, "kind"), mutual: form.get("mutual") === "on", startYear: numberOrNull(form, "startYear"), endYear: numberOrNull(form, "endYear"), description: text(form, "description"), familyKind: text(form, "familyKind") };
    await onSave(payload);
  }
  return <dialog ref={dialog} className={`editor-dialog ${simple ? "simple-dialog" : ""}`} onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }} onClick={(e) => { if (e.target === dialog.current && !busy) onClose(); }} aria-labelledby="editor-title"><div className="editor-header"><div><p className="eyebrow">LORE STUDIO / МАСТЕРСКАЯ</p><h2 id="editor-title">{title}</h2></div><button type="button" className="icon-button" disabled={busy} aria-label="Закрыть редактор" onClick={onClose}><X size={21} /></button></div><form onSubmit={submit}><div className="editor-content">
    {simple && <><Field label={editor.kind === "project" ? "Название проекта" : "Название мира"} name="name" defaultValue={editor.value?.name} autoFocus required maxLength={160} placeholder={editor.kind === "project" ? "Название вашей вселенной" : "Например, Элирия"} /><TextArea label="Описание" name="description" value={editor.value?.description} maxLength={10000} placeholder="О чём этот мир?" /><p className="field-hint"><Shield size={13} />{editor.kind === "project" ? "Проект будет приватным. Все данные доступны только вам." : "Мир будет доступен только участникам этого приватного проекта."}</p></>}
    {editor.kind === "character" && <><div className="editor-tabs" role="tablist" aria-label="Разделы карточки">{[["main", "Основное"], ["story", "История и характер"], ["secrets", "Способности и тайны"], ...(char && history ? [["history", "История состояний"]] : [])].map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}</div><div hidden={tab !== "main"}><Field label="Имя персонажа" name="name" defaultValue={char?.name} required maxLength={160} autoFocus placeholder="Как зовут вашего героя?" /><Field label="Титул или прозвище" name="title" defaultValue={char?.title} maxLength={160} placeholder="Хранительница северного света" /><div className="form-columns"><Field label="Раса / вид" name="species" defaultValue={char?.species} maxLength={160} placeholder="Человек, эльф…" /><Field label="Пол" name="gender" defaultValue={char?.gender} maxLength={100} /></div><div className="form-columns"><Field label="Год рождения" name="birthYear" type="number" step="1" min={-1000000000} max={1000000000} defaultValue={char?.birthYear ?? ""} /><Field label="Год смерти" name="deathYear" type="number" step="1" min={-1000000000} max={1000000000} defaultValue={char?.deathYear ?? ""} /></div><SelectField label="Статус" name="status" value={char?.status || "draft"}><option value="draft">Черновик</option><option value="canon">Канон</option></SelectField><TextArea label="Внешность" name="appearance" value={char?.appearance} rows={3} /></div><div hidden={tab !== "story"}><TextArea label="Биография" name="biography" value={char?.biography} rows={9} placeholder="С чего началась история героя?" /><TextArea label="Характер" name="personality" value={char?.personality} /><TextArea label="Цели и мотивация" name="motivation" value={char?.motivation} /></div><div hidden={tab !== "secrets"}><TextArea label="Способности и навыки" name="abilities" value={char?.abilities} rows={6} /><TextArea label="Секретные сведения" name="secrets" value={char?.secrets} rows={6} /><p className="field-hint"><Shield size={13} />Все данные проекта, включая секреты, приватны.</p></div>{char && history && <div hidden={tab !== "history"}><RevisionHistory kind="character" id={char.id} timelineId={history.timelineId} calendar={history.calendar} /></div>}<p className="field-hint">Годы рождения и смерти — григорианские годы; календарь просмотра управляет датой исторического состояния.</p></>}
    {editor.kind === "event" && <><Field label="Название события" name="name" defaultValue={event?.name} autoFocus required maxLength={160} placeholder="Первый рассвет Элирии" /><div className="form-columns"><Field label="Тип события" name="type" defaultValue={event?.type || "Событие"} maxLength={160} placeholder="Основание, встреча, битва…" /><SelectField label="Статус" name="status" value={event?.status || "draft"}><option value="draft">Черновик</option><option value="canon">Канон</option></SelectField></div><div className="form-columns"><Field label="Год начала" name="startYear" type="number" step="1" required min={-1000000000} max={1000000000} defaultValue={event?.startYear ?? ""} /><Field label="Год окончания" name="endYear" type="number" step="1" min={-1000000000} max={1000000000} defaultValue={event?.endYear ?? ""} /></div><p className="field-hint">Григорианские годы, включая отрицательные. Пустой год окончания означает точечное событие.</p><TextArea label="Описание события" name="description" value={event?.description} rows={6} /><fieldset className="participants-field"><legend>Участники</legend>{characters.length ? characters.map((c) => <label key={c.id}><input type="checkbox" name="characterIds" value={c.id} defaultChecked={event?.characterIds.includes(c.id)} /><span>{c.name}</span></label>) : <p className="muted">Добавьте персонажей, чтобы связать их с событием.</p>}</fieldset></>}
    {editor.kind === "relation" && <><div className="form-columns"><SelectField label="От персонажа" name="fromId" value={relation?.fromId || characters[0]?.id}>{characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField><SelectField label="К персонажу" name="toId" value={relation?.toId || characters[1]?.id}>{characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField></div><SelectField label="Семейная связь" name="familyKind" value={relation?.familyKind || (editor.family ? "parent" : "other")}><option value="other">Обычное отношение</option><option value="parent">Родитель → ребёнок</option><option value="adoptive_parent">Усыновитель → ребёнок</option><option value="spouse">Брак</option></SelectField><p className="field-hint">Для происхождения первый персонаж — родитель, второй — ребёнок. Братья и сёстры вычисляются автоматически.</p><Field label="Тип отношения" name="kind" defaultValue={relation?.kind} autoFocus required maxLength={100} list="relation-types" placeholder="Дружба, союз, вражда…" /><datalist id="relation-types"><option>Дружба</option><option>Любовь</option><option>Вражда</option><option>Родство</option><option>Политический союз</option><option>Наставничество</option></datalist><label className="checkbox-field"><input type="checkbox" name="mutual" defaultChecked={relation?.mutual ?? true} /><span>Взаимное отношение</span></label><div className="form-columns"><Field label="Год начала" name="startYear" type="number" step="1" min={-1000000000} max={1000000000} defaultValue={relation?.startYear ?? ""} /><Field label="Год окончания" name="endYear" type="number" step="1" min={-1000000000} max={1000000000} defaultValue={relation?.endYear ?? ""} /></div><TextArea label="Описание отношения" name="description" value={relation?.description} rows={5} /><p className="field-hint">Годы начала и окончания — григорианские. Связь отображается в древе и выбранной временной линии.</p></>}
  {history && !simple && <p className="history-editor-context"><GitBranch size={13} />{history.label}</p>}
  {history && editor.value && (editor.kind === "event" || editor.kind === "relation") && <details className="entity-history-details"><summary>История состояний</summary><RevisionHistory kind={editor.kind} id={editor.value.id} timelineId={history.timelineId} calendar={history.calendar} /></details>}
  {readOnly && !simple && <p className="form-error" role="status">До даты ответвления доступен просмотр. Для правок выберите более позднюю дату.</p>}
  {error && <div className="form-error" role="alert">{error}</div>}</div><div className="editor-footer">{onDelete && <button type="button" disabled={busy || readOnly && !simple} className="button danger-quiet" onClick={onDelete}><Trash2 size={15} />Удалить</button>}<span /><button type="button" className="button secondary" onClick={onClose} disabled={busy}>Отмена</button><button className="button primary" disabled={busy || readOnly && !simple}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{busy ? "Сохранение…" : "Сохранить"}</button></div></form></dialog>;
}
