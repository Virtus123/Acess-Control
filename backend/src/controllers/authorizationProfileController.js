import dbManager from '../config/database.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import auditService from '../services/auditService.js';

// ============================================
// Helper functions
// ============================================

// Ensure tables exist
async function ensureAuthorizationTables(db) {
  // Profile table
  await db.run(`
    CREATE TABLE IF NOT EXISTS authorization_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      role TEXT DEFAULT 'operador',
      is_default INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Adicionar colunas se não existirem
  try {
    await db.run(`ALTER TABLE authorization_profiles ADD COLUMN role TEXT DEFAULT 'operador'`);
  } catch (e) {}
  
  try {
    await db.run(`ALTER TABLE authorization_profiles ADD COLUMN is_default INTEGER DEFAULT 0`);
  } catch (e) {}

  // Permissions table
  await db.run(`
    CREATE TABLE IF NOT EXISTS authorization_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      module TEXT NOT NULL,
      resource TEXT NOT NULL,
      can_view INTEGER DEFAULT 0,
      can_create INTEGER DEFAULT 0,
      can_edit INTEGER DEFAULT 0,
      can_delete INTEGER DEFAULT 0,
      can_execute INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES authorization_profiles(id) ON DELETE CASCADE,
      UNIQUE(profile_id, module, resource)
    )
  `);

  // Create indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_auth_perms_profile ON authorization_permissions(profile_id)');
}

// Get all profiles
export async function getAllProfiles(req, res) {
  try {
    const db = await dbManager.getConnection(req.headers['x-tenant-id']);
    await ensureAuthorizationTables(db);

    const profiles = await db.all(`
      SELECT id, name, description, role, is_default, created_at, updated_at 
      FROM authorization_profiles 
      ORDER BY name ASC
    `);

    // Get permissions for each profile
    for (const profile of profiles) {
      const permissions = await db.all(`
        SELECT id, module, resource, can_view, can_create, can_edit, can_delete, can_execute
        FROM authorization_permissions 
        WHERE profile_id = ?
      `, [profile.id]);
      
      profile.permissions = permissions;
    }

    res.json({ success: true, data: profiles });
  } catch (error) {
    console.error('Error getting profiles:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}

// Get single profile by ID
export async function getProfileById(req, res) {
  try {
    const { id } = req.params;
    const db = await dbManager.getConnection(req.headers['x-tenant-id']);
    await ensureAuthorizationTables(db);

    const profile = await db.get(`
      SELECT id, name, description, role, is_default, created_at, updated_at 
      FROM authorization_profiles 
      WHERE id = ?
    `, [id]);;

    if (!profile) {
      return res.status(404).json({ success: false, message: 'Perfil não encontrado' });
    }

    const permissions = await db.all(`
      SELECT id, module, resource, can_view, can_create, can_edit, can_delete, can_execute
      FROM authorization_permissions 
      WHERE profile_id = ?
    `, [id]);

    profile.permissions = permissions;

    res.json({ success: true, data: profile });
  } catch (error) {
    console.error('Error getting profile:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}

// Create new profile
export async function createProfile(req, res) {
  try {
    const { name, description, role, is_default, permissions } = req.body;
    const db = await dbManager.getConnection(req.headers['x-tenant-id']);
    await ensureAuthorizationTables(db);

    if (!name) {
      return res.status(400).json({ success: false, message: 'Nome do perfil é obrigatório' });
    }

    // If this is default, remove default from others
    if (is_default) {
      await db.run('UPDATE authorization_profiles SET is_default = 0');
    }

    // Insert profile
    await db.run(`
      INSERT INTO authorization_profiles (name, description, role, is_default)
      VALUES (?, ?, ?, ?)
    `, [name, description || null, role || 'operador', is_default ? 1 : 0]);

    // Get the last inserted ID
    const lastIdResult = await db.get('SELECT last_insert_rowid() as id');
    const profileId = lastIdResult.id;

    console.log('[createProfile] Profile created with ID:', profileId);

    // Insert permissions if provided
    if (permissions && Array.isArray(permissions) && permissions.length > 0) {
      for (const perm of permissions) {
        await db.run(`
          INSERT INTO authorization_permissions 
          (profile_id, module, resource, can_view, can_create, can_edit, can_delete, can_execute)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          profileId,
          perm.module,
          perm.resource,
          perm.can_view ? 1 : 0,
          perm.can_create ? 1 : 0,
          perm.can_edit ? 1 : 0,
          perm.can_delete ? 1 : 0,
          perm.can_execute ? 1 : 0
        ]);
      }
    }

    // Return created profile
    const newProfile = await db.get(`
      SELECT id, name, description, role, is_default, created_at, updated_at 
      FROM authorization_profiles 
      WHERE id = ?
    `, [profileId]);

    const newPermissions = await db.all(`
      SELECT id, module, resource, can_view, can_create, can_edit, can_delete, can_execute
      FROM authorization_permissions 
      WHERE profile_id = ?
    `, [profileId]);

    newProfile.permissions = newPermissions;

    res.json({ success: true, data: newProfile });

    // Log audit
    await auditService.logCreate(req, 'auth_profile', newProfile.id, `Criação de perfil de acesso: ${newProfile.name}`, newProfile);
  } catch (error) {
    console.error('Error creating profile:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}

// Update profile
export async function updateProfile(req, res) {
  try {
    const { id } = req.params;
    const { name, description, role, is_default, permissions } = req.body;
    const db = await dbManager.getConnection(req.headers['x-tenant-id']);
    await ensureAuthorizationTables(db);

    // Check if profile exists
    const existing = await db.get('SELECT id FROM authorization_profiles WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Perfil não encontrado' });
    }

    if (!name) {
      return res.status(400).json({ success: false, message: 'Nome do perfil é obrigatório' });
    }

    // If this is default, remove default from others
    if (is_default) {
      await db.run('UPDATE authorization_profiles SET is_default = 0 WHERE id != ?', [id]);
    }

    // Update profile
    await db.run(`
      UPDATE authorization_profiles 
      SET name = ?, description = ?, role = ?, is_default = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [name, description || null, role || 'operador', is_default ? 1 : 0, id]);

    // Delete existing permissions
    await db.run('DELETE FROM authorization_permissions WHERE profile_id = ?', [id]);

    // Insert new permissions
    if (permissions && Array.isArray(permissions)) {
      for (const perm of permissions) {
        await db.run(`
          INSERT INTO authorization_permissions 
          (profile_id, module, resource, can_view, can_create, can_edit, can_delete, can_execute)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          id,
          perm.module,
          perm.resource,
          perm.can_view ? 1 : 0,
          perm.can_create ? 1 : 0,
          perm.can_edit ? 1 : 0,
          perm.can_delete ? 1 : 0,
          perm.can_execute ? 1 : 0
        ]);
      }
    }

    // Return updated profile
    const updatedProfile = await db.get(`
      SELECT id, name, description, role, is_default, created_at, updated_at 
      FROM authorization_profiles 
      WHERE id = ?
    `, [id]);

    const updatedPermissions = await db.all(`
      SELECT id, module, resource, can_view, can_create, can_edit, can_delete, can_execute
      FROM authorization_permissions 
      WHERE profile_id = ?
    `, [id]);

    updatedProfile.permissions = updatedPermissions;

    res.json({ success: true, data: updatedProfile });

    // Log audit
    await auditService.logUpdate(req, 'auth_profile', id, `Atualização de perfil de acesso: ${updatedProfile.name}`, existing, updatedProfile);
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}

// Delete profile
export async function deleteProfile(req, res) {
  try {
    const { id } = req.params;
    const db = await dbManager.getConnection(req.headers['x-tenant-id']);
    await ensureAuthorizationTables(db);

    // Check if profile exists
    const existing = await db.get('SELECT id, is_default FROM authorization_profiles WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Perfil não encontrado' });
    }

    // Check if it's the last default profile
    if (existing.is_default) {
      const otherDefaults = await db.get('SELECT COUNT(*) as count FROM authorization_profiles WHERE is_default = 1 AND id != ?', [id]);
      if (!otherDefaults || otherDefaults.count === 0) {
        return res.status(400).json({ success: false, message: 'Não é possível excluir o único perfil padrão' });
      }
    }

    // Delete permissions first (cascade should handle this, but being explicit)
    await db.run('DELETE FROM authorization_permissions WHERE profile_id = ?', [id]);
    
    // Delete profile
    await db.run('DELETE FROM authorization_profiles WHERE id = ?', [id]);

    res.json({ success: true, message: 'Perfil excluído com sucesso' });

    // Log audit
    await auditService.logDelete(req, 'auth_profile', id, `Exclusão de perfil de acesso: ${existing.name || id}`, existing);
  } catch (error) {
    console.error('Error deleting profile:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}

// Get available modules/resources (for frontend to build permission UI)
export async function getAvailablePermissions(req, res) {
  try {
    // Return a default list of modules and resources
    const modules = [
      {
        id: 'dashboard',
        name: 'Dashboard',
        resources: ['view']
      },
      {
        id: 'visitantes',
        name: 'Visitantes',
        resources: ['view', 'create', 'edit', 'delete']
      },
      {
        id: 'pessoas',
        name: 'Pessoas',
        resources: ['view', 'create', 'edit', 'delete']
      },
      {
        id: 'empresas',
        name: 'Empresas',
        resources: ['view', 'create', 'edit', 'delete']
      },
      {
        id: 'grupos',
        name: 'Grupos',
        resources: ['view', 'create', 'edit', 'delete']
      },
      {
        id: 'equipamentos',
        name: 'Equipamentos',
        resources: ['view', 'create', 'edit', 'delete', 'execute']
      },
      {
        id: 'veiculos',
        name: 'Veículos',
        resources: ['view', 'create', 'edit', 'delete']
      },
      {
        id: 'relatorios',
        name: 'Relatórios',
        resources: ['view', 'export']
      },
      {
        id: 'configuracoes',
        name: 'Configurações',
        resources: ['view', 'edit']
      },
      {
        id: 'autorizacao',
        name: 'Autorização',
        resources: ['view', 'create', 'edit', 'delete']
      },
      {
        id: 'claviculario',
        name: 'Chaveiro',
        resources: ['view', 'create', 'edit', 'delete']
      },
      {
        id: 'encomendas',
        name: 'Encomendas',
        resources: ['view', 'create', 'edit', 'delete']
      },
      {
        id: 'estacionamentos',
        name: 'Estacionamentos',
        resources: ['view', 'create', 'edit', 'delete']
      },
      {
        id: 'refeitorio',
        name: 'Refeitório',
        resources: ['view', 'create', 'edit', 'delete']
      },
      {
        id: 'feriados',
        name: 'Feriados',
        resources: ['view', 'create', 'edit', 'delete']
      }
    ];

    res.json({ success: true, data: modules });
  } catch (error) {
    console.error('Error getting available permissions:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}
