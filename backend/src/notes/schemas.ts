import { z } from "zod";

export interface NoteDocument {
  type: string;
  text?: string;
  attrs?: Record<string, string | number | null>;
  marks?: { type: string; attrs?: Record<string, string | number | null> }[];
  content?: NoteDocument[];
}

const blockTypes = new Set(["paragraph", "heading", "bulletList", "orderedList", "blockquote", "codeBlock", "horizontalRule"]);
const inlineTypes = new Set(["text", "hardBreak"]);
const markTypes = new Set(["bold", "italic", "underline", "strike", "code", "link"]);
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]) { return Object.keys(value).every((key) => allowed.includes(key)); }

/** Structured rich text only: no raw HTML, scripts, embedded images or unsafe links. No word/character cap. */
export function isNoteDocument(value: unknown): value is NoteDocument {
  if (!object(value) || value.type !== "doc" || !Array.isArray(value.content) || value.content.length === 0) return false;
  const pending: { node: unknown; parent: string; depth: number }[] = [{ node: value, parent: "", depth: 0 }];
  while (pending.length) {
    const { node, parent, depth } = pending.pop()!;
    if (depth > 64 || !object(node) || !keys(node, ["type", "content", "attrs", "text", "marks"]) || typeof node.type !== "string") return false;
    const type = node.type;
    if (depth > 0) {
      const allowed = parent === "paragraph" || parent === "heading" ? inlineTypes :
        parent === "codeBlock" ? new Set(["text"]) :
        parent === "bulletList" || parent === "orderedList" ? new Set(["listItem"]) : blockTypes;
      if (!allowed.has(type)) return false;
    }
    if (node.text !== undefined && (type !== "text" || typeof node.text !== "string" || !node.text.length)) return false;
    if (type === "text" && typeof node.text !== "string") return false;
    if (node.attrs !== undefined) {
      if (!object(node.attrs)) return false;
      if (type === "heading") {
        if (!keys(node.attrs, ["level"]) || ![1, 2, 3].includes(node.attrs.level as number)) return false;
      } else if (type === "orderedList") {
        if (!keys(node.attrs, ["start", "type"]) || !Number.isSafeInteger(node.attrs.start) || (node.attrs.start as number) < 1 ||
            (node.attrs.type !== undefined && node.attrs.type !== null && node.attrs.type !== "1")) return false;
      } else if (type === "codeBlock") {
        if (!keys(node.attrs, ["language"]) || (node.attrs.language !== null && typeof node.attrs.language !== "string")) return false;
      } else if (Object.keys(node.attrs).length) return false;
    }
    if (node.marks !== undefined) {
      if (type !== "text" || parent === "codeBlock" || !Array.isArray(node.marks)) return false;
      for (const mark of node.marks) {
        if (!object(mark) || !keys(mark, ["type", "attrs"]) || !markTypes.has(mark.type as string)) return false;
        if (mark.type === "link") {
          if (!object(mark.attrs) || !keys(mark.attrs, ["href", "target", "rel", "class", "title"]) || typeof mark.attrs.href !== "string") return false;
          try { if (!["https:", "http:", "mailto:"].includes(new URL(mark.attrs.href).protocol)) return false; } catch { return false; }
          if (mark.attrs.target !== undefined && mark.attrs.target !== null && mark.attrs.target !== "_blank") return false;
          if (mark.attrs.rel !== undefined && mark.attrs.rel !== null && typeof mark.attrs.rel !== "string") return false;
          if (mark.attrs.class !== undefined && mark.attrs.class !== null) return false;
          if (mark.attrs.title !== undefined && mark.attrs.title !== null && typeof mark.attrs.title !== "string") return false;
        } else if (mark.attrs !== undefined && (!object(mark.attrs) || Object.keys(mark.attrs).length)) return false;
      }
    }
    if (node.content !== undefined) {
      if (!Array.isArray(node.content) || type === "text" || type === "hardBreak" || type === "horizontalRule") return false;
      for (const child of node.content) pending.push({ node: child, parent: type, depth: depth + 1 });
    }
    if ((type === "bulletList" || type === "orderedList" || type === "listItem") && (!Array.isArray(node.content) || !node.content.length)) return false;
    if (type === "listItem" && (!object((node.content as unknown[])[0]) || ((node.content as unknown[])[0] as Record<string, unknown>).type !== "paragraph")) return false;
  }
  return true;
}

const documentSchema = z.custom<NoteDocument>(isNoteDocument, "Ungültiger Notizinhalt oder unsicherer Link").transform((document) => {
  const pending = [document];
  while (pending.length) {
    const node = pending.pop()!;
    for (const mark of node.marks ?? []) {
      if (mark.type === "link") mark.attrs = { href: mark.attrs!.href, target: "_blank", rel: "noopener noreferrer", class: null, title: mark.attrs!.title ?? null };
    }
    for (const child of node.content ?? []) pending.push(child);
  }
  return document;
});
export const createNoteSchema = z.object({ title: z.string().trim().min(1).optional(), content: documentSchema.optional() }).strict();
export const updateNoteSchema = z.object({ revision: z.number().int().nonnegative(), title: z.string().trim().min(1).optional(), content: documentSchema.optional() })
  .strict().refine((value) => value.title !== undefined || value.content !== undefined, "Keine Änderungen angegeben");
export const noteAccessSchema = z.object({ users: z.array(z.object({ userId: z.string().min(1), canWrite: z.boolean() }).strict()) }).strict();
