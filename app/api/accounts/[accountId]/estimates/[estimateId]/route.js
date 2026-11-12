'use strict';

/**
 * GET    /api/accounts/[accountId]/estimates/[estimateId]
 *   Fetch a single estimate with its line items.
 *
 * PATCH  /api/accounts/[accountId]/estimates/[estimateId]
 *   Update a draft estimate (title, description, notes, line items, etc.)
 *   OR transition its status (sent → accepted | rejected).
 *   Only drafts may have their content edited.
 *   Body for content edit: { title?, description?, notes?, line_items?, tax_rate?, ... }
 *   Body for status transition: { status: 'sent' | 'accepted' | 'rejected' }
 *
 * DELETE /api/accounts/[accountId]/estimates/[estimateId]
 *   Soft-deletes the estimate (sets deleted_at).  No hard deletes — financial records
 *   must be preserved for audit purposes.
 *   Only drafts may be deleted; accepted/rejected estimates are immutable.
 */

const { NextResponse } = require('next/server');
const { createAdminSupabaseClient, getUserFromRequest } = require('@/lib/supabase-server');
const { hasPermission, isSuperadmin } = require('@/lib/rbac');
const { Permission } = require('@/lib/permissions');
const {
  updateEstimateSchema,
  estimateStatusTransitionSchema,
  validateRequestBody,
} = require('@/lib/validation-schemas');
const { logger } = require('@/lib/debug-logger');
const { isValidUUID } = require('@/lib/validation-helpers');
const { config } = require('@/lib/config');

// ---------------------------------------------------------------------------
// Money helpers (duplicated here to keep route files self-contained)
// ---------------------------------------------------------------------------

function toCents(amount) {
  return Math.round(amount * 100);
}

function computeTotals(lineItems, taxRate = 0) {
  const subtotalCents = lineItems.reduce((sum, li) => sum + li.amount_cents, 0);
  const taxCents = Math.round(subtotalCents * (taxRate / 100));
  const totalCents = subtotalCents + taxCents;
  return { subtotalCents, taxCents, totalCents };
}

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

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
// Shared: resolve + authorize estimate
// ---------------------------------------------------------------------------

/**
 * Fetch estimate, verify it belongs to the given account, and that it is not
 * soft-deleted.  Returns { estimate } or a NextResponse error.
 */
async function resolveEstimate(admin, accountId, estimateId) {
  const { data: estimate, error } = await admin
    .from('estimates')
    .select(`*, line_items:estimate_line_items(*)`)
    .eq('id', estimateId)
    .is('deleted_at', null)
    .single();

  if (error || !estimate) {
    return { error: NextResponse.json({ error: 'Estimate not found' }, { status: 404 }) };
  }

  // Enforce account boundary — CRITICAL tenancy check
  if (estimate.account_id !== accountId) {
    return { error: NextResponse.json({ error: 'Estimate not found' }, { status: 404 }) };
  }

  return { estimate };
}

// ---------------------------------------------------------------------------
// GET /api/accounts/[accountId]/estimates/[estimateId]
// ---------------------------------------------------------------------------

async function GET(request, { params }) {
  try {
    const { accountId, estimateId } = await params;

    if (!isValidUUID(accountId)) {
      return NextResponse.json({ error: 'Invalid account ID' }, { status: 400 });
    }
    if (!isValidUUID(estimateId)) {
      return NextResponse.json({ error: 'Invalid estimate ID' }, { status: 400 });
    }

    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const admin = createAdminSupabaseClient();
    if (!admin) return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });

    const { data: userProfile } = await admin
      .from('user_profiles')
      .select(`*, user_roles!user_id(roles!role_id(id, name, permissions, department_id))`)
      .eq('id', user.id)
      .single();

    if (!userProfile) return NextResponse.json({ error: 'User profile not found' }, { status: 404 });

    if (!(await canViewEstimates(userProfile, accountId, admin))) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const { estimate, error: resolveError } = await resolveEstimate(admin, accountId, estimateId);
    if (resolveError) return resolveError;

    return NextResponse.json({ success: true, estimate }, { status: 200 });
  } catch (error) {
    logger.error('Error in GET /api/accounts/[accountId]/estimates/[estimateId]', {}, error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/accounts/[accountId]/estimates/[estimateId]
// ---------------------------------------------------------------------------

async function PATCH(request, { params }) {
  try {
    const { accountId, estimateId } = await params;

    if (!isValidUUID(accountId)) {
      return NextResponse.json({ error: 'Invalid account ID' }, { status: 400 });
    }
    if (!isValidUUID(estimateId)) {
      return NextResponse.json({ error: 'Invalid estimate ID' }, { status: 400 });
    }

    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const admin = createAdminSupabaseClient();
    if (!admin) return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });

    const { data: userProfile } = await admin
      .from('user_profiles')
      .select(`*, user_roles!user_id(roles!role_id(id, name, permissions, department_id))`)
      .eq('id', user.id)
      .single();

    if (!userProfile) return NextResponse.json({ error: 'User profile not found' }, { status: 404 });

    if (!(await canManageEstimates(userProfile, accountId, admin))) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const { estimate, error: resolveError } = await resolveEstimate(admin, accountId, estimateId);
    if (resolveError) return resolveError;

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    // --- Status transition path ---
    if ('status' in body && Object.keys(body).length === 1) {
      const statusValidation = validateRequestBody(estimateStatusTransitionSchema, body);
      if (!statusValidation.success) {
        return NextResponse.json({ error: statusValidation.error }, { status: 400 });
      }

      const { status: newStatus } = statusValidation.data;

      // Enforce allowed transitions
      const transitions = {
        draft: ['sent'],
        sent: ['accepted', 'rejected'],
        accepted: [],
        rejected: [],
      };

      if (!transitions[estimate.status]?.includes(newStatus)) {
        return NextResponse.json(
          {
            error: `Cannot transition from '${estimate.status}' to '${newStatus}'`,
          },
          { status: 422 },
        );
      }

      const timestampField =
        newStatus === 'sent' ? 'sent_at' :
        newStatus === 'accepted' ? 'accepted_at' : 'rejected_at';

      const { data: updated, error: updateError } = await admin
        .from('estimates')
        .update({ status: newStatus, [timestampField]: new Date().toISOString() })
        .eq('id', estimateId)
        .select()
        .single();

      if (updateError) {
        logger.error('Failed to update estimate status', { estimateId }, updateError);
        return NextResponse.json(
          {
            error: 'Failed to update estimate status',
            ...(config.errors.exposeDetails && { details: updateError.message }),
          },
          { status: 500 },
        );
      }

      logger.info('Estimate status transitioned', {
        estimateId,
        from: estimate.status,
        to: newStatus,
        userId: user.id,
      });

      return NextResponse.json({ success: true, estimate: updated }, { status: 200 });
    }

    // --- Content edit path (draft only) ---
    if (estimate.status !== 'draft') {
      return NextResponse.json(
        { error: 'Only draft estimates can be edited' },
        { status: 422 },
      );
    }

    const validation = validateRequestBody(updateEstimateSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const { line_items, tax_rate, project_id, ...scalarFields } = validation.data;

    // --- Validate project_id account boundary if supplied ---
    if (project_id !== undefined) {
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
      scalarFields.project_id = project_id || null;
    }

    // --- Recompute totals if line items or tax changed ---
    let totalsUpdate = {};
    if (line_items !== undefined) {
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

      // Determine effective tax rate: use incoming value, else existing estimate's tax_cents ratio
      const effectiveTaxRate = tax_rate !== undefined
        ? tax_rate
        : estimate.subtotal_cents > 0
          ? (estimate.tax_cents / estimate.subtotal_cents) * 100
          : 0;

      const { subtotalCents, taxCents, totalCents } = computeTotals(preparedLineItems, effectiveTaxRate);
      totalsUpdate = {
        subtotal_cents: subtotalCents,
        tax_cents: taxCents,
        total_cents: totalCents,
      };

      // Replace line items: delete existing, re-insert new ones
      const { error: deleteError } = await admin
        .from('estimate_line_items')
        .delete()
        .eq('estimate_id', estimateId);

      if (deleteError) {
        logger.error('Failed to delete existing line items', { estimateId }, deleteError);
        return NextResponse.json({ error: 'Failed to update line items' }, { status: 500 });
      }

      const lineItemRows = preparedLineItems.map((li) => ({
        ...li,
        estimate_id: estimateId,
      }));

      const { error: insertError } = await admin
        .from('estimate_line_items')
        .insert(lineItemRows);

      if (insertError) {
        logger.error('Failed to insert updated line items', { estimateId }, insertError);
        return NextResponse.json({ error: 'Failed to update line items' }, { status: 500 });
      }
    } else if (tax_rate !== undefined) {
      // Tax rate changed but line items didn't — recompute from existing subtotal
      const taxCents = Math.round(estimate.subtotal_cents * (tax_rate / 100));
      totalsUpdate = {
        tax_cents: taxCents,
        total_cents: estimate.subtotal_cents + taxCents,
      };
    }

    // --- Update the estimate row ---
    const updatePayload = { ...scalarFields, ...totalsUpdate };
    if (Object.keys(updatePayload).length === 0) {
      return NextResponse.json({ success: true, estimate }, { status: 200 });
    }

    const { data: updated, error: updateError } = await admin
      .from('estimates')
      .update(updatePayload)
      .eq('id', estimateId)
      .select()
      .single();

    if (updateError) {
      logger.error('Failed to update estimate', { estimateId }, updateError);
      return NextResponse.json(
        {
          error: 'Failed to update estimate',
          ...(config.errors.exposeDetails && { details: updateError.message }),
        },
        { status: 500 },
      );
    }

    // Fetch fresh line items for the response
    const { data: freshLineItems } = await admin
      .from('estimate_line_items')
      .select('*')
      .eq('estimate_id', estimateId)
      .order('sort_order');

    logger.info('Estimate updated', { estimateId, userId: user.id });

    return NextResponse.json(
      { success: true, estimate: { ...updated, line_items: freshLineItems || [] } },
      { status: 200 },
    );
  } catch (error) {
    logger.error('Error in PATCH /api/accounts/[accountId]/estimates/[estimateId]', {}, error);
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
// DELETE /api/accounts/[accountId]/estimates/[estimateId]
// Soft-delete only — financial records must be preserved.
// ---------------------------------------------------------------------------

async function DELETE(request, { params }) {
  try {
    const { accountId, estimateId } = await params;

    if (!isValidUUID(accountId)) {
      return NextResponse.json({ error: 'Invalid account ID' }, { status: 400 });
    }
    if (!isValidUUID(estimateId)) {
      return NextResponse.json({ error: 'Invalid estimate ID' }, { status: 400 });
    }

    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const admin = createAdminSupabaseClient();
    if (!admin) return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });

    const { data: userProfile } = await admin
      .from('user_profiles')
      .select(`*, user_roles!user_id(roles!role_id(id, name, permissions, department_id))`)
      .eq('id', user.id)
      .single();

    if (!userProfile) return NextResponse.json({ error: 'User profile not found' }, { status: 404 });

    if (!(await canManageEstimates(userProfile, accountId, admin))) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const { estimate, error: resolveError } = await resolveEstimate(admin, accountId, estimateId);
    if (resolveError) return resolveError;

    // Only drafts can be deleted — accepted/rejected are immutable financial records
    if (estimate.status !== 'draft') {
      return NextResponse.json(
        {
          error: `Cannot delete an estimate with status '${estimate.status}'. Only drafts can be deleted.`,
        },
        { status: 422 },
      );
    }

    const { error: deleteError } = await admin
      .from('estimates')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', estimateId);

    if (deleteError) {
      logger.error('Failed to soft-delete estimate', { estimateId }, deleteError);
      return NextResponse.json({ error: 'Failed to delete estimate' }, { status: 500 });
    }

    logger.info('Estimate soft-deleted', { estimateId, userId: user.id });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error('Error in DELETE /api/accounts/[accountId]/estimates/[estimateId]', {}, error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

exports.GET = GET;
exports.PATCH = PATCH;
exports.DELETE = DELETE;
