// Minimal converter between plain text/markdown bodies (what an LLM naturally writes
// via MCP) and the TipTap doc JSON the web UI renders. Not a real Markdown parser —
// just paragraphs separated by blank lines, with hardBreaks inside paragraphs.
// Bold/italic/links/lists need to be authored in the TipTap editor.

type TipTapNode = { type: string; text?: string; content?: TipTapNode[] };

export function textToTipTapJson(text: string): string {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const content: TipTapNode[] = blocks.map((block) => {
    const lines = block.split("\n");
    const inline: TipTapNode[] = [];
    lines.forEach((line, i) => {
      if (i > 0) inline.push({ type: "hardBreak" });
      if (line.length > 0) inline.push({ type: "text", text: line });
    });
    return inline.length > 0
      ? { type: "paragraph", content: inline }
      : { type: "paragraph" };
  });
  return JSON.stringify({ type: "doc", content });
}

export function tipTapJsonToText(raw: string | null | undefined): string {
  if (!raw) return "";
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return "";
  }
  if (!doc || typeof doc !== "object") return "";
  const d = doc as { content?: TipTapNode[] };
  if (!Array.isArray(d.content)) return "";
  return d.content
    .map((node) => extractParagraph(node))
    .filter((s) => s.length >= 0)
    .join("\n\n");
}

function extractParagraph(node: TipTapNode): string {
  if (!node || !Array.isArray(node.content)) return "";
  return node.content
    .map((c) => {
      if (c.type === "hardBreak") return "\n";
      if (c.type === "text") return c.text ?? "";
      return "";
    })
    .join("");
}
