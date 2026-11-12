# Kontrora — Staff Engineer Assignment (Revenue & Billing)

PSA platform (Next.js App Router + Supabase). Ships the **Estimates** revenue slice end-to-end.

---

## Setup

Node.js **20.9+**, free [Supabase](https://supabase.com) project.

```bash
npm install
cp .env.local.template .env.local   # fill Supabase URL + keys
# Run supabase/schema.sql in the Supabase SQL Editor (Dashboard → SQL Editor)
npm run dev                          # http://localhost:3000
```

---

## Architecture decisions

### 1. Schema — amounts in minor units (cents)

All monetary values (`subtotal_cents`, `tax_cents`, `total_cents`, `unit_price_cents`,
`amount_cents`) are stored as `BIGINT` integers representing the smallest currency unit
(e.g. cents for USD). This eliminates floating-point rounding errors at the DB layer.
The API surface accepts and returns decimal numbers (e.g. `99.99`); conversion happens
at the boundary via `toCents(x) = Math.round(x * 100)` and is never done in SQL or
client-side display math. `formatCents()` in `lib/supabase.ts` uses `Intl.NumberFormat`
for locale-correct display.

### 2. Lifecycle — status machine with explicit transition guard

Estimates follow a strict state machine enforced server-side:

```
draft → sent → accepted
             → rejected
```

The `PATCH /:estimateId` route detects a status-only body and validates the requested
transition against an explicit allow-list (`transitions[currentStatus]`). Content edits
(title, line items, etc.) are only permitted on `draft` estimates. Terminal states
(`accepted`, `rejected`) are immutable. `deleted_at` timestamps replace hard deletes so
financial records are always preserved for audit.

### 3. Idempotency

`POST /api/accounts/:accountId/estimates` reads the `Idempotency-Key` request header.
If a row with that key already exists for the account, the existing estimate is returned
(HTTP 200) instead of inserting a duplicate. This makes the creation endpoint safe to
retry on network failure. The key is stored in a `UNIQUE`-constrained `idempotency_key`
column.

### 4. Account boundary enforcement

Every API handler resolves the estimate from the DB **and** verifies that
`estimate.account_id === accountId` from the URL. If they differ the response is a 404
(not a 403) to avoid leaking the existence of estimates in other accounts. This is the
same pattern used by the existing escrow route. No RLS row-filtering is used — the
existing codebase uses `USING (TRUE)` service-role policies and enforces boundaries
in application code.

### 5. RBAC — two new granular permissions

| Permission | Who should hold it | What it gates |
|---|---|---|
| `view_estimates` | Account managers, project leads, any read-only stakeholder | GET list + GET single |
| `manage_estimates` | Account managers, finance roles | POST create, PATCH edit/transition, DELETE |

`manage_estimates` is a strict superset of `view_estimates`. Both are checked with
the existing `hasPermission(userProfile, permission, { accountId })` call, which
delegates to `checkPermissionHybrid` with 5-minute caching. Superadmins bypass all
checks via the existing `isSuperadmin` fast-path.

Permissions must be assigned to roles via the existing admin UI
(Admin → Role Management → Edit Role → Permissions).

### 6. Line items — replace-on-update

When a `PATCH` body includes `line_items`, the route deletes all existing line items
for the estimate and re-inserts the new set in a single write cycle. This keeps the
logic simple and correct without requiring per-item diffing. Because both operations
target the same estimate and the estimate is in `draft` status, there is no risk of
corrupting an already-sent document.

### 7. Component architecture

| Component | Responsibility |
|---|---|
| `EstimateLineItemEditor` | Controlled list of line item drafts; pure UI with no API calls |
| `EstimateCreateDialog` | Modal form; generates an idempotency key per open; calls POST on submit |
| `EstimateList` | Owns fetch lifecycle, status filter, table, inline detail panel, transitions, and delete |

`EstimateList` follows the same pattern as `AccountOverview`: a Client Component that
fetches its own data via `apiFetch` using the existing Bearer-token + cookie auth.
The Server Component (`app/accounts/[accountId]/page.tsx`) computes permission booleans
and passes them down as props so the client component never needs to re-derive them.

---

## Security & tenancy review

| Concern | Mitigation |
|---|---|
| Cross-account data access | Every route calls `resolveEstimate()` which asserts `estimate.account_id === accountId` from the URL path. A 404 is returned on mismatch, not a 403. |
| Unauthenticated access | `getUserFromRequest()` is called at the top of every handler; a missing or invalid session returns 401 before any DB query runs. |
| Privilege escalation | `canManageEstimates` / `canViewEstimates` are checked after auth and before any read or write. Superadmin bypass goes through the standard `hasPermission` path which calls `isSuperadmin` internally. |
| Money precision | Decimal → cents conversion uses `Math.round(x * 100)` on every incoming value. Totals are recomputed server-side on every write; the client-side preview is display-only. |
| Idempotency key collision across accounts | The `UNIQUE` constraint on `idempotency_key` is global, but the lookup additionally filters by `account_id`, so a key reused across accounts would not cause a false positive. |
| Soft-delete bypass | Deleted estimates are excluded by `.is('deleted_at', null)` on every query; no route can resurface a soft-deleted estimate. |
| Status mutation on non-draft | The transition guard rejects any attempt to edit content of a non-draft estimate with HTTP 422. `accepted` and `rejected` states are immutable. |
| Line item injection | All inputs go through Zod schemas (`estimateLineItemSchema`, `createEstimateSchema`, `updateEstimateSchema`) before touching the DB. Parameterised Supabase queries prevent SQL injection. |

---

## How to run tests

```bash
npm run test          # Vitest (watch mode)
npm run test -- --run # Single-pass (CI)
```

Tests live in `__tests__/` or co-located `*.test.ts(x)` files.

**What to test for the Estimates slice:**

```
supabase/schema.sql         — run in a fresh Supabase project; verify table creation and constraints
app/api/accounts/[accountId]/estimates/route.js
  POST                      — valid body → 201 with estimate + line_items
  POST idempotent           — same Idempotency-Key → 200, no duplicate row
  POST wrong account        — project_id from different account → 422
  GET list                  — status filter, pagination
  GET unauthorised          — no session → 401
app/api/accounts/[accountId]/estimates/[estimateId]/route.js
  GET                       — returns estimate with line_items
  GET cross-account         — estimateId belonging to different account → 404
  PATCH status transition   — draft→sent, sent→accepted, sent→rejected; invalid → 422
  PATCH edit non-draft      — sent estimate → 422
  DELETE draft              — sets deleted_at
  DELETE non-draft          — 422
components/estimate-line-item-editor.tsx
  — renders empty state
  — adds and removes rows
  — computes per-row amount and subtotal correctly
components/estimate-create-dialog.tsx
  — validates required fields before submitting
  — shows error toast on API failure
```

---

## What I'd ship next

### Immediate (Q3)

- **PDF generation** — render the estimate as a PDF using `@react-pdf/renderer` and expose
  `GET /api/accounts/:accountId/estimates/:estimateId/pdf`. Store the generated PDF in
  Supabase Storage under a signed URL scoped to the account.

- **Client-portal visibility** — surface read-only estimate views to `is_client` users
  (they already have a `client_account_id` FK) so clients can accept/reject directly
  from the portal without going through the team.

- **Estimate → invoice conversion** — add a `POST .../estimates/:estimateId/convert`
  route that stamps `accepted_at` and creates a linked `invoices` row (new table, same
  BIGINT-cents schema) with a `due_date` and payment status lifecycle.

### Q4

- **Stripe integration** — once the `invoices` table exists, attach a Stripe Payment
  Intent to each invoice on creation. Webhook handler updates `payment_status` on
  `charge.succeeded` / `payment_intent.payment_failed`.

- **Reconciliation view** — analytics query comparing `estimates.total_cents` to actual
  `time_entries` cost (hours × blended rate) per account, surfaced on the account page
  alongside the existing capacity metrics.

- **Approval workflow** — connect estimates to the existing `workflow_templates`
  infrastructure so a "Finance Approval" node can gate the `draft → sent` transition
  for high-value estimates above a configurable threshold.

- **Audit log** — append-only `estimate_events` table (estimate_id, event_type, actor_id,
  payload JSONB, created_at) populated by DB triggers or service-layer calls for every
  status change and line-item edit.
