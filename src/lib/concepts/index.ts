// Server-side barrel. `axes` and `components` are `server-only`, so client
// components must import the pure helpers from "@/lib/concepts/normalize"
// directly rather than from here — the same split as "@/lib/tags/color".
export * from "./normalize";
export * from "./axes";
export * from "./components";
export * from "./decomposition";
export * from "./overlap";
export * from "./pool";
