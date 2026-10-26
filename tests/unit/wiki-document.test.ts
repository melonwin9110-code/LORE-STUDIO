import { describe, expect, it } from "vitest";
import { EMPTY_WIKI_DOCUMENT, isSafeWikiLink, wikiDocumentEmbeds, wikiDocumentHeadings, wikiDocumentImages, wikiDocumentReferences, wikiDocumentSchema, wikiDocumentText, type WikiDocument } from "../../src/lib/wiki-document";

const character = "07b2282a-d15b-453d-91a7-2aac2034aa9f", map = "d9900401-9d32-478b-8875-b925d2391242", image = "c04ee1e3-ce24-4286-a13a-26294efa0259";
const text = (value: string) => ({ type: "text", text: value });
const document = (content: WikiDocument["content"]): WikiDocument => ({ type: "doc", content });
const paragraph = (value: string) => ({ type: "paragraph", content: [text(value)] });

describe("безопасный документ энциклопедии", () => {
  it("принимает пустой черновик и не разделяет изменяемые данные с входом", () => {
    const input = structuredClone(EMPTY_WIKI_DOCUMENT), result = wikiDocumentSchema.parse(input);
    expect(result).toEqual(input);
    result.content.push(paragraph("Авторская заметка"));
    expect(input.content).toHaveLength(1);
  });
  it("читает форматирование, таблицы и заголовки реального редактора", () => {
    const input = document([
      { type: "heading", attrs: { level: 1 }, content: [text("История короны")] },
      { type: "paragraph", content: [{ ...text("Сведения летописца"), marks: [{ type: "bold" }, { type: "underline" }, { type: "link", attrs: { href: "https://example.com/source", target: "_blank", rel: "noopener noreferrer nofollow", class: null, title: null } }] }] },
      { type: "orderedList", attrs: { start: 2, type: null }, content: [{ type: "listItem", content: [paragraph("Список")] }] },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null }, content: [paragraph("Эпоха")] }, { type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: [120] }, content: [paragraph("Третья")] }] }] },
      { type: "codeBlock", attrs: { language: null }, content: [text("<script>это текст</script>")] },
    ]);
    const parsed = wikiDocumentSchema.parse(input);
    expect(wikiDocumentText(parsed)).toContain("Эпоха\nТретья");
    expect(wikiDocumentText(parsed)).toContain("<script>это текст</script>");
    expect(wikiDocumentHeadings(parsed)).toEqual([{ id: "wiki-heading-1", text: "История короны", level: 1 }]);
  });
  it("извлекает внутренние связи, типы вставок и изображения, нормализуя UUID", () => {
    const parsed = wikiDocumentSchema.parse(document([
      { type: "paragraph", content: [{ type: "loreLink", attrs: { targetId: character.toUpperCase(), label: "Первый король" }, marks: [{ type: "bold" }] }, { type: "loreLink", attrs: { targetId: character, label: "Ещё ссылка" } }] },
      { type: "characterCard", attrs: { targetId: character } }, { type: "mapEmbed", attrs: { targetId: map } },
      { type: "image", attrs: { src: "/api/wiki-images/" + image.toUpperCase(), alt: "Личная иллюстрация", title: null } },
    ]));
    expect(wikiDocumentReferences(parsed)).toEqual([character, map]);
    expect(wikiDocumentImages(parsed)).toEqual([image]);
    expect(wikiDocumentEmbeds(parsed)).toEqual([{ kind: "characterCard", targetId: character }, { kind: "mapEmbed", targetId: map }]);
    expect(wikiDocumentText(parsed)).toContain("Первый корольЕщё ссылка");
  });
  it.each(["javascript:alert(1)", "data:text/html,<svg/onload=alert(1)>", "file:///tmp/private", "https://example.com/\nscript", " https://example.com", "/api/secret", "https://user:password@example.com"])("отклоняет небезопасную ссылку %s", (href) => {
    expect(isSafeWikiLink(href)).toBe(false);
    expect(wikiDocumentSchema.safeParse(document([{ type: "paragraph", content: [{ ...text("Ссылка"), marks: [{ type: "link", attrs: { href } }] }] }])).success).toBe(false);
  });
  it.each(["https://example.com/?q=%D0%BC%D0%B8%D1%80", "http://localhost:3000", "mailto:author@example.com"])("принимает явную пользовательскую ссылку %s", (href) => {
    expect(isSafeWikiLink(href)).toBe(true);
  });
  it("отклоняет HTML, чужие атрибуты и внешние изображения", () => {
    for (const node of [
      { type: "html", text: "<script>alert(1)</script>" },
      { type: "paragraph", attrs: { onclick: "alert(1)" } },
      { type: "image", attrs: { src: "https://tracker.example/image.png" } },
      { type: "image", attrs: { src: "data:image/png;base64,AA==" } },
      { type: "image", attrs: { src: "/api/wiki-images/" + image + "?tracking=1" } },
      { type: "paragraph", content: [{ ...text("Текст"), marks: [{ type: "bold", attrs: { style: "url(https://tracker.example)" } }] }] },
    ]) expect(wikiDocumentSchema.safeParse(document([node])).success).toBe(false);
  });
  it("проверяет родителей, пустые структурные блоки и размеры ячеек", () => {
    for (const input of [
      document([text("Вне абзаца")]),
      document([{ type: "tableRow", content: [] }]),
      document([{ type: "bulletList", content: [paragraph("Без listItem")] }]),
      document([{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 31 }, content: [paragraph("Слишком широко")] }] }] }]),
      document([{ type: "heading", attrs: { level: 6 }, content: [text("Неподдерживаемый уровень")] }]),
      document([{ type: "paragraph", content: [{ type: "loreLink", attrs: { targetId: "чужой-id", label: "Ссылка" } }] }]),
    ]) expect(wikiDocumentSchema.safeParse(input).success).toBe(false);
  });
  it("без переполнения стека отклоняет чрезмерную вложенность и циклы", () => {
    let nested: WikiDocument["content"][number] = paragraph("Текст");
    for (let index = 0; index < 1000; index++) nested = { type: "blockquote", content: [nested] };
    expect(wikiDocumentSchema.safeParse(document([nested])).success).toBe(false);
    const cyclic = document([{ type: "blockquote", content: [] }]);
    cyclic.content[0].content = cyclic.content;
    expect(wikiDocumentSchema.safeParse(cyclic).success).toBe(false);
  });
  it("ограничивает число узлов, объём текста и общий JSON", () => {
    expect(wikiDocumentSchema.safeParse(document(Array.from({ length: 5001 }, () => ({ type: "paragraph" })))).success).toBe(false);
    expect(wikiDocumentSchema.safeParse(document([paragraph("а".repeat(100001))])).success).toBe(false);
    const imageNode = { type: "image", attrs: { src: "/api/wiki-images/" + image, alt: "я".repeat(500), title: "ю".repeat(500) } };
    expect(wikiDocumentSchema.safeParse(document(Array.from({ length: 500 }, () => structuredClone(imageNode)))).success).toBe(false);
  });
});
