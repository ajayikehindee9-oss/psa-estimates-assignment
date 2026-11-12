/**
 * Form Service
 * Form response create/read helpers used by workflow form API routes.
 */
const { createAdminSupabaseClient } = require('@/lib/supabase-server');
const { logger } = require('@/lib/debug-logger');

function getDb() {
  const admin = createAdminSupabaseClient();
  if (!admin) throw new Error('Database connection failed');
  return admin;
}

/**
 * Submit a form response (optionally linked to a workflow history entry).
 */
async function submitFormResponse({
  formTemplateId,
  responseData,
  submittedBy,
  workflowHistoryId = null,
}) {
  const db = getDb();

  const { data: template, error: templateError } = await db
    .from('form_templates')
    .select('id, is_active')
    .eq('id', formTemplateId)
    .single();

  if (templateError || !template) {
    throw new Error('Form template not found');
  }
  if (template.is_active === false) {
    throw new Error('Form template is not active');
  }

  const { data, error } = await db
    .from('form_responses')
    .insert({
      form_template_id: formTemplateId,
      response_data: responseData || {},
      submitted_by: submittedBy,
      workflow_history_id: workflowHistoryId || null,
    })
    .select(
      `
      *,
      form_templates(id, name, fields)
    `,
    )
    .single();

  if (error) {
    logger.error('submitFormResponse failed', { formTemplateId }, error);
    throw error;
  }

  // Keep workflow_history.form_response_id in sync when linked
  if (workflowHistoryId && data?.id) {
    await db
      .from('workflow_history')
      .update({ form_response_id: data.id })
      .eq('id', workflowHistoryId);
  }

  return data;
}

/**
 * Get a form response by id (with template metadata).
 */
async function getFormResponseById(id) {
  const db = getDb();

  const { data, error } = await db
    .from('form_responses')
    .select(
      `
      *,
      form_templates(id, name, description, fields),
      user_profiles:submitted_by(id, name, email)
    `,
    )
    .eq('id', id)
    .maybeSingle();

  if (error) {
    logger.error('getFormResponseById failed', { id }, error);
    throw error;
  }

  return data || null;
}

/**
 * Get the form response linked to a workflow history entry.
 * Tries workflow_history.form_response_id first, then form_responses.workflow_history_id.
 */
async function getFormResponseByHistoryId(historyId) {
  const db = getDb();

  const { data: history, error: historyError } = await db
    .from('workflow_history')
    .select('id, form_response_id')
    .eq('id', historyId)
    .maybeSingle();

  if (historyError) {
    logger.error('getFormResponseByHistoryId history lookup failed', { historyId }, historyError);
    throw historyError;
  }

  if (history?.form_response_id) {
    return getFormResponseById(history.form_response_id);
  }

  const { data, error } = await db
    .from('form_responses')
    .select(
      `
      *,
      form_templates(id, name, description, fields),
      user_profiles:submitted_by(id, name, email)
    `,
    )
    .eq('workflow_history_id', historyId)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.error('getFormResponseByHistoryId failed', { historyId }, error);
    throw error;
  }

  return data || null;
}

module.exports = {
  submitFormResponse,
  getFormResponseById,
  getFormResponseByHistoryId,
};
