/**
 * Workflow Service
 * Template/node/connection CRUD plus instance start, history, handoff helpers.
 */
const { createAdminSupabaseClient } = require('@/lib/supabase-server');
const { logger } = require('@/lib/debug-logger');

function getDb(supabaseClient) {
  if (supabaseClient) return supabaseClient;
  const admin = createAdminSupabaseClient();
  if (!admin) throw new Error('Database connection failed');
  return admin;
}

function safeParse(value) {
  if (value == null || typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function getWorkflowTemplates() {
  const db = getDb();
  const { data, error } = await db
    .from('workflow_templates')
    .select('*')
    .eq('is_active', true)
    .order('name', { ascending: true });

  if (error) {
    logger.error('getWorkflowTemplates failed', {}, error);
    throw error;
  }
  return data || [];
}

async function getAllWorkflowTemplates() {
  const db = getDb();
  const { data, error } = await db
    .from('workflow_templates')
    .select('*')
    .order('name', { ascending: true });

  if (error) {
    logger.error('getAllWorkflowTemplates failed', {}, error);
    throw error;
  }
  return data || [];
}

async function createWorkflowTemplate(name, description, createdBy) {
  const db = getDb();
  const { data, error } = await db
    .from('workflow_templates')
    .insert({
      name,
      description: description || null,
      created_by: createdBy,
      is_active: false,
    })
    .select()
    .single();

  if (error) {
    logger.error('createWorkflowTemplate failed', { name }, error);
    throw error;
  }
  return data;
}

async function getWorkflowTemplateById(id) {
  const db = getDb();
  const { data, error } = await db
    .from('workflow_templates')
    .select(
      `
      *,
      workflow_nodes(*),
      workflow_connections(*)
    `,
    )
    .eq('id', id)
    .maybeSingle();

  if (error) {
    logger.error('getWorkflowTemplateById failed', { id }, error);
    throw error;
  }
  return data || null;
}

async function updateWorkflowTemplate(id, updates = {}, supabaseClient = null) {
  const db = getDb(supabaseClient);
  const payload = { ...updates, updated_at: new Date().toISOString() };
  if (payload.description === undefined) {
    // leave alone
  }

  const { data, error } = await db
    .from('workflow_templates')
    .update(payload)
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) {
    logger.error('updateWorkflowTemplate failed', { id }, error);
    throw error;
  }
  return data || null;
}

async function deleteWorkflowTemplate(id, supabaseClient = null) {
  const db = getDb(supabaseClient);

  // Connections cascade with nodes; delete connections/nodes explicitly for clarity
  await db.from('workflow_connections').delete().eq('workflow_template_id', id);
  await db.from('workflow_nodes').delete().eq('workflow_template_id', id);

  const { error } = await db.from('workflow_templates').delete().eq('id', id);
  if (error) {
    logger.error('deleteWorkflowTemplate failed', { id }, error);
    throw error;
  }
  return true;
}

async function createWorkflowNode(templateId, nodeData = {}) {
  const db = getDb();
  // Match columns used by admin steps/save + seed (schema.sql is slightly behind)
  const insert = {
    workflow_template_id: templateId,
    label: nodeData.label,
    node_type: nodeData.node_type,
    entity_id: nodeData.entity_id ?? null,
    position_x: nodeData.position_x ?? 0,
    position_y: nodeData.position_y ?? 0,
    form_template_id: nodeData.form_template_id ?? null,
    settings: nodeData.settings ?? {},
  };
  if (nodeData.requires_form !== undefined) {
    insert.requires_form = nodeData.requires_form;
  }

  const { data, error } = await db.from('workflow_nodes').insert(insert).select().single();

  if (error) {
    logger.error('createWorkflowNode failed', { templateId }, error);
    throw error;
  }
  return data;
}

async function updateWorkflowNode(nodeId, updates = {}) {
  const db = getDb();
  const payload = { ...updates, updated_at: new Date().toISOString() };

  const { data, error } = await db
    .from('workflow_nodes')
    .update(payload)
    .eq('id', nodeId)
    .select()
    .maybeSingle();

  if (error) {
    logger.error('updateWorkflowNode failed', { nodeId }, error);
    throw error;
  }
  return data || null;
}

async function deleteWorkflowNode(nodeId) {
  const db = getDb();

  await db.from('workflow_connections').delete().or(`from_node_id.eq.${nodeId},to_node_id.eq.${nodeId}`);

  const { error } = await db.from('workflow_nodes').delete().eq('id', nodeId);
  if (error) {
    logger.error('deleteWorkflowNode failed', { nodeId }, error);
    throw error;
  }
  return true;
}

async function createWorkflowConnection(templateId, fromNodeId, toNodeId, condition = null) {
  const db = getDb();
  const { data, error } = await db
    .from('workflow_connections')
    .insert({
      workflow_template_id: templateId,
      from_node_id: fromNodeId,
      to_node_id: toNodeId,
      condition: condition ?? null,
    })
    .select()
    .single();

  if (error) {
    logger.error('createWorkflowConnection failed', { templateId }, error);
    throw error;
  }
  return data;
}

async function deleteWorkflowConnection(connectionId) {
  const db = getDb();
  const { error } = await db.from('workflow_connections').delete().eq('id', connectionId);
  if (error) {
    logger.error('deleteWorkflowConnection failed', { connectionId }, error);
    throw error;
  }
  return true;
}

/**
 * Build a started_snapshot of the template graph for an instance.
 */
async function buildTemplateSnapshot(db, workflowTemplateId) {
  const [{ data: nodes }, { data: connections }, { data: template }] = await Promise.all([
    db.from('workflow_nodes').select('*').eq('workflow_template_id', workflowTemplateId),
    db.from('workflow_connections').select('*').eq('workflow_template_id', workflowTemplateId),
    db.from('workflow_templates').select('id, name, description, is_active').eq('id', workflowTemplateId).single(),
  ]);

  return {
    template: template || { id: workflowTemplateId },
    nodes: nodes || [],
    connections: connections || [],
    captured_at: new Date().toISOString(),
  };
}

async function startWorkflowInstance({
  workflowTemplateId,
  projectId = null,
  taskId = null,
  startNodeId,
}) {
  const db = getDb();

  const { data: template, error: templateError } = await db
    .from('workflow_templates')
    .select('*')
    .eq('id', workflowTemplateId)
    .single();

  if (templateError || !template) {
    throw new Error('Workflow template not found');
  }
  if (!template.is_active) {
    throw new Error('Workflow template is not active');
  }

  const { data: nodes, error: nodesError } = await db
    .from('workflow_nodes')
    .select('*')
    .eq('workflow_template_id', workflowTemplateId);

  if (nodesError) throw nodesError;
  if (!nodes || nodes.length === 0) {
    throw new Error('Workflow template has no nodes');
  }

  const startNode = nodes.find((n) => n.id === startNodeId);
  if (!startNode) {
    throw new Error('Invalid start node');
  }

  if (projectId) {
    const { data: existing } = await db
      .from('workflow_instances')
      .select('id')
      .eq('project_id', projectId)
      .eq('status', 'active')
      .maybeSingle();
    if (existing) {
      throw new Error('Project already has an active workflow');
    }
  }

  const snapshot = await buildTemplateSnapshot(db, workflowTemplateId);

  const { data: instance, error } = await db
    .from('workflow_instances')
    .insert({
      workflow_template_id: workflowTemplateId,
      project_id: projectId,
      task_id: taskId,
      current_node_id: startNodeId,
      status: 'active',
      started_snapshot: snapshot,
    })
    .select()
    .single();

  if (error) {
    logger.error('startWorkflowInstance failed', { workflowTemplateId }, error);
    throw error;
  }

  await db.from('workflow_active_steps').insert({
    workflow_instance_id: instance.id,
    node_id: startNodeId,
    assigned_user_id: null,
    branch_id: 'main',
    status: 'active',
  });

  return instance;
}

async function getWorkflowInstanceById(id) {
  const db = getDb();
  const { data, error } = await db
    .from('workflow_instances')
    .select(
      `
      *,
      workflow_templates(id, name, description, is_active),
      projects(id, name, status, account_id),
      workflow_nodes:current_node_id(id, label, node_type, entity_id, form_template_id, settings)
    `,
    )
    .eq('id', id)
    .maybeSingle();

  if (error) {
    logger.error('getWorkflowInstanceById failed', { id }, error);
    throw error;
  }
  return data || null;
}

async function getWorkflowHistory(instanceId) {
  const db = getDb();
  const { data, error } = await db
    .from('workflow_history')
    .select(
      `
      *,
      from_node:from_node_id(id, label, node_type),
      to_node:to_node_id(id, label, node_type),
      transitioned_by_user:transitioned_by(id, name, email)
    `,
    )
    .eq('workflow_instance_id', instanceId)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('getWorkflowHistory failed', { instanceId }, error);
    throw error;
  }
  return data || [];
}

async function getNextAvailableNodes(instanceId) {
  const db = getDb();

  const { data: instance, error } = await db
    .from('workflow_instances')
    .select('id, current_node_id, started_snapshot, workflow_template_id, status')
    .eq('id', instanceId)
    .single();

  if (error || !instance) {
    throw new Error('Workflow instance not found');
  }
  if (!instance.current_node_id) return [];

  // Prefer live connections; fall back to snapshot
  let connections = [];
  const { data: liveConnections } = await db
    .from('workflow_connections')
    .select('*')
    .eq('from_node_id', instance.current_node_id);

  if (liveConnections && liveConnections.length > 0) {
    connections = liveConnections;
  } else {
    const snapshotConnections = instance.started_snapshot?.connections || [];
    connections = snapshotConnections.filter((c) => c.from_node_id === instance.current_node_id);
  }

  const toNodeIds = connections.map((c) => c.to_node_id).filter(Boolean);
  if (toNodeIds.length === 0) return [];

  const { data: nodes } = await db.from('workflow_nodes').select('*').in('id', toNodeIds);

  const nodeMap = new Map((nodes || []).map((n) => [n.id, n]));
  // Fill from snapshot if live nodes missing (template deleted)
  for (const n of instance.started_snapshot?.nodes || []) {
    if (!nodeMap.has(n.id)) nodeMap.set(n.id, n);
  }

  return connections
    .map((c) => {
      const node = nodeMap.get(c.to_node_id);
      if (!node) return null;
      return {
        ...node,
        connection: {
          id: c.id,
          condition: safeParse(c.condition),
        },
      };
    })
    .filter(Boolean);
}

/**
 * Hand off work from the current node to a target node.
 */
async function handoffWorkflow(supabaseClient, params) {
  const {
    instanceId,
    toNodeId,
    handedOffBy,
    handedOffTo = null,
    formResponseId = null,
    notes = null,
    outOfOrder = false,
  } = params;

  const db = getDb(supabaseClient);

  const { data: instance, error } = await db
    .from('workflow_instances')
    .select('*')
    .eq('id', instanceId)
    .single();

  if (error || !instance) {
    throw new Error('Workflow instance not found');
  }
  if (instance.status !== 'active') {
    throw new Error('Workflow is not active');
  }

  const fromNodeId = instance.current_node_id;
  if (!fromNodeId) {
    throw new Error('Workflow has no current node');
  }

  const { data: historyEntry, error: historyError } = await db
    .from('workflow_history')
    .insert({
      workflow_instance_id: instanceId,
      from_node_id: fromNodeId,
      to_node_id: toNodeId,
      transitioned_by: handedOffBy,
      notes,
      transition_type: outOfOrder ? 'skip' : 'normal',
      out_of_order: !!outOfOrder,
      form_response_id: formResponseId,
    })
    .select()
    .single();

  if (historyError) {
    logger.error('handoffWorkflow history insert failed', { instanceId }, historyError);
    throw historyError;
  }

  await db
    .from('workflow_active_steps')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('workflow_instance_id', instanceId)
    .eq('node_id', fromNodeId)
    .eq('status', 'active');

  await db
    .from('workflow_instances')
    .update({ current_node_id: toNodeId, updated_at: new Date().toISOString() })
    .eq('id', instanceId);

  await db.from('workflow_active_steps').insert({
    workflow_instance_id: instanceId,
    node_id: toNodeId,
    assigned_user_id: handedOffTo,
    branch_id: 'main',
    status: 'active',
  });

  if (handedOffTo) {
    const { data: existingAssignment } = await db
      .from('workflow_node_assignments')
      .select('id')
      .eq('workflow_node_id', toNodeId)
      .eq('assigned_user_id', handedOffTo)
      .maybeSingle();

    if (!existingAssignment) {
      await db.from('workflow_node_assignments').insert({
        workflow_node_id: toNodeId,
        assigned_user_id: handedOffTo,
      });
    }
  }

  const { data: toNode } = await db
    .from('workflow_nodes')
    .select('id, node_type')
    .eq('id', toNodeId)
    .maybeSingle();

  if (toNode?.node_type === 'end') {
    await db
      .from('workflow_instances')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', instanceId);

    await db
      .from('workflow_active_steps')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('workflow_instance_id', instanceId)
      .eq('status', 'active');
  }

  return historyEntry;
}

module.exports = {
  getWorkflowTemplates,
  getAllWorkflowTemplates,
  createWorkflowTemplate,
  getWorkflowTemplateById,
  updateWorkflowTemplate,
  deleteWorkflowTemplate,
  createWorkflowNode,
  updateWorkflowNode,
  deleteWorkflowNode,
  createWorkflowConnection,
  deleteWorkflowConnection,
  startWorkflowInstance,
  getWorkflowInstanceById,
  getWorkflowHistory,
  getNextAvailableNodes,
  handoffWorkflow,
  buildTemplateSnapshot,
};
