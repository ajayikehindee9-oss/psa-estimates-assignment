/**
 * Role Management Service
 * CRUD helpers for roles used by /api/roles/[roleId].
 */
const { createAdminSupabaseClient } = require('@/lib/supabase-server');
const { logger } = require('@/lib/debug-logger');

class RoleManagementService {
  getDb() {
    const admin = createAdminSupabaseClient();
    if (!admin) throw new Error('Database connection failed');
    return admin;
  }

  /**
   * Update a role by id. Accepts a partial body matching updateRoleSchema fields.
   * Returns the updated role row, or null on failure.
   */
  async updateRole(roleId, updates = {}) {
    const db = this.getDb();

    const { data: existing, error: existingError } = await db
      .from('roles')
      .select('*')
      .eq('id', roleId)
      .single();

    if (existingError || !existing) {
      logger.error('updateRole: role not found', { roleId }, existingError);
      return null;
    }

    if (existing.is_system_role) {
      // Allow permission/description tweaks on system roles, but not rename/department moves
      if (updates.name !== undefined && updates.name !== existing.name) {
        throw new Error('Cannot rename system roles');
      }
      if (
        updates.department_id !== undefined &&
        updates.department_id !== existing.department_id
      ) {
        throw new Error('Cannot change department of system roles');
      }
    }

    const allowed = {};
    if (updates.name !== undefined) allowed.name = String(updates.name).trim();
    if (updates.description !== undefined) allowed.description = updates.description;
    if (updates.department_id !== undefined) allowed.department_id = updates.department_id;
    if (updates.hierarchy_level !== undefined) allowed.hierarchy_level = updates.hierarchy_level;
    if (updates.reporting_role_id !== undefined) {
      allowed.reporting_role_id = updates.reporting_role_id;
    }
    if (updates.permissions !== undefined) allowed.permissions = updates.permissions;
    allowed.updated_at = new Date().toISOString();

    const { data, error } = await db
      .from('roles')
      .update(allowed)
      .eq('id', roleId)
      .select(
        `
        *,
        departments:department_id(id, name)
      `,
      )
      .single();

    if (error) {
      logger.error('updateRole failed', { roleId }, error);
      return null;
    }

    return data;
  }
}

const roleManagementService = new RoleManagementService();

module.exports = {
  roleManagementService,
  RoleManagementService,
};
