'use strict';

/**
 * GET  /api/accounts/[accountId]/estimates
 *   List estimates for an account (server-side filtered, paginated).
 *   Query params: status, project_id, limit, offset
 *
 * POST /api/accounts/[accountId]/estimates
 *   Create a draft estimate with line items.
 *   Supports idempotent creation via the `Idempotency-Key` request header.
 *   Body: { title, description?, project_id?, valid_until?, notes?, currency?,
 *           tax_rate?, line_items: [{ description, quantity, unit_price }] }
 */

const { NextResponse } = require('next/server');
const { createAdminSupabaseClient } = require('@/lib/supabase-server');
const { getUserFromRequest } = require('@/lib/supabase-server');
const { hasPermission, isSuperadmin } = require('@/lib/rbac');
const { Permission } = require('@/lib/permissions');
const {
  createEstimateSchema,
  listEstimatesQuerySchema,
  validateRequestBody,
  validateQueryParams,
} = require('@/lib/validation-schemas');
const { logger } = require('@/lib/debug-logger');
const { isValidUUID } = require('@/lib/validation-helpers');
const { config } = require('@/lib/config');

// ---------------------------------------------------------------------------
// Money helpers
// ---------------------------------------------------------------------------

/** Convert a decimal dollar amount to integer cents, rounding half-up. */
function toCents(amount) {
  return Math.round(amount * 100);
}

/** Recompute subtotal, tax, and total from line items and optional tax_rate (%). */
function computeTotals(lineItems, taxRate = 0) {
  const subtotalCents = lineItems.reduce((sum, li) => sum + li.amount_cents, 0);
  const taxCents = Math.round(subtotalCents * (taxRate / 100));
  const totalCents = subtotalCents + taxCents;
  return { subtotalCents, taxCents, totalCents };
}

// ---------------------------------------------------------------------------
// Account-access helper
// ---------------------------------------------------------------------------

/**
 * Returns true if the user can view estimates for this account.
 * Superadmins always pass. Otherwise the user needs VIEW_ESTIMATES
 * (or MANAGE_ESTIMATES which is a superset).
 */
async function canViewEstimates(userProfile, accountId, admin) {
  if (isSuperadmin(userProfile)) return true;
  return (
    (await hasPermission(userProfile, Permission.VIEW_ESTIMATES, { accountId }, admin)) ||
    (await hasPermission(userProfile, Permission.MANAGE_ESTIMATES, { accountId }, admin))
  );
}

async function canManageEstimates(userProfile, accountId, admin) {
  if (isSuperadmin(userProfile)) return true;
  return hasPermission(userProfile, Permission.MANAGE_ESTIMATES, { accountId }, admin);
}

// ---------------------------------------------------------------------------
// GET /api/accounts/[accountId]/estimates
// ---------------------------------------------------------------------------

async function GET(request, { params }) {
  try {
    const { accountId } = await params;

    if (!isValidUUID(accountId)) {
      return NextResponse.json({ error: 'Invalid account ID' }, { status: 400 });
    }

    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const admin = createAdminSupabaseClient();
    if (!admin) {
      return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
    }

    // Fetch profile with roles for permission checks
    const { data: userProfile } = await admin
      .from('user_profiles')
      .select(`*, user_roles!user_id(roles!role_id(id, name, permissions, department_id))`)
      .eq('id', user.id)
      .single();

    if (!userProfile) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 404 });
    }

    // --- Permission check ---
    if (!(await canViewEstimates(userProfile, accountId, admin))) {
      return NextResponse.json(
        { error: 'Insufficient permissions to view estimates' },
        { status: 403 },
      );
    }

    // --- Verify account exists ---
    const { data: account } = await admin
      .from('accounts')
      .select('id')
      .eq('id', accountId)
      .single();
    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // --- Parse + validate query params ---
    const rawParams = {};
    request.nextUrl.searchParams.forEach((value, key) => {
      rawParams[key] = value;
    });
    const qValidation = validateQueryParams(listEstimatesQuerySchema, rawParams);
    if (!qValidation.success) {
      return NextResponse.json({ error: qValidation.error }, { status: 400 });
    }
    const { status, project_id, limit = 50, offset = 0 } = qValidation.data;

    // --- Build query ---
    let query = admin
      .from('estimates')
      .select(
        `
        *,
        line_items:estimate_line_items(
          id, sort_order, description, quantity, unit_price_cents, amount_cents,
          created_at, updated_at
        ),
        project:projects(id, name)
      `,
      )
      .eq('account_id', accountId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (project_id) query = query.eq('project_id', project_id);

    const { data: estimates, error } = await query;

    if (error) {
      logger.error('Failed to fetch estimates', { accountId }, error);
      return NextResponse.json(
        {
          error: 'Failed to fetch estimates',
          ...(config.errors.exposeDetails && { details: error.message }),
        },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, estimates: estimates || [] }, { status: 200 });
  } catch (error) {
    logger.error('Error in GET /api/accounts/[accountId]/estimates', {}, error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        ...(config.errors.exposeDetails && { details: error.message }),
      },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/accounts/[accountId]/estimates
// ---------------------------------------------------------------------------

async function POST(request, { params }) {
  try {
    const { accountId } = await params;

    if (!isValidUUID(accountId)) {
      return NextResponse.json({ error: 'Invalid account ID' }, { status: 400 });
    }

    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const admin = createAdminSupabaseClient();
    if (!admin) {
      return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
    }

    // Fetch profile with roles
    const { data: userProfile } = await admin
      .from('user_profiles')
      .select(`*, user_roles!user_id(roles!role_id(id, name, permissions, department_id))`)
      .eq('id', user.id)
      .single();

    if (!userProfile) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 404 });
    }

    // --- Permission check ---
    if (!(await canManageEstimates(userProfile, accountId, admin))) {
      return NextResponse.json(
        { error: 'Insufficient permissions to create estimates' },
        { status: 403 },
      );
    }

    // --- Verify account exists ---
    const { data: account } = await admin
      .from('accounts')
      .select('id')
      .eq('id', accountId)
      .single();
    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // --- Parse body ---
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const validation = validateRequestBody(createEstimateSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const { title, description, project_id, valid_until, notes, currency = 'USD', tax_rate = 0, line_items } =
      validation.data;

    // --- Validate project_id belongs to this account (if supplied) ---
    if (project_id) {
      if (!isValidUUID(project_id)) {
        return NextResponse.json({ error: 'Invalid project_id' }, { status: 400 });
      }
      const { data: proj } = await admin
        .from('projects')
        .select('id, account_id')
        .eq('id', project_id)
        .single();
      if (!proj || proj.account_id !== accountId) {
        return NextResponse.json(
          { error: 'project_id does not belong to this account' },
          { status: 422 },
        );
      }
    }

    // --- Idempotency ---
    // If the caller provides an Idempotency-Key header, return the existing
    // estimate if one was already created with that key.
    const idempotencyKey = request.headers.get('Idempotency-Key') || null;
    if (idempotencyKey) {
      const { data: existing } = await admin
        .from('estimates')
        .select(`*, line_items:estimate_line_items(*)`)
        .eq('idempotency_key', idempotencyKey)
        .eq('account_id', accountId)
        .is('deleted_at', null)
        .single();

      if (existing) {
        logger.info('Idempotent estimate creation — returning existing estimate', {
          estimateId: existing.id,
          idempotencyKey,
        });
        return NextResponse.json({ success: true, estimate: existing }, { status: 200 });
      }
    }

    // --- Compute line item amounts and totals ---
    const preparedLineItems = line_items.map((li, idx) => {
      const unitPriceCents = toCents(li.unit_price);
      const amountCents = Math.round(li.quantity * unitPriceCents);
      return {
        description: li.description,
        quantity: li.quantity,
        unit_price_cents: unitPriceCents,
        amount_cents: amountCents,
        sort_order: li.sort_order ?? idx,
      };
    });

    const { subtotalCents, taxCents, totalCents } = computeTotals(preparedLineItems, tax_rate);

    // --- Insert estimate ---
    const { data: estimate, error: estimateError } = await admin
      .from('estimates')
      .insert({
        account_id: accountId,
        project_id: project_id || null,
        title,
        description: description || null,
        status: 'draft',
        subtotal_cents: subtotalCents,
        tax_cents: taxCents,
        total_cents: totalCents,
        currency,
        valid_until: valid_until || null,
        notes: notes || null,
        idempotency_key: idempotencyKey,
        created_by: user.id,
      })
      .select()
      .single();

    if (estimateError) {
      logger.error('Failed to create estimate', { accountId, userId: user.id }, estimateError);
      return NextResponse.json(
        {
          error: 'Failed to create estimate',
          ...(config.errors.exposeDetails && { details: estimateError.message }),
        },
        { status: 500 },
      );
    }

    // --- Insert line items ---
    const lineItemRows = preparedLineItems.map((li) => ({
      ...li,
      estimate_id: estimate.id,
    }));

    const { data: lineItems, error: lineItemError } = await admin
      .from('estimate_line_items')
      .insert(lineItemRows)
      .select();

    if (lineItemError) {
      // Attempt rollback — delete the estimate we just created
      await admin.from('estimates').delete().eq('id', estimate.id);
      logger.error('Failed to create line items — rolled back estimate', { estimateId: estimate.id }, lineItemError);
      return NextResponse.json(
        {
          error: 'Failed to create estimate line items',
          ...(config.errors.exposeDetails && { details: lineItemError.message }),
        },
        { status: 500 },
      );
    }

    logger.info('Estimate created', {
      estimateId: estimate.id,
      accountId,
      userId: user.id,
      totalCents,
    });

    return NextResponse.json(
      { success: true, estimate: { ...estimate, line_items: lineItems || [] } },
      { status: 201 },
    );
  } catch (error) {
    logger.error('Error in POST /api/accounts/[accountId]/estimates', {}, error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        ...(config.errors.exposeDetails && { details: error.message }),
      },
      { status: 500 },
    );
  }
}

exports.GET = GET;
exports.POST = POST;
