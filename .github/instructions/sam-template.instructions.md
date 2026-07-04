---
description: "Use when editing AWS SAM/CloudFormation resources, parameters, schedules, logging, and DynamoDB/WebSocket infrastructure in backend/template.yaml."
name: "SAM Template Rules"
applyTo: "backend/template.yaml"
---

# SAM Template Rules

- Preserve parameterized configuration for runtime, schedule, table naming, and observability controls.
- Keep DynamoDB safety defaults unless explicitly asked otherwise:
  - Server-side encryption enabled.
  - Optional point-in-time recovery support.
  - Retain policies for replacement/deletion safety.
- Keep Lambda and WebSocket log retention resources aligned with template parameters.
- Preserve WebSocket routing resources and outputs required by clients (`wss://` client endpoint and management endpoint outputs).
- Prefer additive, backward-compatible infrastructure changes.
- When adding new environment variables, wire them through Parameters -> Function Environment consistently.
