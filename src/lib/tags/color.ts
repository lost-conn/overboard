// Stable per-name color so a tag has a consistent hue everywhere it appears
// without forcing the user to pick one. djb2-ish hash → HSL → hex.

export function deriveTagColor(name: string): string {
  let h = 5381;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return hslToHex(hue, 55, 48);
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lit = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lit, 1 - lit);
  const f = (n: number) => lit - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const r = Math.round(255 * f(0));
  const g = Math.round(255 * f(8));
  const b = Math.round(255 * f(4));
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}
