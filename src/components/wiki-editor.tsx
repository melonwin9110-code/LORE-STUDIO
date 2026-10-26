"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Node, isNodeSelection, mergeAttributes, type JSONContent, type EditorEvents } from "@tiptap/core";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, useEditorState, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import ImageExtension from "@tiptap/extension-image";
import { Bold, Code2, Image as ImageIcon, Italic, Link2, List, ListOrdered, Map as MapIcon, Minus, Quote, Redo2, Strikethrough, Table2, Underline, Undo2, UserRound, X } from "lucide-react";
import { WIKI_IMAGE_PATH, isSafeWikiLink, wikiCanonicalJson, wikiDocumentSchema, type WikiDocument, type WikiNode } from "@/lib/wiki-document";
import type { WikiEntry, WikiImage } from "@/lib/wiki-types";
import styles from "./wiki-editor.module.css";

const TargetContext = createContext<WikiEntry[]>([]);
function LoreNodeView({ node }: NodeViewProps) {
  const targets = useContext(TargetContext), target = targets.find((entry) => entry.id === node.attrs.targetId);
  const isLink = node.type.name === "loreLink";
  return <NodeViewWrapper as={isLink ? "span" : "div"} className={isLink ? styles.internalLink : styles.editorEmbed} contentEditable={false}>
    {isLink ? <><Link2 size={12} />{target ? String(node.attrs.label || target.title) : "Объект недоступен"}</> : <>{node.type.name === "characterCard" ? <UserRound size={22} /> : <MapIcon size={22} />}<span><small>{node.type.name === "characterCard" ? "КАРТОЧКА ПЕРСОНАЖА" : "ВСТРОЕННАЯ КАРТА"}</small><strong>{target?.title || "Объект недоступен"}</strong></span></>}
  </NodeViewWrapper>;
}
function referenceNode(name: "loreLink" | "characterCard" | "mapEmbed") {
  return Node.create({
    name,
    group: name === "loreLink" ? "inline" : "block",
    inline: name === "loreLink", atom: true, selectable: true,
    addAttributes() {
      return { targetId: { default: null }, ...(name === "loreLink" ? { label: { default: "Ссылка" } } : {}) };
    },
    parseHTML() { return [{ tag: (name === "loreLink" ? "span" : "div") + '[data-wiki-node="' + name + '"]' }]; },
    renderHTML({ HTMLAttributes }) {
      return [name === "loreLink" ? "span" : "div", mergeAttributes(HTMLAttributes, { "data-wiki-node": name }), name === "loreLink" ? String(HTMLAttributes.label || "Ссылка") : name === "characterCard" ? "Карточка персонажа" : "Карта"];
    },
    addNodeView() { return ReactNodeViewRenderer(LoreNodeView); },
  });
}
const LocalImage = ImageExtension.extend({
  addAttributes() { return { src: { default: null }, alt: { default: null }, title: { default: null } }; },
  // Pasting an external image must not initiate an external browser request.
  parseHTML() { return [{ tag: "img[src]", getAttrs: (element) => WIKI_IMAGE_PATH.test(element.getAttribute("src") || "") ? null : false }]; },
});
const kindLabels: Record<WikiEntry["kind"], string> = { characters: "персонаж", events: "событие", maps: "карта", map_features: "место", articles: "статья" };
type InsertMode = "internal" | "external" | "characterCard" | "mapEmbed" | null;
export type WikiEditorProps = {
  value: WikiDocument;
  onChange: (value: WikiDocument) => void;
  targets: WikiEntry[];
  disabled?: boolean;
  onUploadImage?: (file: File) => Promise<WikiImage>;
};

export function WikiEditor({ value, onChange, targets, disabled = false, onUploadImage }: WikiEditorProps) {
  const [insertMode, setInsertMode] = useState<InsertMode>(null), [targetId, setTargetId] = useState("");
  const [label, setLabel] = useState(""), [url, setUrl] = useState(""), [error, setError] = useState(""), [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null), change = useRef(onChange);
  useEffect(() => { change.current = onChange; }, [onChange]);
  const extensions = useMemo(() => [
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, trailingNode: false, link: { openOnClick: false, autolink: false, linkOnPaste: false, isAllowedUri: (href) => isSafeWikiLink(href) } }),
    TableKit.configure({ table: { resizable: false } }),
    LocalImage.configure({ allowBase64: false }),
    referenceNode("loreLink"), referenceNode("characterCard"), referenceNode("mapEmbed"),
  ], []);
  const editor = useEditor({
    extensions, immediatelyRender: false,
    content: value, editable: !disabled,
    editorProps: { attributes: { role: "textbox", "aria-label": "Текст статьи", "aria-multiline": "true", "data-testid": "wiki-editor", spellcheck: "true" } },
    onUpdate: ({ editor: current }) => {
      const document = current.getJSON() as WikiDocument, result = wikiDocumentSchema.safeParse(document);
      setError(result.success ? "" : result.error.issues[0]?.message || "Проверьте содержимое статьи");
      change.current(document);
    },
  });
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => current ? {
      bold: current.isActive("bold"), italic: current.isActive("italic"), underline: current.isActive("underline"), strike: current.isActive("strike"),
      bullet: current.isActive("bulletList"), ordered: current.isActive("orderedList"), quote: current.isActive("blockquote"), code: current.isActive("codeBlock"),
      table: current.isActive("table"), heading: current.isActive("heading") ? "heading" + String(current.getAttributes("heading").level) : "paragraph",
      undo: current.can().undo(), redo: current.can().redo(),
    } : null,
  });
  useEffect(() => { editor?.setEditable(!disabled, false); }, [editor, disabled]);
  useEffect(() => {
    if (editor && wikiCanonicalJson(editor.getJSON()) !== wikiCanonicalJson(value)) editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);
  const inactive = disabled || !editor || uploading;
  const candidates = targets.filter((target) => insertMode === "characterCard" ? target.kind === "characters" : insertMode === "mapEmbed" ? target.kind === "maps" : true);
  function open(mode: InsertMode) {
    setInsertMode((old) => old === mode ? null : mode); setError("");
    setTargetId(""); setLabel(editor?.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, " ") || ""); setUrl("");
  }
  function insertBlock(node: JSONContent, position = editor?.state.selection.to) {
    if (!editor || position === undefined || disabled) return;
    // An atom can remain selected after inserting a card or image. Inserting at
    // selection.to preserves it, and the following paragraph gives the next
    // insertion a text cursor instead of replacing the previous selected block.
    const at = Math.max(0, Math.min(position, editor.state.doc.content.size));
    editor.chain().focus().insertContentAt(at, [node, { type: "paragraph" }]).run();
  }
  function insertInline(node: JSONContent) {
    if (!editor || disabled) return;
    const selection = editor.state.selection;
    if (isNodeSelection(selection) && selection.node.isBlock) {
      editor.chain().focus().insertContentAt(selection.to, { type: "paragraph", content: [node] }).run();
    } else editor.chain().focus().insertContent(node).run();
  }
  function insertTable() {
    insertBlock({ type: "table", content: Array.from({ length: 3 }, (_, row) => ({
      type: "tableRow", content: Array.from({ length: 3 }, () => ({
        type: row === 0 ? "tableHeader" : "tableCell", content: [{ type: "paragraph" }],
      })),
    })) });
  }
  function insertReference() {
    if (!editor || disabled) return;
    const target = candidates.find((entry) => entry.id === targetId);
    if (!target) { setError("Выберите объект для вставки"); return; }
    if (insertMode === "internal") {
      const text = label.trim() || target.title;
      if (text.length > 160) { setError("Подпись ссылки должна быть короче 160 символов"); return; }
      insertInline({ type: "loreLink", attrs: { targetId, label: text } });
    } else if (insertMode === "characterCard" || insertMode === "mapEmbed") {
      insertBlock({ type: insertMode, attrs: { targetId } });
    }
    setInsertMode(null);
  }
  function insertExternal() {
    if (!editor || disabled) return;
    const href = url.trim();
    if (!isSafeWikiLink(href)) { setError("Введите полный адрес https://, http:// или mailto:"); return; }
    if (editor.state.selection.empty || label.trim() || isNodeSelection(editor.state.selection)) insertInline({ type: "text", text: label.trim() || href, marks: [{ type: "link", attrs: { href } }] });
    else editor.chain().focus().setLink({ href }).run();
    setInsertMode(null);
  }
  async function upload(file?: File) {
    if (!file || !onUploadImage || !editor || disabled) return;
    if (file.size > 5 * 1024 * 1024) { setError("Изображение должно быть не больше 5 МиБ"); return; }
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { setError("Выберите PNG, JPEG или WebP"); return; }
    setUploading(true); setError("");
    // Map the insertion point through edits made while the upload is running.
    // The image must not replace a selected card or text typed in the meantime.
    let position = editor.state.selection.to;
    const mapPosition = ({ transaction }: EditorEvents["transaction"]) => {
      position = transaction.mapping.map(position, 1);
    };
    editor.on("transaction", mapPosition);
    try {
      const image = await onUploadImage(file);
      if (!editor.isDestroyed) insertBlock({ type: "image", attrs: { src: image.url, alt: file.name.slice(0, 500) } }, position);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось загрузить изображение"); }
    finally { editor.off("transaction", mapPosition); setUploading(false); }
  }
  return <div className={styles.editorShell}>
    <div className={styles.toolbar} role="toolbar" aria-label="Форматирование статьи">
      <label className={styles.styleField}><span className={styles.visuallyHidden}>Стиль текста</span><select aria-label="Стиль текста" value={state?.heading || "paragraph"} disabled={inactive} onChange={(event) => { const selected = event.currentTarget.value; if (selected === "paragraph") editor?.chain().focus().setParagraph().run(); else editor?.chain().focus().toggleHeading({ level: Number(selected.slice(-1)) as 1 | 2 | 3 }).run(); }}><option value="paragraph">Обычный текст</option><option value="heading1">Заголовок 1</option><option value="heading2">Заголовок 2</option><option value="heading3">Заголовок 3</option></select></label>
      <EditorButton label="Полужирный" icon={Bold} active={state?.bold} disabled={inactive} action={() => editor?.chain().focus().toggleBold().run()} />
      <EditorButton label="Курсив" icon={Italic} active={state?.italic} disabled={inactive} action={() => editor?.chain().focus().toggleItalic().run()} />
      <EditorButton label="Подчёркнутый" icon={Underline} active={state?.underline} disabled={inactive} action={() => editor?.chain().focus().toggleUnderline().run()} />
      <EditorButton label="Зачёркнутый" icon={Strikethrough} active={state?.strike} disabled={inactive} action={() => editor?.chain().focus().toggleStrike().run()} />
      <span className={styles.divider} />
      <EditorButton label="Маркированный список" icon={List} active={state?.bullet} disabled={inactive} action={() => editor?.chain().focus().toggleBulletList().run()} />
      <EditorButton label="Нумерованный список" icon={ListOrdered} active={state?.ordered} disabled={inactive} action={() => editor?.chain().focus().toggleOrderedList().run()} />
      <EditorButton label="Цитата" icon={Quote} active={state?.quote} disabled={inactive} action={() => editor?.chain().focus().toggleBlockquote().run()} />
      <EditorButton label="Блок кода" icon={Code2} active={state?.code} disabled={inactive} action={() => editor?.chain().focus().toggleCodeBlock().run()} />
      <EditorButton label="Разделитель" icon={Minus} disabled={inactive} action={() => insertBlock({ type: "horizontalRule" })} />
      <span className={styles.divider} />
      <EditorButton label="Внутренняя ссылка" icon={Link2} active={insertMode === "internal"} disabled={inactive} action={() => open("internal")} />
      <EditorButton label="Внешняя ссылка" icon={Link2} active={insertMode === "external"} disabled={inactive} action={() => open("external")} />
      <EditorButton label="Карточка персонажа" icon={UserRound} active={insertMode === "characterCard"} disabled={inactive} action={() => open("characterCard")} />
      <EditorButton label="Встроенная карта" icon={MapIcon} active={insertMode === "mapEmbed"} disabled={inactive} action={() => open("mapEmbed")} />
      <EditorButton label="Таблица" icon={Table2} active={state?.table} disabled={inactive} action={insertTable} />
      {onUploadImage && <><EditorButton label="Изображение" icon={ImageIcon} disabled={inactive} action={() => fileInput.current?.click()} /><input ref={fileInput} className={styles.visuallyHidden} type="file" aria-label="Изображение статьи" accept="image/png,image/jpeg,image/webp" disabled={inactive} onChange={(event) => { void upload(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></>}
      <span className={styles.divider} />
      <EditorButton label="Отменить правку текста" icon={Undo2} disabled={inactive || !state?.undo} action={() => editor?.chain().focus().undo().run()} />
      <EditorButton label="Повторить правку текста" icon={Redo2} disabled={inactive || !state?.redo} action={() => editor?.chain().focus().redo().run()} />
    </div>
    {state?.table && !disabled && <div className={styles.tableTools} role="group" aria-label="Редактирование таблицы"><button type="button" onClick={() => editor?.chain().focus().addRowAfter().run()}>Добавить строку</button><button type="button" onClick={() => editor?.chain().focus().addColumnAfter().run()}>Добавить столбец</button><button type="button" onClick={() => editor?.chain().focus().deleteRow().run()}>Удалить строку</button><button type="button" onClick={() => editor?.chain().focus().deleteColumn().run()}>Удалить столбец</button><button type="button" onClick={() => editor?.chain().focus().deleteTable().run()}>Удалить таблицу</button></div>}
    {insertMode && <div className={styles.insertPanel} role="group" aria-label="Вставка в статью" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (insertMode === "external") insertExternal(); else insertReference(); } if (event.key === "Escape") { event.preventDefault(); setInsertMode(null); editor?.commands.focus(); } }}>
      {insertMode === "external" ? <><label><span>Веб-адрес</span><input aria-label="Веб-адрес" value={url} onChange={(event) => setUrl(event.currentTarget.value)} placeholder="https://…" type="url" /></label><label><span>Текст ссылки</span><input aria-label="Текст внешней ссылки" value={label} onChange={(event) => setLabel(event.currentTarget.value)} maxLength={500} /></label><button type="button" className="button secondary" onClick={insertExternal} disabled={inactive}>Добавить внешнюю ссылку</button></> : <><label><span>{insertMode === "internal" ? "Объект для ссылки" : insertMode === "characterCard" ? "Персонаж для вставки" : "Карта для вставки"}</span><select aria-label={insertMode === "internal" ? "Объект для ссылки" : insertMode === "characterCard" ? "Персонаж для вставки" : "Карта для вставки"} value={targetId} onChange={(event) => setTargetId(event.currentTarget.value)}><option value="">Выберите…</option>{candidates.map((target) => <option key={target.id} value={target.id}>{target.title} · {kindLabels[target.kind]}</option>)}</select></label>{insertMode === "internal" && <label><span>Подпись ссылки</span><input aria-label="Подпись внутренней ссылки" value={label} onChange={(event) => setLabel(event.currentTarget.value)} placeholder="Название объекта" maxLength={160} /></label>}<button type="button" className="button secondary" onClick={insertReference} disabled={inactive || !targetId}>{insertMode === "internal" ? "Вставить ссылку на объект" : insertMode === "characterCard" ? "Вставить карточку персонажа" : "Вставить карту"}</button></>}
      <button type="button" className="icon-button" aria-label="Закрыть вставку" onClick={() => setInsertMode(null)}><X size={16} /></button>
    </div>}
    <TargetContext.Provider value={targets}><EditorContent editor={editor} className={styles.editorContent} /></TargetContext.Provider>
    {uploading && <p className={styles.note} role="status">Загружаем изображение…</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <p className={styles.note}>Текст сохраняется вместе со статьёй. Ctrl+Z — отменить последнюю правку.</p>
  </div>;
}
function EditorButton({ label, icon: Icon, active, disabled, action }: { label: string; icon: typeof Bold; active?: boolean; disabled: boolean; action: () => unknown }) {
  return <button type="button" aria-label={label} title={label} aria-pressed={active ?? false} disabled={disabled} onClick={action}><Icon size={16} /></button>;
}

export type WikiDocumentViewProps = { document: WikiDocument; targets: WikiEntry[]; onNavigate: (id: string) => void; renderEmbed?: (kind: "characterCard" | "mapEmbed", id: string) => ReactNode };
export function WikiDocumentView({ document, targets, onNavigate, renderEmbed }: WikiDocumentViewProps) {
  const parsed = useMemo(() => wikiDocumentSchema.safeParse(document), [document]);
  if (!parsed.success) return <p className={styles.error}>Содержимое статьи не удалось прочитать.</p>;
  const entries = new Map(targets.map((entry) => [entry.id, entry]));
  let headingIndex = 0;
  function marked(node: WikiNode, initial: ReactNode): ReactNode {
    let value = initial;
    for (const mark of node.marks ?? []) {
      if (mark.type === "bold") value = <strong>{value}</strong>;
      else if (mark.type === "italic") value = <em>{value}</em>;
      else if (mark.type === "underline") value = <u>{value}</u>;
      else if (mark.type === "strike") value = <s>{value}</s>;
      else if (mark.type === "code") value = <code>{value}</code>;
      else if (mark.type === "link") value = <a href={String(mark.attrs!.href)} target="_blank" rel="noopener noreferrer">{value}</a>;
    }
    return value;
  }
  function render(node: WikiNode, key: string): ReactNode {
    const children = node.content?.map((child, index) => render(child, key + "." + index));
    if (node.type === "text") return <span key={key}>{marked(node, node.text)}</span>;
    if (node.type === "paragraph") return <p key={key}>{children?.length ? children : <br />}</p>;
    if (node.type === "heading") {
      const id = "wiki-heading-" + (++headingIndex), level = Number(node.attrs!.level);
      return level === 1 ? <h1 id={id} key={key}>{children}</h1> : level === 2 ? <h2 id={id} key={key}>{children}</h2> : <h3 id={id} key={key}>{children}</h3>;
    }
    if (node.type === "hardBreak") return <br key={key} />;
    if (node.type === "horizontalRule") return <hr key={key} />;
    if (node.type === "bulletList") return <ul key={key}>{children}</ul>;
    if (node.type === "orderedList") return <ol key={key} start={Number(node.attrs?.start || 1)}>{children}</ol>;
    if (node.type === "listItem") return <li key={key}>{children}</li>;
    if (node.type === "blockquote") return <blockquote key={key}>{children}</blockquote>;
    if (node.type === "codeBlock") return <pre key={key}><code>{children}</code></pre>;
    if (node.type === "table") return <div className={styles.tableScroll} key={key}><table><tbody>{children}</tbody></table></div>;
    if (node.type === "tableRow") return <tr key={key}>{children}</tr>;
    if (node.type === "tableCell" || node.type === "tableHeader") {
      const props = { colSpan: Number(node.attrs?.colspan || 1), rowSpan: Number(node.attrs?.rowspan || 1), style: { textAlign: ["left", "center", "right"].includes(String(node.attrs?.align)) ? String(node.attrs!.align) as "left" | "center" | "right" : undefined } };
      return node.type === "tableHeader" ? <th {...props} key={key}>{children}</th> : <td {...props} key={key}>{children}</td>;
    }
    if (node.type === "image") {
      // Image sizes are not known before the authenticated resource loads.
      // eslint-disable-next-line @next/next/no-img-element
      return <figure key={key}><img src={String(node.attrs!.src)} alt={String(node.attrs!.alt || "")} title={node.attrs!.title ? String(node.attrs!.title) : undefined} loading="lazy" />{node.attrs!.title ? <figcaption>{String(node.attrs!.title)}</figcaption> : null}</figure>;
    }
    const target = entries.get(String(node.attrs?.targetId));
    if (node.type === "loreLink") return <span key={key}>{marked(node, <button type="button" className={styles.internalLink} disabled={!target} onClick={() => target && onNavigate(target.id)}><Link2 size={12} />{target ? String(node.attrs!.label || target.title) : "Объект недоступен"}</button>)}</span>;
    if (node.type === "characterCard" || node.type === "mapEmbed") return <div className={styles.readEmbed} key={key}>{target ? renderEmbed?.(node.type, target.id) ?? <button type="button" onClick={() => onNavigate(target.id)}>{node.type === "characterCard" ? <UserRound size={22} /> : <MapIcon size={22} />}<span>{target.title}</span></button> : <p className={styles.note}>Объект недоступен в этой линии на выбранную дату.</p>}</div>;
    return null;
  }
  return <div className={styles.document} data-testid="wiki-document">{parsed.data.content.map((node, index) => render(node, String(index)))}</div>;
}
