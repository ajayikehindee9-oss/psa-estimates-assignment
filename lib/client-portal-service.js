/**
 * Client Portal Service
 * Invitations, client project views, approvals/rejections, and feedback.
 */
const crypto = require('crypto');
const { createAdminSupabaseClient } = require('@/lib/supabase-server');
const { logger } = require('@/lib/debug-logger');

function getDb(supabaseClient) {
  if (supabaseClient) return supabaseClient;
  const admin = createAdminSupabaseClient();
  if (!admin) throw new Error('Database connection failed');
  return admin;
}

/**
 * Resolve the client user's account id, or throw.
 */
async function getClientAccountId(db, clientUserId) {
  const { data: profile, error } = await db
    .from('user_profiles')
    .select('id, is_client, client_account_id')
    .eq('id', clientUserId)
    .single();

  if (error || !profile) {
    throw new Error('Client user profile not found');
  }
  if (!profile.is_client || !profile.client_account_id) {
    throw new Error('User is not associated with a client account');
  }
  return profile.client_account_id;
}

/**
 * Get all projects for the client's account.
 */
async function getClientProjects(clientUserId) {
  const db = getDb();
  const accountId = await getClientAccountId(db, clientUserId);

  const { data, error } = await db
    .from('projects')
    .select(
      `
      id,
      name,
      description,
      status,
      priority,
      start_date,
      end_date,
      created_at,
      updated_at,
      account_id,
      accounts(id, name),
      workflow_instances(
        id,
        status,
        current_node_id,
        workflow_template_id,
        workflow_templates(id, name),
        workflow_nodes:current_node_id(id, label, node_type)
      )
    `,
    )
    .eq('account_id', accountId)
    .order('updated_at', { ascending: false });

  if (error) {
    logger.error('getClientProjects failed', { clientUserId }, error);
    throw error;
  }

  return (data || []).map((project) => {
    const instances = Array.isArray(project.workflow_instances)
      ? project.workflow_instances
      : project.workflow_instances
        ? [project.workflow_instances]
        : [];
    const active = instances.find((i) => i.status === 'active') || instances[0] || null;
    return {
      ...project,
      workflow_instance: active,
      workflow_instances: undefined,
    };
  });
}

/**
 * Get a single project the client can access, with workflow details.
 */
async function getClientProjectById(clientUserId, projectId) {
  const db = getDb();
  const accountId = await getClientAccountId(db, clientUserId);

  const { data: project, error } = await db
    .from('projects')
    .select(
      `
      id,
      name,
      description,
      status,
      priority,
      start_date,
      end_date,
      created_at,
      updated_at,
      account_id,
      accounts(id, name),
      workflow_instances(
        id,
        status,
        current_node_id,
        workflow_template_id,
        started_snapshot,
        workflow_templates(id, name, description),
        workflow_nodes:current_node_id(id, label, node_type)
      )
    `,
    )
    .eq('id', projectId)
    .eq('account_id', accountId)
    .single();

  if (error || !project) {
    return null;
  }

  const instances = Array.isArray(project.workflow_instances)
    ? project.workflow_instances
    : project.workflow_instances
      ? [project.workflow_instances]
      : [];
  const active = instances.find((i) => i.status === 'active') || instances[0] || null;

  return {
    ...project,
    workflow_instance: active,
    workflow_instances: undefined,
  };
}

/**
 * Advance a client approval node.
 */
async function clientApproveProject({
  projectId,
  workflowInstanceId,
  clientUserId,
  notes = null,
  supabaseClient = null,
}) {
  const db = getDb(supabaseClient);
  const accountId = await getClientAccountId(db, clientUserId);

  const { data: project } = await db
    .from('projects')
    .select('id, account_id')
    .eq('id', projectId)
    .eq('account_id', accountId)
    .single();

  if (!project) {
    throw new Error('Project not found or access denied');
  }

  const { data: instance, error: instanceError } = await db
    .from('workflow_instances')
    .select('id, status, current_node_id, project_id, workflow_template_id')
    .eq('id', workflowInstanceId)
    .eq('project_id', projectId)
    .single();

  if (instanceError || !instance) {
    throw new Error('Workflow instance not found');
  }
  if (instance.status !== 'active') {
    throw new Error('Workflow is not active');
  }

  const fromNodeId = instance.current_node_id;

  // Prefer an outgoing "approved"/default connection from the current node
  const { data: connections } = await db
    .from('workflow_connections')
    .select('*')
    .eq('from_node_id', fromNodeId);

  let toNodeId = null;
  if (connections && connections.length > 0) {
    const approved = connections.find((c) => {
      const cond = typeof c.condition === 'string' ? safeParse(c.condition) : c.condition;
      const decision = cond && (cond.decision || cond.label || cond.conditionValue);
      if (!decision) return false;
      return String(decision).toLowerCase().includes('approv');
    });
    toNodeId = (approved || connections[0]).to_node_id;
  }

  if (fromNodeId && toNodeId) {
    await db.from('workflow_history').insert({
      workflow_instance_id: workflowInstanceId,
      from_node_id: fromNodeId,
      to_node_id: toNodeId,
      transitioned_by: clientUserId,
      notes: notes || 'Client approved',
      transition_type: 'normal',
    });

    await db
      .from('workflow_instances')
      .update({ current_node_id: toNodeId, updated_at: new Date().toISOString() })
      .eq('id', workflowInstanceId);

    if (fromNodeId) {
      await db
        .from('workflow_active_steps')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('workflow_instance_id', workflowInstanceId)
        .eq('node_id', fromNodeId)
        .eq('status', 'active');
    }

    await db.from('workflow_active_steps').insert({
      workflow_instance_id: workflowInstanceId,
      node_id: toNodeId,
      assigned_user_id: null,
      branch_id: 'main',
      status: 'active',
    });

    const { data: toNode } = await db
      .from('workflow_nodes')
      .select('id, node_type, label')
      .eq('id', toNodeId)
      .single();

    if (toNode && toNode.node_type === 'end') {
      await db
        .from('workflow_instances')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', workflowInstanceId);
    }
  }

  return {
    success: true,
    projectId,
    workflowInstanceId,
    nextNodeId: toNodeId,
  };
}

/**
 * Reject at a client approval node (logs rejection history; does not auto-advance).
 */
async function clientRejectProject({
  projectId,
  workflowInstanceId,
  clientUserId,
  notes,
  issues = [],
  supabaseClient = null,
}) {
  const db = getDb(supabaseClient);
  const accountId = await getClientAccountId(db, clientUserId);

  const { data: project } = await db
    .from('projects')
    .select('id, account_id')
    .eq('id', projectId)
    .eq('account_id', accountId)
    .single();

  if (!project) {
    throw new Error('Project not found or access denied');
  }

  const { data: instance } = await db
    .from('workflow_instances')
    .select('id, status, current_node_id, project_id')
    .eq('id', workflowInstanceId)
    .eq('project_id', projectId)
    .single();

  if (!instance) {
    throw new Error('Workflow instance not found');
  }

  const fromNodeId = instance.current_node_id;

  // Find a rejection path if present; otherwise stay on current node
  const { data: connections } = await db
    .from('workflow_connections')
    .select('*')
    .eq('from_node_id', fromNodeId);

  let toNodeId = fromNodeId;
  if (connections && connections.length > 0) {
    const rejected = connections.find((c) => {
      const cond = typeof c.condition === 'string' ? safeParse(c.condition) : c.condition;
      const decision = cond && (cond.decision || cond.label || cond.conditionValue);
      if (!decision) return false;
      const d = String(decision).toLowerCase();
      return d.includes('reject') || d.includes('revision') || d.includes('send back');
    });
    if (rejected) toNodeId = rejected.to_node_id;
  }

  const issueNotes =
    issues && issues.length > 0 ? `${notes}\n\nIssues:\n- ${issues.join('\n- ')}` : notes;

  if (fromNodeId && toNodeId) {
    await db.from('workflow_history').insert({
      workflow_instance_id: workflowInstanceId,
      from_node_id: fromNodeId,
      to_node_id: toNodeId,
      transitioned_by: clientUserId,
      notes: issueNotes,
      transition_type: 'rejection',
    });

    if (toNodeId !== fromNodeId) {
      await db
        .from('workflow_instances')
        .update({ current_node_id: toNodeId, updated_at: new Date().toISOString() })
        .eq('id', workflowInstanceId);

      await db
        .from('workflow_active_steps')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('workflow_instance_id', workflowInstanceId)
        .eq('node_id', fromNodeId)
        .eq('status', 'active');

      await db.from('workflow_active_steps').insert({
        workflow_instance_id: workflowInstanceId,
        node_id: toNodeId,
        assigned_user_id: null,
        branch_id: 'main',
        status: 'active',
      });
    }
  }

  return {
    success: true,
    projectId,
    workflowInstanceId,
    nextNodeId: toNodeId,
    issues,
  };
}

/**
 * Submit client feedback for a project.
 */
async function submitClientFeedback({
  projectId,
  clientUserId,
  satisfactionScore,
  whatWentWell,
  whatNeedsImprovement,
  workflowHistoryId,
  performanceMetrics,
}) {
  const db = getDb();
  const accountId = await getClientAccountId(db, clientUserId);

  const { data: project } = await db
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('account_id', accountId)
    .single();

  if (!project) {
    throw new Error('Project not found or access denied');
  }

  const { data, error } = await db
    .from('client_feedback')
    .insert({
      project_id: projectId,
      client_user_id: clientUserId,
      satisfaction_score: satisfactionScore ?? null,
      what_went_well: whatWentWell ?? null,
      what_needs_improvement: whatNeedsImprovement ?? null,
      performance_metrics: performanceMetrics ?? null,
      workflow_history_id: workflowHistoryId ?? null,
      visibility: 'internal',
    })
    .select()
    .single();

  if (error) {
    logger.error('submitClientFeedback failed', { projectId }, error);
    throw error;
  }

  return data;
}

/**
 * Create a client portal invitation for an account email.
 */
async function sendClientInvitation({ accountId, email, invitedBy, expiresInDays = 7 }) {
  const db = getDb();
  const normalizedEmail = String(email).trim().toLowerCase();

  // Block inviting existing internal (non-client) users
  const { data: existingUser } = await db
    .from('user_profiles')
    .select('id, is_client, email')
    .eq('email', normalizedEmail)
    .maybeSingle();

  if (existingUser && !existingUser.is_client) {
    throw new Error('Cannot invite an internal user to the client portal');
  }

  if (existingUser && existingUser.is_client) {
    throw new Error('A client user with this email already exists');
  }

  const { data: pending } = await db
    .from('client_portal_invitations')
    .select('id')
    .eq('account_id', accountId)
    .eq('email', normalizedEmail)
    .eq('status', 'pending')
    .maybeSingle();

  if (pending) {
    throw new Error('A pending invitation already exists for this email');
  }

  const token = crypto.randomBytes(32).toString('hex');
  const days = expiresInDays || 7;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await db
    .from('client_portal_invitations')
    .insert({
      account_id: accountId,
      email: normalizedEmail,
      token,
      status: 'pending',
      invited_by: invitedBy,
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (error) {
    logger.error('sendClientInvitation failed', { accountId, email: normalizedEmail }, error);
    throw error;
  }

  return data;
}

/**
 * Admin: list all client feedback with project/account context.
 */
async function getAllClientFeedback() {
  const db = getDb();

  const { data, error } = await db
    .from('client_feedback')
    .select(
      `
      *,
      projects(id, name, account_id, accounts(id, name)),
      user_profiles:client_user_id(id, name, email)
    `,
    )
    .order('submitted_at', { ascending: false });

  if (error) {
    logger.error('getAllClientFeedback failed', {}, error);
    throw error;
  }

  return data || [];
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

module.exports = {
  getClientProjects,
  getClientProjectById,
  clientApproveProject,
  clientRejectProject,
  submitClientFeedback,
  sendClientInvitation,
  getAllClientFeedback,
};
