import { z } from "zod";

export type WikiMark = { type: string; attrs?: Record<string, unknown> };
export type WikiNode = { type: string; attrs?: Record<string, unknown>; content?: WikiNode[]; text?: string; marks?: WikiMark[] };
export type WikiDocument = { type: "doc"; content: WikiNode[] };
export const EMPTY_WIKI_DOCUMENT: WikiDocument = { type: "doc", content: [{ type: "paragraph" }] };
// PostgreSQL jsonb and ProseMirror may serialize object keys in different orders.
// Compare JSON values semantically while keeping document/list order meaningful.
export function wikiCanonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return current;
    return Object.fromEntries(Object.entries(current).sort(([left], [right]) => left.localeCompare(right)));
  });
}
export const WIKI_IMAGE_PATH = /^\/api\/wiki-images\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const uuid = z.uuid();
const blocks = new Set(["paragraph", "heading", "bulletList", "orderedList", "blockquote", "codeBlock", "horizontalRule", "table", "image", "characterCard", "mapEmbed"]);
const inline = new Set(["text", "hardBreak", "loreLink"]);
const simpleMarks = new Set(["bold", "italic", "underline", "strike", "code"]);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
const integer = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const optionalText = (value: unknown, max: number) => value === undefined || value === null || typeof value === "string" && value.length <= max;

export function isSafeWikiLink(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || !value || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol === "mailto:") return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(url.pathname);
    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

function documentError(value: unknown): string | null {
  if (!record(value) || value.type !== "doc" || !Array.isArray(value.content) || value.content.length === 0) return "Ожидается документ статьи";
  // Check depth and size before serialization: direct callers may supply cycles
  // or excessively nested objects even though HTTP JSON cannot contain cycles.
  const pending: { value: unknown; parent: string; depth: number }[] = [{ value, parent: "", depth: 0 }];
  const seen = new WeakSet<object>();
  let count = 0, textSize = 0;
  while (pending.length) {
    const item = pending.pop()!, node = item.value;
    if (item.depth > 12) return "В статье слишком глубокая вложенность";
    if (++count > 5000) return "В статье может быть не больше 5000 элементов";
    if (!record(node) || seen.has(node)) return "Некорректная структура статьи";
    seen.add(node);
    if (!only(node, ["type", "attrs", "content", "text", "marks"]) || typeof node.type !== "string") return "Неизвестные поля элемента статьи";
    const type = node.type;
    const allowed = item.parent === "" ? type === "doc"
      : item.parent === "doc" || item.parent === "blockquote" ? blocks.has(type)
        : item.parent === "paragraph" || item.parent === "heading" ? inline.has(type)
          : item.parent === "codeBlock" ? type === "text"
            : item.parent === "bulletList" || item.parent === "orderedList" ? type === "listItem"
              : item.parent === "listItem" || item.parent === "tableCell" || item.parent === "tableHeader" ? blocks.has(type)
                : item.parent === "table" ? type === "tableRow"
                  : item.parent === "tableRow" ? type === "tableCell" || type === "tableHeader" : false;
    if (!allowed) return "Недопустимое вложение элементов статьи";
    const attrs = node.attrs;
    if (attrs !== undefined && !record(attrs)) return "Некорректные параметры элемента";
    const a = attrs as Record<string, unknown> | undefined;
    if (type === "heading") {
      if (!a || !only(a, ["level"]) || !integer(a.level, 1, 3)) return "Допустимы заголовки трёх уровней";
    } else if (type === "orderedList") {
      if (a && (!only(a, ["start", "type"]) || a.start !== undefined && !integer(a.start, 1, 1000000) || !optionalText(a.type, 8))) return "Некорректная нумерация списка";
    } else if (type === "codeBlock") {
      if (a && (!only(a, ["language"]) || !optionalText(a.language, 80))) return "Некорректный блок кода";
    } else if (type === "tableCell" || type === "tableHeader") {
      if (a && (!only(a, ["colspan", "rowspan", "colwidth", "align"]) || a.colspan !== undefined && !integer(a.colspan, 1, 30) || a.rowspan !== undefined && !integer(a.rowspan, 1, 100) || a.align !== undefined && a.align !== null && !["left", "center", "right"].includes(String(a.align)))) return "Некорректные параметры ячейки";
      if (a?.colwidth !== undefined && a.colwidth !== null && (!Array.isArray(a.colwidth) || a.colwidth.length !== (a.colspan ?? 1) || a.colwidth.some((width) => !integer(width, 0, 10000)))) return "Некорректная ширина таблицы";
    } else if (type === "image") {
      if (!a || !only(a, ["src", "alt", "title"]) || typeof a.src !== "string" || !WIKI_IMAGE_PATH.test(a.src) || !optionalText(a.alt, 500) || !optionalText(a.title, 500)) return "Разрешены только изображения этой энциклопедии";
    } else if (type === "loreLink") {
      if (!a || !only(a, ["targetId", "label"]) || !uuid.safeParse(a.targetId).success || typeof a.label !== "string" || !a.label.trim() || a.label.length > 160) return "Некорректная внутренняя ссылка";
      textSize += a.label.length;
    } else if (type === "characterCard" || type === "mapEmbed") {
      if (!a || !only(a, ["targetId"]) || !uuid.safeParse(a.targetId).success) return "Некорректная встроенная карточка";
    } else if (a && Object.keys(a).length) return "Неизвестные параметры элемента";
    if (type === "text") {
      if (typeof node.text !== "string" || !node.text.length || node.content !== undefined || node.attrs !== undefined) return "Некорректный текст статьи";
      textSize += node.text.length;
    } else if (node.text !== undefined) return "Текст допустим только в текстовом элементе";
    if (textSize > 100000) return "В статье может быть не больше 100000 символов";
    if (node.marks !== undefined) {
      if (!["text", "loreLink"].includes(type) || !Array.isArray(node.marks) || node.marks.length > 6) return "Некорректное форматирование";
      const marks = new Set<string>();
      for (const mark of node.marks) {
        if (!record(mark) || !only(mark, ["type", "attrs"]) || typeof mark.type !== "string" || marks.has(mark.type)) return "Некорректное форматирование";
        marks.add(mark.type);
        if (simpleMarks.has(mark.type)) {
          if (mark.attrs !== undefined && (!record(mark.attrs) || Object.keys(mark.attrs).length)) return "Неизвестные параметры форматирования";
        } else if (mark.type === "link") {
          if (type === "loreLink") return "Внутренняя ссылка не может содержать внешнюю ссылку";
          const link = mark.attrs;
          if (!record(link) || !only(link, ["href", "target", "rel", "class", "title"]) || !isSafeWikiLink(link.href) || link.target !== undefined && link.target !== null && !["_blank", "_self"].includes(String(link.target)) || !optionalText(link.rel, 120) || !optionalText(link.class, 120) || !optionalText(link.title, 200)) return "Недопустимый адрес ссылки";
        } else return "Неизвестное форматирование";
      }
    }
    const containers = ["doc", "paragraph", "heading", "bulletList", "orderedList", "listItem", "blockquote", "codeBlock", "table", "tableRow", "tableCell", "tableHeader"];
    if (node.content !== undefined && (!containers.includes(type) || !Array.isArray(node.content))) return "Этот элемент не может содержать другие элементы";
    const children = Array.isArray(node.content) ? node.content : [];
    if (["doc", "bulletList", "orderedList", "listItem", "blockquote", "table", "tableRow", "tableCell", "tableHeader"].includes(type) && !children.length) return "Пустой структурный элемент статьи";
    if (type === "listItem" && record(children[0]) && children[0].type !== "paragraph") return "Пункт списка должен начинаться с абзаца";
    if (type === "table" && children.length > 100 || type === "tableRow" && children.length > 30) return "Таблица слишком велика";
    for (const child of children) pending.push({ value: child, parent: type, depth: item.depth + 1 });
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 768 * 1024) return "Содержимое статьи слишком велико";
  } catch { return "Некорректный документ статьи"; }
  return null;
}

export const wikiDocumentSchema = z.custom<WikiDocument>().superRefine((value, context) => {
  const error = documentError(value);
  if (error) context.addIssue({ code: "custom", message: error });
}).transform((value): WikiDocument => {
  const document = JSON.parse(JSON.stringify(value)) as WikiDocument;
  for (const node of nodes(document)) {
    if (["loreLink", "characterCard", "mapEmbed"].includes(node.type)) node.attrs!.targetId = String(node.attrs!.targetId).toLowerCase();
    if (node.type === "image") node.attrs!.src = String(node.attrs!.src).toLowerCase();
  }
  return document;
});

function nodes(document: WikiDocument): WikiNode[] {
  const result: WikiNode[] = [], pending: WikiNode[] = [...document.content].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    result.push(node);
    if (node.content) pending.push(...[...node.content].reverse());
  }
  return result;
}
function nodeText(node: WikiNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "loreLink") return String(node.attrs?.label ?? "");
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(nodeText).join("");
}
export function wikiDocumentText(document: WikiDocument): string {
  return document.content.map((node) => nodes({ type: "doc", content: [node] }).filter((item) => ["paragraph", "heading", "codeBlock"].includes(item.type)).map(nodeText).join("\n")).join("\n").trim();
}
export function wikiDocumentReferences(document: WikiDocument): string[] {
  return [...new Set(nodes(document).filter((node) => ["loreLink", "characterCard", "mapEmbed"].includes(node.type)).map((node) => String(node.attrs!.targetId)))];
}
export function wikiDocumentImages(document: WikiDocument): string[] {
  return [...new Set(nodes(document).filter((node) => node.type === "image").map((node) => WIKI_IMAGE_PATH.exec(String(node.attrs!.src))![1]))];
}
export function wikiDocumentEmbeds(document: WikiDocument): { kind: "characterCard" | "mapEmbed"; targetId: string }[] {
  return nodes(document).filter((node) => node.type === "characterCard" || node.type === "mapEmbed").map((node) => ({ kind: node.type as "characterCard" | "mapEmbed", targetId: String(node.attrs!.targetId) }));
}
export function wikiDocumentHeadings(document: WikiDocument): { id: string; text: string; level: number }[] {
  return nodes(document).filter((node) => node.type === "heading").map((node, index) => ({ id: "wiki-heading-" + (index + 1), text: nodeText(node), level: Number(node.attrs!.level) }));
}
