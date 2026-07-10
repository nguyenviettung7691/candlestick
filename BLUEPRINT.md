# Candlestick Product Blueprint

## 1. Product Goal

Build a fully serverless, scale-to-zero market analytics web application where users can:

- Manage multiple dashboards.
- Assign one active indicator per dashboard.
- Track symbol-level indicator outputs in a table and detail chart.
- Receive realtime updates after initial hydration.
- Configure notifications tied to symbol plus indicator conditions.

The architecture remains hydrate-then-stream using AWS services and browser-native realtime capabilities.

## 2. Scope Summary

### 2.1 In Scope (v1)

- Multi-dashboard support with selector, add, and edit flows.
- Indicator management screen with:
  - Prebuilt indicator catalog.
  - User-created indicators.
  - Parameter tuning for indicator configuration.
- One-indicator-per-dashboard rule.
- Dashboard layout with two main sections:
  - Stocks table list.
  - Symbol detail chart with indicator overlays.
- Initial market data hydration on first load.
- Realtime refresh using WebSocket streaming.
- Browser push notifications and in-app alerts for user-defined conditions.
- Persistence of user configuration and authentication/session data in AWS data services.

### 2.2 Out Of Scope (v1)

- Free-form custom formula code editor for indicators.
- Multi-indicator overlay per single dashboard.

## 3. Core Product Capabilities

### 3.1 Dashboard Management

Users can create, select, edit, and archive dashboards.

Rules:

- A dashboard belongs to one user.
- A dashboard has exactly one active indicator assignment at a time.
- A dashboard owns its symbol watchlist.
- Dashboard metadata includes at minimum:
  - dashboard_id
  - dashboard_name
  - indicator_id
  - optional description
  - created_at and updated_at

### 3.2 Indicator Management

Users can open an indicator management screen and:

- Browse prebuilt indicators.
- Duplicate prebuilt indicators into user-owned variants.
- Create custom indicators from supported templates.
- Tune parameters within validated ranges.
- Save a versioned indicator configuration.

Rules:

- Indicator execution contract remains stable: {"metric": float, "signal": str}.
- Parameter tuning must be schema-validated before save and before assignment to a dashboard.
- Editing an indicator currently assigned to dashboards must preserve backward compatibility through versioning or safe migration.

### 3.3 Dashboard Data Surface

Each dashboard renders two synchronized sections.

Section 1: Stocks Table List

- Purpose: quick-glance analysis for all symbols in the current dashboard watchlist.
- User actions:
  - Add supported symbols.
  - Remove symbols.
  - Select a symbol to focus detail chart.
- Minimum displayed columns:
  - Symbol
  - Company Name
  - Price
  - Indicator Metric(s)
  - Indicator Signal

Section 2: Symbol Detail Chart

- Purpose: deep view for the selected symbol in current dashboard.
- Header content for chart panel:
  - Symbol code and full company name.
  - Timerange selector (minimum: 1D, 1W, 1M; extensible).
- Chart content:
  - Price history series for selected timerange.
  - Indicator overlays and markers relevant to active indicator.

### 3.4 Header Layout Contract

The top header of the dashboard page must contain:

- Dashboard selector.
- Active indicator badge showing:
  - indicator display name
  - short description
- Dashboard action controls:
  - Add dashboard
  - Edit dashboard

The header must be responsive and remain usable on mobile widths.

## 4. UX And Screen Contracts

### 4.1 Main Dashboard Screen

Layout intent:

- Top: unified header controls and active context.
- Body: two-column desktop layout (table left, detail chart right).
- Mobile: stacked sections with preserved workflows and minimal interaction loss.

Behavior:

- Selecting a row or symbol chip updates detail chart context.
- Changing dashboard updates table, chart, and active indicator context together.
- Changing timerange only affects detail chart history window, not watchlist membership.

### 4.2 Indicator Management Screen

Minimum modules:

- Indicator catalog list (prebuilt plus user-owned).
- Indicator detail pane with:
  - name
  - short description
  - parameter form
  - validation feedback
- Save, duplicate, and assign actions.

### 4.3 Dashboard Configuration Screen

Minimum modules:

- Dashboard name and description editor.
- Indicator selector (exactly one indicator assigned).
- Symbol watchlist manager.
- Save and cancel flows with validation.

## 5. Data And Persistence Model

### 5.1 Storage Principles

- Use AWS managed services for persistence.
- Keep single-table DynamoDB design for core entities where appropriate.
- Maintain clear user ownership boundaries for all mutable records.

### 5.2 Core Entity Types

- User Profile
- Auth Session or Token Record
- Dashboard
- Dashboard Symbol Mapping
- Indicator Definition
- Indicator Version or Config Snapshot
- Notification Rule
- WebSocket Connection

### 5.3 Required Relationships

- One user -> many dashboards.
- One dashboard -> one active indicator.
- One dashboard -> many symbols.
- One user -> many indicators (custom or duplicated variants).
- One user -> many notification rules.

### 5.4 WebSocket Connection Records

Connection lifecycle records remain ephemeral.

Rules:

- Keep connection rows keyed by PK=WS_CONNECTION#{id} and dashboard-scoped SK.
- Connection TTL is relative: connected_at + WS_CONNECTION_TTL_SECONDS.
- Persistent records (dashboards, indicators, notification rules) do not use TTL unless explicitly intended.

## 6. Realtime Data Contract

### 6.1 Hydrate Then Stream Lifecycle

On first dashboard load:

- Fetch latest available market and indicator snapshot for active dashboard.
- Render table and initial selected-symbol chart from hydrated state.

After hydration:

- Subscribe to realtime updates over WebSocket.
- Apply validated packets to state.
- Keep updates scoped to active dashboard context.

### 6.2 Stream Packet Requirements

Packets must include:

- dashboard_id
- connection_id
- optional as_of_epoch
- data map keyed by symbol with indicator outputs

Client rules:

- Validate payload shape before applying updates.
- Ignore packets for other dashboards.
- Preserve stable indicator signal vocabulary across backend and frontend.

## 7. Notification System Requirements

### 7.1 Notification Rule Model

Users can configure alert rules with at least:

- target dashboard
- target symbol
- target indicator
- condition operator and threshold or signal condition
- cooldown or suppression window
- enabled or disabled state

### 7.2 Delivery Channels

v1 requires both:

- Browser push notifications (service worker based).
- In-app alert notifications while dashboard is open.

Behavior:

- Request browser permission explicitly.
- Do not send duplicate notifications during cooldown.
- Persist notification preferences and rules per user.

## 8. Auth And Security Baseline

Authentication model for this blueprint:

- Custom token and session model persisted in AWS DB services.

Requirements:

- Every mutable entity operation is authorized and user-scoped.
- Dashboard, indicator, and notification access must enforce ownership.
- Session lifecycle must include expiry and revocation behavior.

## 9. Non-Functional Requirements

- Scale-to-zero backend behavior with no always-on compute required.
- Mobile-safe and desktop-safe responsiveness for table and chart areas.
- Observability for polling, websocket delivery, and notification events.
- Resilience for pagination in DynamoDB scans and queries used in loops and cleanup paths.
- Backward-compatible contracts for indicator result shape and websocket payload fields.

## 10. Implementation Notes

- Keep frontend type definitions as source of truth for stream payload contracts.
- Keep indicator output contract unchanged for compatibility.
- Preserve dashboard-scoped routing for websocket connection handling.
- Prefer parameterized environment controls for runtime tuning over hard-coded constants.

## 11. Acceptance Criteria Checklist

A release candidate satisfies this blueprint only if:

- Header shows dashboard selector, active indicator name plus short description, and add/edit dashboard actions.
- User can create and manage multiple dashboards.
- Each dashboard enforces exactly one active indicator.
- User can manage indicator configurations in dedicated indicator screen.
- Table section supports symbol add/remove and quick-glance indicator outputs.
- Selecting symbol updates detail chart with full company name and timerange controls.
- App hydrates first load data, then updates via websocket stream.
- Notification rules can be configured and delivered via browser push and in-app alerts.
- User configuration and auth session records persist in AWS data services.

## 12. References

1. TradingView Lightweight Charts: https://tradingview.github.io/lightweight-charts/
2. TanStack Table v8: https://tanstack.com/table/v8
3. vnstock: https://github.com/thinh-vu/vnstock
4. Next.js App Router: https://nextjs.org/docs/app
5. AWS SAM Developer Guide: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html
6. Amazon API Gateway WebSocket APIs: https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api.html
