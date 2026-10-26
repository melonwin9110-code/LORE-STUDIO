"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, BookOpen, Check, Clock3, Eye, FileText, GitBranch, History, Link2, List, LoaderCircle, Map as MapIcon, Pencil, Plus, Save, Search, Shield, Tags, Trash2, Users, X } from "lucide-react";
import type { CalendarDefinition } from "@/lib/calendar";
import type { HistoryContext, Revision } from "@/lib/history-types";
import type { MapData, MapFeature, MapGeometry } from "@/lib/map-types";
import type { WikiArticle, WikiArticleInput, WikiEntry, WikiEntryKind, WikiFact, WikiHistory, WikiImage, WikiIndex, WikiKnowledge, WikiPage } from "@/lib/wiki-types";
import { EMPTY_WIKI_DOCUMENT, wikiCanonicalJson, wikiDocumentHeadings } from "@/lib/wiki-document";
import { HistoryApiError, historyApi } from "./history-api";
import { historicalDate } from "./history-controls";
import { HistoryDialog } from "./history-dialogs";
import { WikiDocumentView, WikiEditor } from "./wiki-editor";
import styles from "./wiki-workspace.module.css";

type Props = {
  worldId: string; context: HistoryContext; canEdit: boolean; onChanged: () => Promise<void>; calendar: CalendarDefinition;
  onNavigationGuard?: (guard: (() => boolean) | null) => void; onDirtyChange?: (dirty: boolean) => void;
};
type Draft = { input: WikiArticleInput; tagsText: string; id: string | null; version: number | null; original: string | null; context: string };
const kindLabels: Record<WikiEntryKind, string> = { articles: "Статья", characters: "Персонаж", events: "Событие", maps: "Карта", map_features: "Место" };
const knowledgeLabels: Record<WikiKnowledge, string> = { fact: "Факт", legend: "Легенда", rumor: "Слух", hypothesis: "Гипотеза", secret: "Тайна" };
const kindIcons = { articles: FileText, characters: Users, events: Clock3, maps: MapIcon, map_features: MapIcon };
const emptyIndex: WikiIndex = { entries: [], categories: [], tags: [], revision: "0" };
function inputOf(article: WikiArticle): WikiArticleInput {
  return { title: article.title, summary: article.summary, document: article.document, category: article.category, tags: article.tags, knowledge: article.knowledge, sourceId: article.sourceId };
}
function draftInput(draft: Draft): WikiArticleInput {
  return { ...draft.input, tags: [...new Set(draft.tagsText.split(",").map((tag) => tag.trim()).filter(Boolean))] };
}
function failure(error: unknown) { return error instanceof Error ? error.message : "Не удалось загрузить материал"; }
function portraitOf(facts: WikiFact[]): string | null {
  const value = facts.find((fact) => fact.label === "Портрет")?.value;
  return value && /^\/api\/characters\/[0-9a-f-]{36}\/portrait\?v=\d+$/i.test(value) ? value : null;
}

export function WikiWorkspace({ worldId, context, canEdit, onChanged, calendar, onNavigationGuard, onDirtyChange }: Props) {
  const scope = useMemo(() => "?" + new URLSearchParams({ timeline: context.timeline.id, ...(context.day !== null ? { day: context.day } : {}) }).toString(), [context.timeline.id, context.day]);
  const contextKey = worldId + scope;
  const [indexState, setIndex] = useState<{ key: string; data: WikiIndex }>({ key: "", data: emptyIndex });
  const [pageState, setPage] = useState<{ key: string; data: WikiPage } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState(""), [category, setCategory] = useState(""), [tag, setTag] = useState(""), [kind, setKind] = useState(""), [knowledge, setKnowledge] = useState("");
  const [indexLoading, setIndexLoading] = useState(true), [pageLoading, setPageLoading] = useState(false), [writing, setWriting] = useState(false);
  const [uploads, setUploads] = useState(0), [error, setError] = useState(""), [notice, setNotice] = useState(""), [conflict, setConflict] = useState(false);
  const [draftState, setDraft] = useState<Draft | null>(null), [preview, setPreview] = useState(false);
  const [editorTargets, setEditorTargets] = useState<WikiEntry[]>([]), [historyArticle, setHistoryArticle] = useState<WikiArticle | null>(null);
  const loadedContext = useRef(""), selectedRef = useRef<string | null>(null), requestNumber = useRef(0), indexRequestNumber = useRef(0);
  const index = indexState.key === contextKey ? indexState.data : emptyIndex;
  const page = pageState?.key === contextKey && pageState.data.entry.id === selectedId ? pageState.data : null;
  const draft = draftState?.context === contextKey ? draftState : null;
  const dirty = Boolean(draft && (draft.original === null || wikiCanonicalJson(draftInput(draft)) !== draft.original));
  const busy = writing || uploads > 0 || pageLoading;
  const confirmLeave = useCallback(() => !busy && (!dirty || window.confirm("В статье есть несохранённые изменения. Перейти и оставить их без сохранения?")), [busy, dirty]);
  const filterParams = useCallback(() => {
    const params = new URLSearchParams(scope.slice(1));
    for (const [key, value] of Object.entries({ q: query.trim(), category, tag, kind, knowledge })) if (value) params.set(key, value);
    return "?" + params;
  }, [scope, query, category, tag, kind, knowledge]);

  useEffect(() => { onNavigationGuard?.(confirmLeave); return () => onNavigationGuard?.(null); }, [confirmLeave, onNavigationGuard]);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    let cancelled = false;
    const request = ++indexRequestNumber.current;
    const timer = setTimeout(async () => {
      setIndexLoading(true);
      try {
        const result = await historyApi<WikiIndex>("/worlds/" + worldId + "/wiki" + filterParams());
        if (cancelled || request !== indexRequestNumber.current) return;
        setIndex({ key: contextKey, data: result });
        if (loadedContext.current !== contextKey) {
          loadedContext.current = contextKey;
          setDraft((current) => current?.context === contextKey ? current : null); setPreview(false); setConflict(false); setError(""); setNotice("");
          const next = result.entries.find((entry) => entry.id === selectedRef.current)?.id || result.entries[0]?.id || null;
          selectedRef.current = next; setSelectedId(next);
        } else if (!selectedRef.current && result.entries.length) {
          selectedRef.current = result.entries[0].id; setSelectedId(result.entries[0].id);
        }
      } catch (err) { if (!cancelled && request === indexRequestNumber.current) setError(failure(err)); }
      finally { if (!cancelled && request === indexRequestNumber.current) setIndexLoading(false); }
    }, query ? 180 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [worldId, contextKey, filterParams, query]);
  useEffect(() => {
    if (!selectedId) { Promise.resolve().then(() => setPageLoading(false)); return; }
    let cancelled = false;
    const number = ++requestNumber.current;
    Promise.resolve().then(async () => {
      if (cancelled) return;
      setPageLoading(true);
      try {
        const result = await historyApi<WikiPage>("/worlds/" + worldId + "/wiki/" + selectedId + scope);
        if (!cancelled && number === requestNumber.current) { setPage({ key: contextKey, data: result }); setError(""); }
      } catch (err) { if (!cancelled && number === requestNumber.current) { setPage(null); setError(failure(err)); } }
      finally { if (!cancelled && number === requestNumber.current) setPageLoading(false); }
    });
    return () => { cancelled = true; };
  }, [worldId, scope, contextKey, selectedId]);

  function navigate(id: string) {
    if (!confirmLeave()) return;
    setDraft(null); setPreview(false); setConflict(false); setNotice(""); setError("");
    selectedRef.current = id; setSelectedId(id);
  }
  async function startArticle(source?: WikiEntry) {
    if (!canEdit || !confirmLeave()) return;
    setPageLoading(true); setError("");
    try {
      const all = await historyApi<WikiIndex>("/worlds/" + worldId + "/wiki" + scope);
      // A slower initial library response must not re-initialize this context
      // after the author has already opened and started writing a new article.
      loadedContext.current = contextKey;
      setEditorTargets(all.entries);
      setDraft({ input: { title: source?.title || "", summary: "", document: structuredClone(EMPTY_WIKI_DOCUMENT), category: "", tags: [], knowledge: "fact", sourceId: source?.id || null }, tagsText: "", id: null, version: null, original: null, context: contextKey });
      setPreview(false); setConflict(false); setNotice("");
    } catch (err) { setError(failure(err)); }
    finally { setPageLoading(false); }
  }
  function editArticle() {
    if (!canEdit || !page?.article || !confirmLeave()) return;
    const input = structuredClone(inputOf(page.article));
    setEditorTargets(page.targets);
    setDraft({ input, tagsText: input.tags.join(", "), id: page.article.id, version: page.article.version, original: wikiCanonicalJson(input), context: contextKey });
    setPreview(false); setError(""); setNotice(""); setConflict(false);
  }
  function updateDraft(patch: Partial<WikiArticleInput>) { setDraft((old) => old ? { ...old, input: { ...old.input, ...patch } } : old); }
  function cancelDraft() { if (confirmLeave()) { setDraft(null); setPreview(false); setConflict(false); setError(""); } }
  async function refreshIndex() {
    const request = ++indexRequestNumber.current;
    setIndexLoading(true);
    try {
      const result = await historyApi<WikiIndex>("/worlds/" + worldId + "/wiki" + filterParams());
      if (request !== indexRequestNumber.current) return;
      setIndex({ key: contextKey, data: result });
      return result;
    } finally { if (request === indexRequestNumber.current) setIndexLoading(false); }
  }
  async function saveArticle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!draft || !canEdit || busy || conflict) return;
    setWriting(true); setError("");
    try {
      const input = draftInput(draft);
      const result = await historyApi<WikiPage>(draft.id ? "/wiki-articles/" + draft.id + scope : "/worlds/" + worldId + "/wiki" + scope, draft.id ? "PATCH" : "POST", { ...input, ...(draft.id ? { version: draft.version } : {}) });
      selectedRef.current = result.entry.id; setSelectedId(result.entry.id); setPage({ key: contextKey, data: result });
      setDraft(null); setPreview(false); setConflict(false); setNotice("Статья сохранена в выбранной линии и дате");
      await refreshIndex(); await onChanged();
    } catch (err) { setError(failure(err)); if (err instanceof HistoryApiError && err.status === 409) setConflict(true); }
    finally { setWriting(false); }
  }
  async function reloadArticle() {
    if (!page?.article || !confirmLeave()) return;
    setWriting(true); setError("");
    try {
      const result = await historyApi<WikiPage>("/worlds/" + worldId + "/wiki/" + page.entry.id + scope);
      setPage({ key: contextKey, data: result }); setDraft(null); setConflict(false); setPreview(false); setNotice("Сохранённая статья загружена"); await refreshIndex();
    } catch (err) { setError(failure(err)); }
    finally { setWriting(false); }
  }
  async function removeArticle() {
    if (!canEdit || !page?.article || !confirmLeave() || !window.confirm("Удалить статью «" + page.article.title + "» в выбранной линии? Предыдущие редакции сохранятся.")) return;
    setWriting(true); setError("");
    try {
      await historyApi("/wiki-articles/" + page.article.id + scope, "DELETE", { version: page.article.version });
      setPage(null); selectedRef.current = null; setSelectedId(null); setDraft(null); setConflict(false); setNotice("Статья удалена. Её прежние состояния сохранены в истории.");
      const result = await refreshIndex();
      if (!result) return;
      const next = result.entries[0]?.id || null; selectedRef.current = next; setSelectedId(next); await onChanged();
    } catch (err) { setError(failure(err)); if (err instanceof HistoryApiError && err.status === 409) setConflict(true); }
    finally { setWriting(false); }
  }
  async function uploadImage(file: File): Promise<WikiImage> {
    if (!canEdit || writing) throw new Error("Сейчас нельзя загрузить изображение");
    if (file.size > 5 * 1024 * 1024) throw new Error("Изображение должно быть не больше 5 МиБ");
    setUploads((old) => old + 1);
    try {
      const response = await fetch("/api/worlds/" + worldId + "/wiki/images", { method: "POST", credentials: "same-origin", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Не удалось загрузить изображение");
      return result as WikiImage;
    } finally { setUploads((old) => old - 1); }
  }
  const targets = draft ? editorTargets : page?.targets || index.entries;
  const headings = page?.article ? wikiDocumentHeadings(page.article.document) : [];
  const renderEmbed = (embedKind: "characterCard" | "mapEmbed", id: string) => <LoreEmbed key={embedKind + id} kind={embedKind} id={id} worldId={worldId} scope={scope} onNavigate={navigate} />;
  const source = draft?.input.sourceId ? editorTargets.find((entry) => entry.id === draft.input.sourceId) : undefined;

  return <section className={styles.workspace} aria-label="Энциклопедия мира">
    <div className={"page-heading entity-heading " + styles.heading}><div><p className="eyebrow">БИБЛИОТЕКА ВАШЕЙ ВСЕЛЕННОЙ</p><h1>Энциклопедия<span className="heading-dot" aria-hidden="true">.</span></h1><p className="subtitle">Факты мира и истории, которые вы хотите рассказать.</p></div>{canEdit && <button className="button primary" disabled={busy} onClick={() => void startArticle()}><Plus size={16} />Новая статья</button>}</div>
    <div className={styles.contextNote}><GitBranch size={14} /><span>{context.timeline.name}</span><span className={styles.contextDate}>{historicalDate(context.day, calendar)}</span><Shield size={13} /><span>Приватная энциклопедия</span></div>
    {error && <div className={styles.error} role="alert"><span>{error}</span>{conflict && <button className="button secondary" disabled={busy} onClick={() => void reloadArticle()}>Перечитать статью</button>}</div>}
    {notice && <p className={styles.success} role="status"><Check size={15} />{notice}</p>}
    {!canEdit && <p className={styles.readOnly}><Eye size={14} />Доступен просмотр материалов. Редактирование зависит от прав проекта и выбранной исторической даты.</p>}
    <div className={styles.layout}>
      <aside className={styles.library} aria-label="Библиотека материалов">
        <div className={styles.libraryHeading}><BookOpen size={17} /><h2>Материалы</h2><span>{index.entries.length}</span>{indexLoading && <LoaderCircle size={13} className="spin" />}</div>
        <div className={styles.search}><Search size={15} /><input type="search" aria-label="Поиск по энциклопедии" placeholder="Найти в названии и тексте…" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />{query && <button aria-label="Очистить поиск энциклопедии" onClick={() => setQuery("")}><X size={14} /></button>}</div>
        <details className={styles.filters}><summary><List size={14} />Фильтры<span>{[category, tag, kind, knowledge].filter(Boolean).length || ""}</span></summary><div>
          <label><span>Категория</span><select aria-label="Категория материалов" value={category} onChange={(event) => setCategory(event.currentTarget.value)}><option value="">Все категории</option>{index.categories.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span>Тег</span><select aria-label="Метка материалов" value={tag} onChange={(event) => setTag(event.currentTarget.value)}><option value="">Все теги</option>{index.tags.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span>Тип</span><select aria-label="Тип материалов" value={kind} onChange={(event) => setKind(event.currentTarget.value)}><option value="">Статьи и объекты</option>{Object.entries(kindLabels).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
          <label><span>Характер сведений</span><select aria-label="Характер сведений" value={knowledge} onChange={(event) => setKnowledge(event.currentTarget.value)}><option value="">Все сведения</option>{Object.entries(knowledgeLabels).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
          {[category, tag, kind, knowledge].some(Boolean) && <button className="text-button" onClick={() => { setCategory(""); setTag(""); setKind(""); setKnowledge(""); }}>Сбросить фильтры</button>}
        </div></details>
        <div className={styles.entries}>{index.entries.length ? index.entries.map((entry) => { const Icon = kindIcons[entry.kind]; return <button key={entry.id} className={selectedId === entry.id ? styles.selectedEntry : ""} aria-label={"Открыть материал " + entry.title} aria-current={selectedId === entry.id ? "page" : undefined} disabled={busy} onClick={() => navigate(entry.id)}><span className={styles.entryIcon}><Icon size={17} strokeWidth={1.4} /></span><span><strong>{entry.title}</strong><small>{kindLabels[entry.kind]}{entry.category ? " · " + entry.category : ""}</small>{entry.summary && <span className={styles.entrySummary}>{entry.summary}</span>}</span></button>; }) : <div className={styles.libraryEmpty}><Search size={23} strokeWidth={1.2} /><p>{indexLoading ? "Открываем библиотеку…" : query || category || tag || kind || knowledge ? "По вашему запросу материалов нет." : "Здесь появятся статьи и карточки объектов мира."}</p></div>}</div>
        <p className={styles.libraryHint}>Карточки объектов собираются из данных выбранной линии. Авторские статьи хранятся отдельно.</p>
      </aside>
      <div className={styles.readingArea}>
        {draft ? <form className={styles.editor} aria-label="Редактор статьи" onSubmit={(event) => void saveArticle(event)}>
          <div className={styles.editorTop}><span><Pencil size={14} />{draft.id ? "Редактирование статьи" : "Новая авторская статья"}</span><span className={dirty ? styles.unsaved : ""}>{dirty ? "Есть несохранённые изменения" : "Все изменения сохранены"}</span></div>
          <fieldset disabled={!canEdit || writing || conflict}><label className={"field " + styles.titleField}><span>Название статьи</span><input aria-label="Название статьи" value={draft.input.title} maxLength={200} required placeholder="Например, Легенда о первом рассвете" onChange={(event) => updateDraft({ title: event.currentTarget.value })} autoFocus /></label><label className="field"><span>Краткое описание</span><textarea aria-label="Краткое описание статьи" value={draft.input.summary} maxLength={4000} rows={2} placeholder="О чём эта страница — в нескольких строках" onChange={(event) => updateDraft({ summary: event.currentTarget.value })} /></label>
            <div className={styles.metadata}><label className="field"><span>Категория</span><input aria-label="Категория статьи" list="wiki-categories" value={draft.input.category} maxLength={80} placeholder="Например, Мифология" onChange={(event) => updateDraft({ category: event.currentTarget.value })} /><datalist id="wiki-categories">{index.categories.map((value) => <option key={value} value={value} />)}</datalist></label><label className="field"><span>Характер сведений</span><select aria-label="Характер сведений статьи" value={draft.input.knowledge} onChange={(event) => updateDraft({ knowledge: event.currentTarget.value as WikiKnowledge })}>{Object.entries(knowledgeLabels).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label><label className="field"><span>Теги через запятую</span><input aria-label="Теги статьи" value={draft.tagsText} maxLength={2000} placeholder="магия, древние времена" onChange={(event) => { const value = event.currentTarget.value; setDraft((old) => old ? { ...old, tagsText: value } : old); }} /></label><label className="field"><span>Связанный объект мира</span><select aria-label="Связанный объект статьи" value={draft.input.sourceId || ""} onChange={(event) => updateDraft({ sourceId: event.currentTarget.value || null })}><option value="">Самостоятельная статья</option>{draft.input.sourceId && !source && <option value={draft.input.sourceId}>Объект недоступен в этом состоянии</option>}{editorTargets.filter((entry) => entry.kind !== "articles").map((entry) => <option key={entry.id} value={entry.id}>{entry.title} · {kindLabels[entry.kind]}</option>)}</select></label></div>
          </fieldset>
          {draft.input.knowledge === "secret" && <p className={styles.fieldHint}><Shield size={13} />«Тайна» — пометка сведений. Материал доступен участникам приватного проекта.</p>}
          <div className={styles.documentHeading}><h2>{preview ? "Предпросмотр" : "Текст статьи"}</h2><button type="button" className="text-button" aria-pressed={preview} disabled={writing || uploads > 0} onClick={() => setPreview((old) => !old)}><Eye size={14} />{preview ? "Вернуться к редактору" : "Предпросмотр"}</button></div>
          {preview ? <div className={styles.preview}><WikiDocumentView document={draft.input.document} targets={targets} onNavigate={navigate} renderEmbed={renderEmbed} /></div> : <WikiEditor value={draft.input.document} onChange={(document) => updateDraft({ document })} targets={targets} disabled={!canEdit || writing || conflict} onUploadImage={uploadImage} />}
          {uploads > 0 && <p role="status" className={styles.fieldHint}><LoaderCircle size={14} className="spin" />Загружаем изображение…</p>}
          <p className={styles.fieldHint}>Текст сохранится в выбранной временной линии. Факты связанного объекта останутся самостоятельными.</p>
          <div className={styles.editorFooter}><button type="button" className="button secondary" disabled={busy} onClick={cancelDraft}><ArrowLeft size={15} />Отмена</button><button className="button primary" disabled={!canEdit || busy || conflict || !dirty}>{writing ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}Сохранить статью</button></div>
        </form> : pageLoading ? <div className={styles.empty}><LoaderCircle className="spin" size={25} /><p>Открываем материал…</p></div> : page ? <article className={styles.page} aria-label="Материал энциклопедии">
          <div className={styles.pageHeading}><div className={styles.pageType}><span><BookOpen size={14} />{kindLabels[page.entry.kind]}</span><span className={styles.knowledgeBadge} data-knowledge={page.entry.knowledge}>{knowledgeLabels[page.entry.knowledge]}</span></div><div className={styles.pageActions}>{page.article && <button className="icon-button" aria-label="История статьи" title="История статьи" disabled={busy} onClick={() => setHistoryArticle(page.article)}><History size={17} /></button>}{canEdit && (page.article ? <><button className="button secondary" disabled={busy} onClick={editArticle}><Pencil size={14} />Редактировать статью</button><button className="icon-button danger" aria-label="Удалить статью" title="Удалить статью" disabled={busy} onClick={() => void removeArticle()}><Trash2 size={16} /></button></> : <button className="button secondary" disabled={busy} onClick={() => void startArticle(page.entry)}><Plus size={14} />Написать статью</button>)}</div></div>
          <h2 className={styles.pageTitle}>{page.entry.title}</h2>{page.entry.summary && <p className={styles.summary}>{page.entry.summary}</p>}
          {(page.entry.category || page.entry.tags.length > 0) && <div className={styles.tags}>{page.entry.category && <span><BookOpen size={12} />{page.entry.category}</span>}{page.entry.tags.map((value) => <button key={value} onClick={() => { setTag(value); const details = document.querySelector("details." + styles.filters); details?.setAttribute("open", ""); }}><Tags size={11} />{value}</button>)}</div>}
          {page.facts.length > 0 && <StructuredFacts page={page} onNavigate={navigate} />}
          {page.article ? <><div className={styles.authorTextHeading}><Pencil size={13} /><span>Авторский текст</span><small>Редакция {page.article.version}</small></div>{headings.length > 1 && <nav className={styles.contents} aria-label="Оглавление статьи"><strong><List size={14} />На этой странице</strong>{headings.map((heading) => <a href={"#" + heading.id} key={heading.id} style={{ paddingLeft: (heading.level - 1) * 12 }}>{heading.text}</a>)}</nav>}<div className={styles.document}><WikiDocumentView document={page.article.document} targets={page.targets} onNavigate={navigate} renderEmbed={renderEmbed} /></div></> : <div className={styles.autoExplanation}><FileText size={20} strokeWidth={1.1} /><div><h3>У каждой детали есть своя история</h3><p>Это карточка объекта мира. Дополните её отдельной статьёй: расскажите легенду, запишите исследование или сохраните неизвестные факты.</p></div></div>}
          <div className={styles.references}><EntryLinks title="Связанные материалы" icon={BookOpen} entries={page.related} onNavigate={navigate} empty="Пока нет связанных материалов." /><EntryLinks title="Ссылаются на эту страницу" icon={Link2} entries={page.backlinks} onNavigate={navigate} empty="Другие статьи пока не ссылаются на эту страницу." /></div>
        </article> : <div className={styles.empty}><BookOpen size={40} strokeWidth={1} /><h2>Начните летопись мира</h2><p>Выберите материал в библиотеке или напишите первую статью. Карточки персонажей, событий и карт появятся здесь автоматически.</p>{canEdit && <button className="button primary" disabled={busy} onClick={() => void startArticle()}><Plus size={15} />Создать статью</button>}</div>}
      </div>
    </div>
    {historyArticle && <ArticleHistory article={historyArticle} scope={scope} calendar={calendar} targets={page?.targets || []} onClose={() => setHistoryArticle(null)} />}
  </section>;
}

function StructuredFacts({ page, onNavigate }: { page: WikiPage; onNavigate: (id: string) => void }) {
  const source = page.article?.sourceId ? page.targets.find((entry) => entry.id === page.article!.sourceId) : null;
  const portrait = portraitOf(page.facts), facts = page.facts.filter((fact) => fact.label !== "Портрет");
  return <section className={styles.facts} aria-label="Структурированные факты"><div className={styles.factsHeading}><span><Shield size={14} />Автоматическая карточка</span>{source && <button className="text-button" onClick={() => onNavigate(source.id)}>{source.title}<Link2 size={12} /></button>}</div><p>Факты выбранной линии и даты. Изменяются в карточке самого объекта.</p><div className={styles.factsBody}>{portrait && <Image className={styles.portrait} src={portrait} unoptimized width={96} height={120} alt={"Портрет: " + (source?.title || page.entry.title)} />}<dl>{facts.map((fact, index) => <div key={fact.label + index}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl></div></section>;
}
function EntryLinks({ title, icon: Icon, entries, onNavigate, empty }: { title: string; icon: typeof BookOpen; entries: WikiEntry[]; onNavigate: (id: string) => void; empty: string }) {
  return <section aria-label={title === "Ссылаются на эту страницу" ? "Обратные ссылки" : title}><h3><Icon size={15} />{title}<span>{entries.length}</span></h3>{entries.length ? <div className={styles.referenceList}>{entries.map((entry) => <button key={entry.id} onClick={() => onNavigate(entry.id)}><strong>{entry.title}</strong><small>{kindLabels[entry.kind]}</small></button>)}</div> : <p>{empty}</p>}</section>;
}
function ArticleHistory({ article, scope, calendar, targets, onClose }: { article: WikiArticle; scope: string; calendar: CalendarDefinition; targets: WikiEntry[]; onClose: () => void }) {
  const [data, setData] = useState<WikiHistory | null>(null), [error, setError] = useState("");
  const [selected, setSelected] = useState<Revision | null>(null);
  useEffect(() => {
    let cancelled = false;
    historyApi<WikiHistory>("/wiki-articles/" + article.id + "/history" + scope).then((result) => { if (!cancelled) setData(result); }).catch((err) => { if (!cancelled) setError(failure(err)); });
    return () => { cancelled = true; };
  }, [article.id, scope]);
  const snapshot = selected?.data as WikiArticleInput | null | undefined;
  return <HistoryDialog title="История статьи" onClose={onClose}><div className="editor-content"><p className="field-hint">{article.title}. Каждое сохранение остаётся отдельной редакцией в истории временной линии.</p>{error ? <p role="alert" className="form-error">{error}</p> : !data ? <LoaderCircle className="spin" size={22} /> : <ol className={styles.historyList}>{data.revisions.map((revision) => <li key={revision.revision}><div><strong>{historicalDate(revision.effectiveDay, calendar)}</strong><span>{revision.deleted ? "Удаление" : "Редакция " + revision.version}</span></div>{revision.data && <><p>{String(revision.data.title || article.title)}</p><button className="text-button" onClick={() => setSelected(revision)}>Просмотреть редакцию {revision.version}</button></>}</li>)}</ol>}{snapshot && <section className={styles.snapshot} aria-label="Просмотр редакции статьи"><div><h3>{snapshot.title}</h3><button className="icon-button" aria-label="Закрыть просмотр редакции" onClick={() => setSelected(null)}><X size={15} /></button></div>{snapshot.summary && <p>{snapshot.summary}</p>}<WikiDocumentView document={snapshot.document} targets={targets} onNavigate={() => {}} /></section>}</div><div className="editor-footer"><span /><button className="button secondary" onClick={onClose}>Закрыть</button></div></HistoryDialog>;
}

function LoreEmbed({ kind, id, worldId, scope, onNavigate }: { kind: "characterCard" | "mapEmbed"; id: string; worldId: string; scope: string; onNavigate: (id: string) => void }) {
  const [state, setState] = useState<{ key: string; page: WikiPage; map: MapData | null } | null>(null), [failed, setFailed] = useState(false);
  const key = worldId + scope + id;
  useEffect(() => {
    let cancelled = false;
    Promise.all([historyApi<WikiPage>("/worlds/" + worldId + "/wiki/" + id + scope), kind === "mapEmbed" ? historyApi<MapData>("/maps/" + id + scope) : Promise.resolve(null)]).then(([page, map]) => { if (!cancelled) { setState({ key, page, map }); setFailed(false); } }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [kind, id, worldId, scope, key]);
  const loaded = state?.key === key ? state : null;
  if (!loaded) return <div className={styles.embed}>{failed ? "Объект недоступен в этом состоянии мира" : "Загружаем карточку…"}</div>;
  const Icon = kind === "mapEmbed" ? MapIcon : Users;
  const portrait = kind === "characterCard" ? portraitOf(loaded.page.facts) : null;
  return <div className={styles.embed}>{loaded.map && <MapPreview data={loaded.map} />}<button onClick={() => onNavigate(id)}>{portrait ? <Image className={styles.embedPortrait} src={portrait} unoptimized width={52} height={66} alt={"Портрет: " + loaded.page.entry.title} /> : <span className={styles.embedIcon}><Icon size={23} strokeWidth={1.2} /></span>}<span className={styles.embedCopy}><small>{kind === "mapEmbed" ? "Карта мира" : "Персонаж"}</small><strong>{loaded.page.entry.title}</strong>{loaded.page.entry.summary && <span>{loaded.page.entry.summary}</span>}</span><Link2 size={14} /></button>{kind === "characterCard" && loaded.page.facts.length > 0 && <dl>{loaded.page.facts.filter((fact) => fact.label !== "Портрет").slice(0, 4).map((fact, index) => <div key={fact.label + index}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>}</div>;
}
const paintOrder: Partial<Record<MapFeature["kind"], number>> = { ocean: 0, sea: 1, continent: 2, island: 3, plain: 4, desert: 5, biome: 6, forest: 7, mountain: 8, lake: 9, river: 10, coastline: 11, road: 12, city: 20, settlement: 20, fortress: 20, port: 20, label: 30 };
function geometryPath(geometry: Exclude<MapGeometry, { type: "Point" }>) {
  const line = (points: number[][], close: boolean) => points.map(([x, y], index) => (index ? "L" : "M") + x + " " + y).join(" ") + (close ? "Z" : "");
  return geometry.type === "LineString" ? line(geometry.coordinates, false) : geometry.type === "Polygon" ? geometry.coordinates.map((ring) => line(ring, true)).join(" ") : geometry.coordinates.flatMap((polygon) => polygon.map((ring) => line(ring, true))).join(" ");
}
function MapPreview({ data }: { data: MapData }) {
  const layers = [...data.layers].filter((layer) => layer.visible && layer.kind !== "political").sort((a, b) => a.order - b.order);
  return <svg className={styles.mapPreview} viewBox={"0 0 " + data.map.width + " " + data.map.height} role="img" aria-label={"Карта " + data.map.name}><rect width={data.map.width} height={data.map.height} fill={data.map.background} /><g transform={"translate(0 " + data.map.height + ") scale(1 -1)"}>{layers.map((layer) => <g key={layer.id} opacity={layer.opacity}>{data.features.filter((feature) => feature.layerId === layer.id).sort((a, b) => (paintOrder[a.kind] ?? 15) - (paintOrder[b.kind] ?? 15)).map((feature) => feature.geometry.type === "Point" ? feature.kind !== "label" && <circle key={feature.id} cx={feature.geometry.coordinates[0]} cy={feature.geometry.coordinates[1]} r={data.map.width / 140} fill={feature.fill} stroke={feature.stroke} vectorEffect="non-scaling-stroke" strokeWidth={feature.strokeWidth} /> : <path key={feature.id} d={geometryPath(feature.geometry)} fill={feature.geometry.type === "LineString" ? "none" : feature.fill} stroke={feature.stroke} strokeWidth={feature.strokeWidth} vectorEffect="non-scaling-stroke" fillRule="evenodd" />)}</g>)}</g></svg>;
}
