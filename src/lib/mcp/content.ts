// Converts between TipTap (ProseMirror) JSON and a GFM-flavored Markdown subset.
//
// Schema covered: StarterKit (doc, paragraph, heading, bulletList, orderedList,
// listItem, blockquote, codeBlock, horizontalRule, hardBreak; marks bold, italic,
// strike, code, link) plus extension-task-list (taskList, taskItem).
//
// This is purposely a small hand-rolled converter — enough to round-trip what
// the card editor produces without adding a markdown dependency. It is not a
// full CommonMark/GFM implementation.

type Node = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Mark[];
  content?: Node[];
};
type Mark = { type: string; attrs?: Record<string, unknown> };

// ───────────────────────── JSON → Markdown ─────────────────────────

export function tipTapJsonToMarkdown(raw: string | null | undefined): string {
  if (!raw) return "";
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return "";
  }
  if (!doc || typeof doc !== "object") return "";
  const d = doc as Node;
  if (!Array.isArray(d.content)) return "";
  const body = renderBlocks(d.content);
  return body.length > 0 ? body + "\n" : "";
}

function renderBlocks(nodes: Node[]): string {
  return nodes.map(renderBlock).join("\n\n");
}

function renderBlock(node: Node): string {
  switch (node.type) {
    case "paragraph":
      return renderInline(node.content ?? []);
    case "heading": {
      const raw = typeof node.attrs?.level === "number" ? node.attrs.level : 1;
      const level = Math.min(6, Math.max(1, raw));
      return "#".repeat(level) + " " + renderInline(node.content ?? []);
    }
    case "bulletList":
      return renderList(node, "bullet");
    case "orderedList":
      return renderList(node, "ordered");
    case "taskList":
      return renderList(node, "task");
    case "blockquote": {
      const inner = renderBlocks(node.content ?? []);
      return inner
        .split("\n")
        .map((l) => (l.length > 0 ? `> ${l}` : ">"))
        .join("\n");
    }
    case "codeBlock": {
      const lang = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      const inner = (node.content ?? [])
        .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
        .join("");
      return "```" + lang + "\n" + inner + (inner.endsWith("\n") ? "" : "\n") + "```";
    }
    case "horizontalRule":
      return "---";
    default:
      return "";
  }
}

function renderList(list: Node, kind: "bullet" | "ordered" | "task"): string {
  const items = list.content ?? [];
  const start =
    kind === "ordered" && typeof list.attrs?.start === "number"
      ? (list.attrs.start as number)
      : 1;
  return items
    .map((item, i) => renderListItem(item, kind, kind === "ordered" ? start + i : 0))
    .join("\n");
}

function renderListItem(
  item: Node,
  kind: "bullet" | "ordered" | "task",
  num: number,
): string {
  let marker: string;
  if (kind === "bullet") marker = "- ";
  else if (kind === "ordered") marker = `${num}. `;
  else marker = item.attrs?.checked === true ? "- [x] " : "- [ ] ";

  const children = item.content ?? [];
  if (children.length === 0) return marker.trimEnd();

  const indent = " ".repeat(marker.length);
  const parts: string[] = [];
  children.forEach((child, idx) => {
    const rendered =
      child.type === "paragraph"
        ? renderInline(child.content ?? [])
        : renderBlock(child);
    if (idx === 0) {
      parts.push(marker + rendered);
    } else {
      parts.push(
        rendered
          .split("\n")
          .map((l) => indent + l)
          .join("\n"),
      );
    }
  });
  return parts.join("\n");
}

function renderInline(nodes: Node[]): string {
  return nodes.map(renderInlineNode).join("");
}

function renderInlineNode(node: Node): string {
  if (node.type === "hardBreak") return "  \n";
  if (node.type !== "text") return "";
  let text = node.text ?? "";
  const marks = node.marks ?? [];

  // Code mark is exclusive — render backticks and skip other marks/escaping.
  if (marks.some((m) => m.type === "code")) {
    return "`" + text + "`";
  }

  text = escapeMarkdown(text);
  for (const m of marks) {
    if (m.type === "bold") text = `**${text}**`;
    else if (m.type === "italic") text = `*${text}*`;
    else if (m.type === "strike") text = `~~${text}~~`;
  }
  const link = marks.find((m) => m.type === "link");
  if (link) {
    const href = typeof link.attrs?.href === "string" ? link.attrs.href : "";
    text = `[${text}](${href})`;
  }
  return text;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_~[\]])/g, "\\$1");
}

// ───────────────────────── Markdown → JSON ─────────────────────────

export function markdownToTipTapJson(md: string): string {
  const blocks = parseBlocks(md.replace(/\r\n/g, "\n").split("\n"));
  return JSON.stringify({ type: "doc", content: blocks });
}

function parseBlocks(lines: string[]): Node[] {
  const out: Node[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      i++;
      const code: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      out.push({
        type: "codeBlock",
        ...(lang ? { attrs: { language: lang } } : {}),
        ...(code.length > 0
          ? { content: [{ type: "text", text: code.join("\n") }] }
          : {}),
      });
      continue;
    }

    if (isHorizontalRule(line)) {
      out.push({ type: "horizontalRule" });
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push({
        type: "heading",
        attrs: { level: heading[1].length },
        content: parseInline(heading[2]),
      });
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push({ type: "blockquote", content: parseBlocks(quoted) });
      continue;
    }

    if (detectListMarker(line)) {
      const list = parseList(lines, i);
      out.push(list.node);
      i = list.next;
      continue;
    }

    // Paragraph
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push({ type: "paragraph", content: parseInline(para.join("\n")) });
  }
  return out;
}

function isHorizontalRule(line: string): boolean {
  const t = line.trim();
  return /^-{3,}$/.test(t) || /^\*{3,}$/.test(t) || /^_{3,}$/.test(t);
}

function startsBlock(line: string): boolean {
  return (
    /^```/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^>\s?/.test(line) ||
    isHorizontalRule(line) ||
    detectListMarker(line) !== null
  );
}

type ListMarker =
  | { kind: "bullet"; indent: number; markerLen: number; rest: string }
  | { kind: "ordered"; indent: number; markerLen: number; rest: string; start: number }
  | { kind: "task"; indent: number; markerLen: number; rest: string; checked: boolean };

function detectListMarker(line: string): ListMarker | null {
  const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
  if (!m) return null;
  const indent = m[1].length;
  const marker = m[2];
  const rest = m[3];
  const markerLen = marker.length + 1;
  const isBullet = marker === "-" || marker === "*" || marker === "+";

  if (isBullet) {
    const task = /^\[( |x|X)\]\s+(.*)$/.exec(rest);
    if (task) {
      return {
        kind: "task",
        indent,
        markerLen: markerLen + 4, // "[ ] " or "[x] "
        rest: task[2],
        checked: task[1].toLowerCase() === "x",
      };
    }
    return { kind: "bullet", indent, markerLen, rest };
  }

  return {
    kind: "ordered",
    indent,
    markerLen,
    rest,
    start: parseInt(marker, 10),
  };
}

function parseList(lines: string[], startIdx: number): { node: Node; next: number } {
  const first = detectListMarker(lines[startIdx])!;
  const kind = first.kind;
  const baseIndent = first.indent;
  const items: Node[] = [];
  let i = startIdx;

  while (i < lines.length) {
    const here = detectListMarker(lines[i]);
    if (!here || here.indent !== baseIndent || here.kind !== kind) break;

    const stripWidth = baseIndent + here.markerLen;
    const itemLines: string[] = [here.rest];
    i++;

    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === "") {
        // Lookahead past blanks; continuation requires indented or sibling-marker line.
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === "") j++;
        if (j >= lines.length) break;
        const next = lines[j];
        const nextIndent = next.match(/^ */)![0].length;
        const nextMarker = detectListMarker(next);
        if (nextMarker && nextMarker.indent === baseIndent && nextMarker.kind === kind) {
          // sibling — drop the blank separator and move on.
          i = j;
          break;
        }
        if (nextIndent >= stripWidth) {
          itemLines.push("");
          i++;
          continue;
        }
        break;
      }
      const indent = l.match(/^ */)![0].length;
      if (indent >= stripWidth) {
        itemLines.push(l.slice(stripWidth));
        i++;
        continue;
      }
      break;
    }

    const inner = parseBlocks(itemLines);
    const content = inner.length > 0 ? inner : [{ type: "paragraph" } as Node];

    if (kind === "task") {
      items.push({
        type: "taskItem",
        attrs: { checked: here.kind === "task" ? here.checked : false },
        content,
      });
    } else {
      items.push({ type: "listItem", content });
    }
  }

  if (kind === "task") {
    return { node: { type: "taskList", content: items }, next: i };
  }
  if (kind === "ordered") {
    const start1 = (first as Extract<ListMarker, { kind: "ordered" }>).start;
    return {
      node: {
        type: "orderedList",
        ...(start1 !== 1 ? { attrs: { start: start1 } } : {}),
        content: items,
      },
      next: i,
    };
  }
  return { node: { type: "bulletList", content: items }, next: i };
}

// Inline parser — handles `code`, **bold**, *italic*, __bold__, _italic_,
// ~~strike~~, [link](href), and hard breaks ("  \n" or "\\\n").
const HB = "";

function parseInline(text: string): Node[] {
  const normalized = text
    .replace(/  +\n/g, HB)
    .replace(/\\\n/g, HB)
    .replace(/\n/g, " ");
  return parseInlineSegments(normalized, []);
}

function parseInlineSegments(text: string, marks: Mark[]): Node[] {
  const out: Node[] = [];
  let buf = "";
  const flush = () => {
    if (buf.length > 0) {
      out.push(makeText(buf, marks));
      buf = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === HB) {
      flush();
      out.push({ type: "hardBreak" });
      i++;
      continue;
    }

    if (ch === "\\" && i + 1 < text.length) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      if (close > i) {
        flush();
        out.push(makeText(text.slice(i + 1, close), [...marks, { type: "code" }]));
        i = close + 1;
        continue;
      }
    }

    if (ch === "*" && text[i + 1] === "*") {
      const close = findClose(text, i + 2, "**");
      if (close >= 0) {
        flush();
        out.push(
          ...parseInlineSegments(text.slice(i + 2, close), [...marks, { type: "bold" }]),
        );
        i = close + 2;
        continue;
      }
    }
    if (ch === "*") {
      const close = findClose(text, i + 1, "*");
      if (close >= 0) {
        flush();
        out.push(
          ...parseInlineSegments(text.slice(i + 1, close), [...marks, { type: "italic" }]),
        );
        i = close + 1;
        continue;
      }
    }
    if (ch === "_" && text[i + 1] === "_") {
      const close = findClose(text, i + 2, "__");
      if (close >= 0) {
        flush();
        out.push(
          ...parseInlineSegments(text.slice(i + 2, close), [...marks, { type: "bold" }]),
        );
        i = close + 2;
        continue;
      }
    }
    if (ch === "_") {
      const close = findClose(text, i + 1, "_");
      if (close >= 0) {
        flush();
        out.push(
          ...parseInlineSegments(text.slice(i + 1, close), [...marks, { type: "italic" }]),
        );
        i = close + 1;
        continue;
      }
    }

    if (ch === "~" && text[i + 1] === "~") {
      const close = findClose(text, i + 2, "~~");
      if (close >= 0) {
        flush();
        out.push(
          ...parseInlineSegments(text.slice(i + 2, close), [...marks, { type: "strike" }]),
        );
        i = close + 2;
        continue;
      }
    }

    if (ch === "[") {
      const link = matchLink(text, i);
      if (link) {
        flush();
        out.push(
          ...parseInlineSegments(text.slice(link.textLo, link.textHi), [
            ...marks,
            { type: "link", attrs: { href: link.href } },
          ]),
        );
        i = link.end;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

function makeText(text: string, marks: Mark[]): Node {
  const node: Node = { type: "text", text };
  if (marks.length > 0) node.marks = marks;
  return node;
}

function findClose(text: string, from: number, token: string): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (text.startsWith(token, i)) return i;
    i++;
  }
  return -1;
}

function matchLink(
  text: string,
  start: number,
): { textLo: number; textHi: number; href: string; end: number } | null {
  let i = start + 1;
  let depth = 1;
  const textLo = i;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  if (depth !== 0 || text[i + 1] !== "(") return null;
  const textHi = i;
  const hrefLo = i + 2;
  const closeParen = text.indexOf(")", hrefLo);
  if (closeParen < 0) return null;
  return {
    textLo,
    textHi,
    href: text.slice(hrefLo, closeParen),
    end: closeParen + 1,
  };
}
