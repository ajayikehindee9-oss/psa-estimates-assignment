/**
 * Workflow Execution Service
 * Active-step progression, project start, and user-facing approval/project lists.
 */
const { createAdminSupabaseClient } = require('@/lib/supabase-server');
const { logger } = require('@/lib/debug-logger');

function getDb(supabaseClient) {
  if (supabaseClient) return supabaseClient;
  const admin = createAdminSupabaseClient();
  if (!admin) throw new Error('Database connection failed');
  return admin;
}

async function buildTemplateSnapshot(db, workflowTemplateId) {
  const [{ data: nodes }, { data: connections }, { data: template }] = await Promise.all([
    db.from('workflow_nodes').select('*').eq('workflow_template_id', workflowTemplateId),
    db.from('workflow_connections').select('*').eq('workflow_template_id', workflowTemplateId),
    db
      .from('workflow_templates')
      .select('id, name, description, is_active')
      .eq('id', workflowTemplateId)
      .single(),
  ]);

  return {
    template: template || { id: workflowTemplateId },
    nodes: nodes || [],
    connections: connections || [],
    captured_at: new Date().toISOString(),
  };
}

function safeParse(value) {
  if (value == null || typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Active steps only (status === 'active').
 */
async function getActiveSteps(supabase, workflowInstanceId) {
  const db = getDb(supabase);
  const { data, error } = await db
    .from('workflow_active_steps')
    .select('*')
    .eq('workflow_instance_id', workflowInstanceId)
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('getActiveSteps failed', { workflowInstanceId }, error);
    throw error;
  }
  return data || [];
}

/**
 * Active + waiting steps (parallel branch support).
 * Falls back to active-only if 'waiting' is not used in this DB.
 */
async function getAllActiveAndWaitingSteps(supabase, workflowInstanceId) {
  const db = getDb(supabase);
  const { data, error } = await db
    .from('workflow_active_steps')
    .select('*')
    .eq('workflow_instance_id', workflowInstanceId)
    .in('status', ['active', 'waiting'])
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('getAllActiveAndWaitingSteps failed', { workflowInstanceId }, error);
    // Soft-fail to active-only if enum rejects 'waiting'
    return getActiveSteps(supabase, workflowInstanceId);
  }
  return data || [];
}

/**
 * True when the instance is completed or has no remaining active/waiting steps
 * and current node is an end node.
 */
async function isWorkflowComplete(supabase, workflowInstanceId) {
  const db = getDb(supabase);

  const { data: instance } = await db
    .from('workflow_instances')
    .select('id, status, current_node_id, started_snapshot')
    .eq('id', workflowInstanceId)
    .maybeSingle();

  if (!instance) return false;
  if (instance.status === 'completed' || instance.status === 'cancelled') return true;

  const active = await getAllActiveAndWaitingSteps(supabase, workflowInstanceId);
  if (active.length > 0) return false;

  const nodes = instance.started_snapshot?.nodes || [];
  const current = nodes.find((n) => n.id === instance.current_node_id);
  if (current?.node_type === 'end') return true;

  if (instance.current_node_id) {
    const { data: node } = await db
      .from('workflow_nodes')
      .select('node_type')
      .eq('id', instance.current_node_id)
      .maybeSingle();
    if (node?.node_type === 'end') return true;
  }

  return false;
}

function matchDecisionConnection(connections, decision) {
  if (!connections || connections.length === 0) return null;
  if (!decision) return connections[0];

  const d = String(decision).toLowerCase();
  const matched = connections.find((c) => {
    const cond = safeParse(c.condition) || {};
    const candidates = [
      cond.decision,
      cond.label,
      cond.conditionValue,
      cond.value,
      cond.sourceHandle,
    ]
      .filter(Boolean)
      .map((v) => String(v).toLowerCase());
    return candidates.some((v) => v === d || v.includes(d) || d.includes(v));
  });

  return matched || connections[0];
}

async function resolveOutgoingConnections(db, instance, fromNodeId) {
  const { data: live } = await db
    .from('workflow_connections')
    .select('*')
    .eq('from_node_id', fromNodeId);

  if (live && live.length > 0) return live;

  const snapshotConnections = instance.started_snapshot?.connections || [];
  return snapshotConnections.filter((c) => c.from_node_id === fromNodeId);
}

async function resolveNode(db, instance, nodeId) {
  const { data: live } = await db
    .from('workflow_nodes')
    .select('*')
    .eq('id', nodeId)
    .maybeSingle();
  if (live) return live;
  return (instance.started_snapshot?.nodes || []).find((n) => n.id === nodeId) || null;
}

/**
 * Progress a workflow step (supports parallel via activeStepId + assignedUsersPerNode).
 * Returns { success, nextNode, newActiveSteps, error }.
 */
async function progressWorkflowStep(
  supabase,
  workflowInstanceId,
  activeStepId,
  userId,
  decision,
  feedback,
  formResponseId,
  assignedUserId,
  formData,
  assignedUsersPerNode,
) {
  const db = getDb(supabase);

  try {
    const { data: instance, error: instanceError } = await db
      .from('workflow_instances')
      .select('*')
      .eq('id', workflowInstanceId)
      .single();

    if (instanceError || !instance) {
      return { success: false, error: 'Workflow instance not found' };
    }
    if (instance.status !== 'active') {
      return { success: false, error: 'Workflow is not active' };
    }

    let step = null;
    if (activeStepId) {
      const { data } = await db
        .from('workflow_active_steps')
        .select('*')
        .eq('id', activeStepId)
        .eq('workflow_instance_id', workflowInstanceId)
        .maybeSingle();
      step = data;
    } else if (instance.current_node_id) {
      const { data } = await db
        .from('workflow_active_steps')
        .select('*')
        .eq('workflow_instance_id', workflowInstanceId)
        .eq('node_id', instance.current_node_id)
        .eq('status', 'active')
        .maybeSingle();
      step = data;
    }

    const fromNodeId = step?.node_id || instance.current_node_id;
    if (!fromNodeId) {
      return { success: false, error: 'No active step to progress' };
    }

    const branchId = step?.branch_id || 'main';
    const connections = await resolveOutgoingConnections(db, instance, fromNodeId);

    // Parallel fan-out: if multiple unconditional outs and no decision, activate all
    let targets = [];
    if (decision || connections.length <= 1) {
      const chosen = matchDecisionConnection(connections, decision);
      if (chosen) targets = [chosen];
    } else {
      targets = connections;
    }

    if (targets.length === 0) {
      // No outgoing edges — complete current step; mark workflow complete if end node
      const fromNode = await resolveNode(db, instance, fromNodeId);
      if (step) {
        await db
          .from('workflow_active_steps')
          .update({ status: 'completed', completed_at: new Date().toISOString() })
          .eq('id', step.id);
      }
      if (fromNode?.node_type === 'end') {
        await db
          .from('workflow_instances')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', workflowInstanceId);
      }
      return { success: true, nextNode: fromNode, newActiveSteps: [] };
    }

    // Complete current step
    if (step) {
      await db
        .from('workflow_active_steps')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', step.id);
    } else {
      await db
        .from('workflow_active_steps')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('workflow_instance_id', workflowInstanceId)
        .eq('node_id', fromNodeId)
        .eq('status', 'active');
    }

    const notesParts = [];
    if (feedback) notesParts.push(String(feedback));
    if (formData && typeof formData === 'object') {
      notesParts.push(`formData:${JSON.stringify(formData)}`);
    }

    const newActiveSteps = [];
    let primaryNext = null;

    for (let i = 0; i < targets.length; i++) {
      const conn = targets[i];
      const toNodeId = conn.to_node_id;
      const toNode = await resolveNode(db, instance, toNodeId);

      await db.from('workflow_history').insert({
        workflow_instance_id: workflowInstanceId,
        from_node_id: fromNodeId,
        to_node_id: toNodeId,
        transitioned_by: userId,
        notes: notesParts.length ? notesParts.join('\n') : null,
        transition_type: decision && String(decision).toLowerCase().includes('reject')
          ? 'rejection'
          : 'normal',
        form_response_id: formResponseId || null,
      });

      const assignee =
        (assignedUsersPerNode && assignedUsersPerNode[toNodeId]) ||
        assignedUserId ||
        null;

      const nextBranch =
        targets.length > 1 ? `${branchId}:${toNodeId.slice(0, 8)}` : branchId;

      const { data: newStep, error: stepError } = await db
        .from('workflow_active_steps')
        .insert({
          workflow_instance_id: workflowInstanceId,
          node_id: toNodeId,
          assigned_user_id: assignee,
          branch_id: nextBranch,
          status: 'active',
        })
        .select()
        .single();

      if (stepError) {
        logger.error('progressWorkflowStep insert step failed', { toNodeId }, stepError);
        return { success: false, error: stepError.message || 'Failed to create next step' };
      }

      newActiveSteps.push({ ...newStep, node: toNode });
      if (!primaryNext) primaryNext = toNode;

      if (toNode?.node_type === 'end') {
        // Only mark complete if no other active steps remain
        const remaining = await getActiveSteps(db, workflowInstanceId);
        const others = remaining.filter((s) => s.id !== newStep.id);
        if (others.length === 0) {
          await db
            .from('workflow_instances')
            .update({
              status: 'completed',
              completed_at: new Date().toISOString(),
              current_node_id: toNodeId,
              updated_at: new Date().toISOString(),
            })
            .eq('id', workflowInstanceId);

          await db
            .from('workflow_active_steps')
            .update({ status: 'completed', completed_at: new Date().toISOString() })
            .eq('id', newStep.id);
        }
      }
    }

    // Keep legacy current_node_id pointing at the primary next node
    if (primaryNext) {
      await db
        .from('workflow_instances')
        .update({
          current_node_id: primaryNext.id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', workflowInstanceId)
        .eq('status', 'active');
    }

    return {
      success: true,
      nextNode: primaryNext,
      newActiveSteps,
    };
  } catch (error) {
    logger.error('progressWorkflowStep exception', { workflowInstanceId }, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to progress workflow',
    };
  }
}

/**
 * Start a workflow for a project from a template (finds the start node automatically).
 */
async function startWorkflowForProject(supabase, projectId, workflowTemplateId, userId) {
  const db = getDb(supabase);

  try {
    const { data: project } = await db
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .maybeSingle();
    if (!project) {
      return { success: false, error: 'Project not found' };
    }

    const { data: template } = await db
      .from('workflow_templates')
      .select('*')
      .eq('id', workflowTemplateId)
      .maybeSingle();
    if (!template) {
      return { success: false, error: 'Workflow template not found' };
    }

    const { data: existing } = await db
      .from('workflow_instances')
      .select('id')
      .eq('project_id', projectId)
      .eq('status', 'active')
      .maybeSingle();
    if (existing) {
      return { success: false, error: 'Project already has an active workflow' };
    }

    const { data: nodes } = await db
      .from('workflow_nodes')
      .select('*')
      .eq('workflow_template_id', workflowTemplateId);

    if (!nodes || nodes.length === 0) {
      return { success: false, error: 'Workflow template has no nodes' };
    }

    const startNode = nodes.find((n) => n.node_type === 'start') || nodes[0];

    // Prefer activating the first node after start
    const { data: fromStart } = await db
      .from('workflow_connections')
      .select('*')
      .eq('from_node_id', startNode.id)
      .limit(1);

    const firstWorkingNodeId =
      fromStart && fromStart[0] ? fromStart[0].to_node_id : startNode.id;

    const snapshot = await buildTemplateSnapshot(db, workflowTemplateId);

    const { data: instance, error } = await db
      .from('workflow_instances')
      .insert({
        workflow_template_id: workflowTemplateId,
        project_id: projectId,
        current_node_id: firstWorkingNodeId,
        status: 'active',
        started_snapshot: snapshot,
      })
      .select()
      .single();

    if (error) {
      logger.error('startWorkflowForProject insert failed', { projectId }, error);
      return { success: false, error: error.message || 'Failed to start workflow' };
    }

    // Record start → first node if different
    if (firstWorkingNodeId !== startNode.id) {
      await db.from('workflow_history').insert({
        workflow_instance_id: instance.id,
        from_node_id: startNode.id,
        to_node_id: firstWorkingNodeId,
        transitioned_by: userId,
        notes: 'Workflow started',
        transition_type: 'normal',
      });
    }

    await db.from('workflow_active_steps').insert({
      workflow_instance_id: instance.id,
      node_id: firstWorkingNodeId,
      assigned_user_id: null,
      branch_id: 'main',
      status: 'active',
    });

    return { success: true, workflowInstanceId: instance.id };
  } catch (error) {
    logger.error('startWorkflowForProject exception', { projectId }, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start workflow',
    };
  }
}

/**
 * Pending approval steps for a user based on role/department entity matching.
 */
async function getUserPendingApprovals(supabase, userId) {
  const db = getDb(supabase);

  const { data: userRoles } = await db
    .from('user_roles')
    .select('role_id, roles(id, name, department_id)')
    .eq('user_id', userId)
    .is('removed_at', null);

  const roleIds = (userRoles || [])
    .map((ur) => {
      const roles = Array.isArray(ur.roles) ? ur.roles[0] : ur.roles;
      return roles?.id || ur.role_id;
    })
    .filter(Boolean);

  const departmentIds = (userRoles || [])
    .map((ur) => {
      const roles = Array.isArray(ur.roles) ? ur.roles[0] : ur.roles;
      return roles?.department_id;
    })
    .filter(Boolean);

  const { data: activeSteps, error } = await db
    .from('workflow_active_steps')
    .select(
      `
      id,
      workflow_instance_id,
      node_id,
      status,
      assigned_user_id,
      workflow_instances!inner(
        id,
        status,
        project_id,
        workflow_template_id,
        current_node_id,
        started_snapshot,
        projects(
          id,
          name,
          description,
          status,
          priority,
          account_id,
          accounts(id, name)
        )
      )
    `,
    )
    .eq('status', 'active');

  if (error) {
    logger.error('getUserPendingApprovals failed', { userId }, error);
    throw error;
  }

  const approvals = [];

  for (const step of activeSteps || []) {
    const instance = Array.isArray(step.workflow_instances)
      ? step.workflow_instances[0]
      : step.workflow_instances;
    if (!instance || instance.status !== 'active') continue;

    // Direct assignment always matches
    if (step.assigned_user_id && step.assigned_user_id === userId) {
      // fall through
    } else if (step.assigned_user_id && step.assigned_user_id !== userId) {
      continue;
    }

    const snapshot = instance.started_snapshot || {};
    const nodes = snapshot.nodes || [];
    let node = nodes.find((n) => n.id === step.node_id);

    if (!node) {
      const { data: liveNode } = await db
        .from('workflow_nodes')
        .select('*')
        .eq('id', step.node_id)
        .maybeSingle();
      node = liveNode;
    }

    if (!node) continue;
    if (node.node_type !== 'approval' && node.node_type !== 'client') {
      // Still include role/department work waiting on the user if assigned
      if (!(step.assigned_user_id === userId)) {
        if (node.entity_id) {
          if (!roleIds.includes(node.entity_id) && !departmentIds.includes(node.entity_id)) {
            continue;
          }
        } else {
          continue;
        }
      }
    } else if (node.entity_id) {
      if (!roleIds.includes(node.entity_id) && !departmentIds.includes(node.entity_id)) {
        if (step.assigned_user_id !== userId) continue;
      }
    }

    approvals.push({
      ...instance,
      workflow_nodes: node,
      projects: instance.projects,
      active_step_id: step.id,
      current_node_id: step.node_id,
    });
  }

  return approvals;
}

/**
 * Active project assignments for a user (non-complete projects).
 */
async function getUserActiveProjects(supabase, userId) {
  const db = getDb(supabase);

  const { data, error } = await db
    .from('project_assignments')
    .select(
      `
      *,
      projects!inner(
        id,
        name,
        description,
        status,
        priority,
        created_at,
        account_id,
        estimated_hours,
        actual_hours,
        end_date,
        start_date,
        accounts(id, name)
      ),
      user_profiles(
        id,
        name,
        email
      )
    `,
    )
    .eq('user_id', userId)
    .is('removed_at', null);

  if (error) {
    logger.error('getUserActiveProjects failed', { userId }, error);
    throw error;
  }

  return (data || [])
    .filter((row) => {
      const projects = row.projects;
      const project = Array.isArray(projects) ? projects[0] : projects;
      return project && project.status !== 'complete';
    })
    .map((row) => {
      const userProfiles = row.user_profiles;
      const profile = Array.isArray(userProfiles) ? userProfiles[0] : userProfiles;
      return {
        ...row,
        assigned_user: profile
          ? { id: profile.id, name: profile.name, email: profile.email }
          : undefined,
      };
    });
}

module.exports = {
  getActiveSteps,
  getAllActiveAndWaitingSteps,
  isWorkflowComplete,
  progressWorkflowStep,
  startWorkflowForProject,
  getUserPendingApprovals,
  getUserActiveProjects,
};
