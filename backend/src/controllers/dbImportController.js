import sqlite3 from 'sqlite3';
import fs from 'fs';
import dbManager from '../config/database.js';

// ─── Helper: ler tabela do SQLite ────────────────────────────────────────────
function sqliteAll(db, sql) {
  return new Promise((resolve) => {
    db.all(sql, [], (err, rows) => {
      if (err) resolve([]);
      else resolve(rows || []);
    });
  });
}

// ─── Helper: listar tabelas do SQLite ────────────────────────────────────────
function sqliteTables(db) {
  return new Promise((resolve) => {
    db.all(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      [],
      (err, rows) => {
        if (err) resolve([]);
        else resolve((rows || []).map(r => r.name));
      }
    );
  });
}

// ─── Helper: obter colunas de uma tabela SQLite ───────────────────────────────
function sqliteColumns(db, table) {
  return new Promise((resolve) => {
    db.all(`PRAGMA table_info("${table}")`, [], (err, rows) => {
      if (err) resolve([]);
      else resolve((rows || []).map(r => r.name));
    });
  });
}

// ─── Mapear tipo SQLite para PostgreSQL ──────────────────────────────────────
function mapType(sqliteType) {
  if (!sqliteType) return 'TEXT';
  const t = sqliteType.toUpperCase();
  if (t.includes('INT')) return 'BIGINT';
  if (t.includes('REAL') || t.includes('FLOAT') || t.includes('DOUBLE')) return 'DOUBLE PRECISION';
  if (t.includes('BLOB')) return 'BYTEA';
  if (t.includes('BOOL')) return 'INTEGER';
  if (t.includes('DATE') || t.includes('TIME')) return 'TEXT';
  return 'TEXT';
}

// ─── Obter schema completo de uma tabela SQLite ───────────────────────────────
function sqliteTableInfo(db, table) {
  return new Promise((resolve) => {
    db.all(`PRAGMA table_info("${table}")`, [], (err, rows) => {
      if (err) resolve([]);
      else resolve(rows || []);
    });
  });
}

// ─── Criar tabela no PostgreSQL baseada no schema do SQLite ──────────────────
async function createTableFromSQLite(pgClient, schemaName, tableName, columns) {
  // Verificar se tabela já existe
  const exists = await pgClient.query(
    `SELECT COUNT(*) as total 
     FROM information_schema.tables 
     WHERE table_schema = $1 AND table_name = $2`,
    [schemaName, tableName]
  );

  if (parseInt(exists.rows[0]?.total) > 0) {
    return { created: false, reason: 'já existe' };
  }

  // Montar CREATE TABLE dinamicamente
  const colDefs = columns.map(col => {
    let def = `"${col.name}" `;

    // ID primário
    if (col.pk === 1 && col.name === 'id') {
      return `"${col.name}" SERIAL PRIMARY KEY`;
    }

    // Tipo
    def += mapType(col.type);

    // NOT NULL
    if (col.notnull && !col.dflt_value) {
      // Não adicionar NOT NULL em colunas que podem ser nulas na prática
    }

    // Default
    if (col.dflt_value !== null && col.dflt_value !== undefined) {
      let dflt = col.dflt_value;
      dflt = dflt.replace(/datetime\('now'\)/gi, 'NOW()');
      dflt = dflt.replace(/CURRENT_TIMESTAMP/gi, 'NOW()');
      def += ` DEFAULT ${dflt}`;
    }

    return def;
  });

  const sql = `CREATE TABLE IF NOT EXISTS "${schemaName}"."${tableName}" (${colDefs.join(', ')})`;

  try {
    await pgClient.query(sql);
    return { created: true };
  } catch (err) {
    return { created: false, reason: err.message };
  }
}

// ─── Importar dados de uma tabela SQLite para PostgreSQL ─────────────────────
async function importTableData(pgClient, schemaName, tableName, rows, columns) {
  if (!rows || rows.length === 0) {
    return { imported: 0, errors: 0 };
  }

  let imported = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const colNames = columns.filter(c => row[c] !== undefined);
      if (colNames.length === 0) continue;

      const values = colNames.map(c => {
        let val = row[c];
        // Converter booleans
        if (val === true) return 1;
        if (val === false) return 0;
        return val;
      });

      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
      const colList = colNames.map(c => `"${c}"`).join(', ');

      await pgClient.query(
        `INSERT INTO "${schemaName}"."${tableName}" (${colList}) 
         VALUES (${placeholders}) 
         ON CONFLICT DO NOTHING`,
        values
      );
      imported++;
    } catch (err) {
      errors++;
    }
  }

  // Resetar sequence se tabela tem coluna id
  if (columns.includes('id')) {
    try {
      await pgClient.query(
        `SELECT setval(
          '"${schemaName}"."${tableName}_id_seq"',
          COALESCE((SELECT MAX(id) FROM "${schemaName}"."${tableName}"), 1)
        )`
      );
    } catch (e) {
      // Sequence pode não existir para tabelas sem SERIAL
    }
  }

  return { imported, errors };
}

// ─── Controller principal ─────────────────────────────────────────────────────
export const importDatabase = async (req, res) => {
  // O arquivo foi enviado via multipart/form-data
  const file = req.file;
  const tenantId = req.headers['x-tenant-id'];
  const overwrite = req.body.overwrite === 'true';

  if (!file) {
    return res.status(400).json({
      success: false,
      message: 'Nenhum arquivo enviado'
    });
  }

  if (!tenantId) {
    fs.unlinkSync(file.path);
    return res.status(400).json({
      success: false,
      message: 'X-Tenant-ID é obrigatório'
    });
  }

  const schemaName = `tenant_${tenantId}`;
  const filePath = file.path;
  const results = [];
  let totalImported = 0;
  let totalErrors = 0;

  // Abrir banco SQLite
  const sqliteDb = await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(
      filePath,
      sqlite3.OPEN_READONLY,
      (err) => {
        if (err) reject(err);
        else resolve(db);
      }
    );
  });

  // Obter conexão PostgreSQL
  const pool = dbManager.getPool();
  const pgClient = await pool.connect();

  try {
    // Garantir que o schema existe
    await pgClient.query(
      `CREATE SCHEMA IF NOT EXISTS "${schemaName}"`
    );

    // Listar todas as tabelas do SQLite
    const tables = await sqliteTables(sqliteDb);
    console.log(`[Import] Tabelas encontradas: ${tables.join(', ')}`);

    // Processar cada tabela
    for (const tableName of tables) {
      try {
        // Obter schema da tabela
        const colInfo = await sqliteTableInfo(sqliteDb, tableName);
        const colNames = colInfo.map(c => c.name);

        // Criar tabela no PG se não existir
        const createResult = await createTableFromSQLite(
          pgClient,
          schemaName,
          tableName,
          colInfo
        );

        // Se overwrite, limpar tabela antes de importar
        if (overwrite && createResult.created === false && createResult.reason === 'já existe') {
          try {
            await pgClient.query(
              `TRUNCATE TABLE "${schemaName}"."${tableName}" CASCADE`
            );
          } catch (e) {
            // Ignorar erro de truncate
          }
        }

        // Ler dados do SQLite
        const rows = await sqliteAll(sqliteDb, `SELECT * FROM "${tableName}"`);

        // Importar dados
        const importResult = await importTableData(
          pgClient,
          schemaName,
          tableName,
          rows,
          colNames
        );

        totalImported += importResult.imported;
        totalErrors += importResult.errors;

        results.push({
          table: tableName,
          status: 'ok',
          rows: rows.length,
          imported: importResult.imported,
          errors: importResult.errors,
          tableCreated: createResult.created,
        });

        console.log(
          `[Import] ${tableName}: ${importResult.imported}/${rows.length} registros`
        );
      } catch (err) {
        results.push({
          table: tableName,
          status: 'erro',
          error: err.message,
        });
        console.error(`[Import] Erro na tabela ${tableName}:`, err.message);
      }
    }

    // Fechar SQLite
    await new Promise(r => sqliteDb.close(r));

    // Remover arquivo temporário
    fs.unlinkSync(filePath);

    return res.json({
      success: true,
      message: `Importação concluída`,
      data: {
        tenant: tenantId,
        schema: schemaName,
        tablesProcessed: tables.length,
        totalImported,
        totalErrors,
        tables: results,
      }
    });

  } catch (err) {
    console.error('[Import] Erro geral:', err.message);

    // Limpar arquivo temporário
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {}

    await new Promise(r => sqliteDb.close(r));

    return res.status(500).json({
      success: false,
      message: `Erro na importação: ${err.message}`
    });
  } finally {
    pgClient.release();
  }
};

// ─── Controller para verificar o banco antes de importar ─────────────────────
export const previewDatabase = async (req, res) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({
      success: false,
      message: 'Nenhum arquivo enviado'
    });
  }

  const filePath = file.path;

  const sqliteDb = await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(
      filePath,
      sqlite3.OPEN_READONLY,
      (err) => {
        if (err) reject(err);
        else resolve(db);
      }
    );
  });

  try {
    const tables = await sqliteTables(sqliteDb);
    const preview = [];

    for (const tableName of tables) {
      const rows = await sqliteAll(
        sqliteDb,
        `SELECT COUNT(*) as total FROM "${tableName}"`
      );
      const cols = await sqliteColumns(sqliteDb, tableName);
      preview.push({
        table: tableName,
        rows: rows[0]?.total || 0,
        columns: cols,
      });
    }

    await new Promise(r => sqliteDb.close(r));
    fs.unlinkSync(filePath);

    return res.json({
      success: true,
      data: {
        tables: preview,
        totalTables: tables.length,
        totalRows: preview.reduce((acc, t) => acc + parseInt(t.rows), 0),
      }
    });
  } catch (err) {
    try { fs.unlinkSync(filePath); } catch (e) {}
    try { await new Promise(r => sqliteDb.close(r)); } catch (e) {}

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};
