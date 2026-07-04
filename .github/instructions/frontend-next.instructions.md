---
description: "Use when editing Next.js frontend pages, React components, hooks, and TypeScript stream typing in the dashboard UI."
name: "Frontend Next.js Dashboard Rules"
applyTo: "frontend/src/**/*.{ts,tsx}"
---

# Frontend Next.js Dashboard Rules

- Keep `frontend/src/lib/types.ts` synchronized with backend stream packet fields.
- Preserve runtime payload validation in WebSocket handling before writing to React state.
- Keep connection state semantics consistent: `connecting`, `connected`, `reconnecting`.
- Do not break symbol-scoped rendering assumptions in chart/table views.
- Keep components responsive:
  - `AnalysisChart` should remain container-size aware.
  - `MetricsTable` should remain mobile-safe with horizontal overflow support.
- Prefer strict TypeScript typing over `any`; add narrow type guards when ingesting external data.
- Avoid unnecessary global state libraries; keep existing hook/component composition unless task requires architectural change.
- When adding UI fields from stream data, update both types and rendering components together.
