/**
 * Controller de Importação de Dados
 * Gerencia importação de pessoas e visitantes via CSV/ZIP
 * 
 * Ordem de importação:
 * - Pessoas: Empresas.csv → Grupos.csv → Pessoas.csv
 * - Visitantes: Visitantes.csv
 */

import { getTenantDatabase } from '../middleware/tenantManager.js';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'imports');
        await fs.promises.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 2147483648 }, // 2GB limit for large imports
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['text/csv', 'application/zip', 'application/x-zip-compressed'];
        if (file.mimetype === 'text/plain' && file.originalname.endsWith('.csv')) {
            cb(null, true);
        } else if (allowedTypes.includes(file.mimetype) || file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('Tipo de arquivo inválido. Use CSV ou ZIP.'));
        }
    }
});

class ImportController {
    // Upload files and start import process
    async uploadAndStartImport(req, res) {
        try {
            // Accept tenant_id from body or query parameter
            const tenant_id = req.body.tenant_id || req.query.tenant_id;
            const { type, import_with_photo, import_as_inactive, layout, import_vehicles, vehicles_rotative, import_visitors, visitors_as_inactive } = req.body;

            if (!tenant_id || !type) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetros obrigatórios: tenant_id, type'
                });
            }

            // Default to layout 1 if not specified
            const importLayout = layout || '1';
            const isVehiclesImport = import_vehicles === 'true' || import_vehicles === true;
            const isVehiclesRotative = vehicles_rotative === 'true' || vehicles_rotative === true;
            const isVisitorsImport = import_visitors === 'true' || import_visitors === true;
            const isVisitorsInactive = visitors_as_inactive === 'true' || visitors_as_inactive === true;

            const isPerson = type === 'person';
            let csvFile = null;
            let zipFile = null;

            if (isPerson) {
                // For persons: ZIP is REQUIRED containing pessoas.csv, empresas.csv, grupos.csv (and optional photos)
                if (!req.files || !req.files.zip) {
                    return res.status(400).json({
                        success: false,
                        message: 'Para importação de pessoas, o arquivo ZIP é obrigatório e deve conter: pessoas.csv, empresas.csv, grupos.csv'
                    });
                }
                zipFile = req.files.zip[0];

                // Validate ZIP file
                if (!zipFile.originalname.toLowerCase().endsWith('.zip')) {
                    return res.status(400).json({
                        success: false,
                        message: 'Arquivo ZIP inválido para importação de pessoas'
                    });
                }
            } else {
                // For visitors: CSV is REQUIRED, ZIP is optional (for photos)
                if (!req.files || !req.files.csv) {
                    return res.status(400).json({
                        success: false,
                        message: 'Arquivo CSV é obrigatório para importação de visitantes'
                    });
                }
                csvFile = req.files.csv[0];
                zipFile = req.files.zip ? req.files.zip[0] : null;

                // Validate CSV file
                if (!csvFile.originalname.toLowerCase().endsWith('.csv')) {
                    return res.status(400).json({
                        success: false,
                        message: 'Arquivo CSV inválido'
                    });
                }
            }

            const db = await getTenantDatabase(tenant_id);

            // Create import record
            const importRecord = await db.run(
                `INSERT INTO imports (tenant_id, type, import_with_photo, import_as_inactive, status, file_path) 
                 VALUES (?, ?, ?, ?, 'pending', ?)`,
                [tenant_id, type, zipFile ? 1 : 0, import_as_inactive === 'true' ? 1 : 0, zipFile ? zipFile.filename : csvFile.filename]
            );

            // Process the import
            const result = await this.processImport(tenant_id, importRecord.lastID, csvFile, zipFile, isPerson, import_as_inactive === 'true', importLayout, isVehiclesImport, isVehiclesRotative, isVisitorsImport, isVisitorsInactive);

            return res.json({
                success: true,
                message: 'Importação concluída',
                data: result
            });

        } catch (error) {
            console.error('[Import] Erro ao processar importação:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao processar importação: ' + error.message
            });
        }
    }

    // Process import - main logic
    async processImport(tenantId, importId, csvFile, zipFile, isPerson, importAsInactive = false, importLayout = '1', importVehicles = false, vehiclesRotative = false, importVisitors = false, visitorsInactive = false) {
        const db = await getTenantDatabase(tenantId);
        const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'imports');

        // Extract ZIP if exists
        let extractDir = null;
        if (zipFile) {
            const zipPath = path.join(uploadDir, zipFile.filename);
            extractDir = path.join(uploadDir, `import_${importId}`);
            await this.extractZip(zipPath, extractDir);
            console.log(`[Import] ZIP extraído para: ${extractDir}`);
        }

        let processed = 0; let total = 0;
        let errors = 0;

        // Process based on layout
        if (importLayout === '3') {
            // Layout 3: IDSecure Cloud CSVs
            const result = await this.processLayout3Import(tenantId, db, importId, extractDir, importVehicles, vehiclesRotative, importAsInactive, importVisitors, visitorsInactive);
            processed = result.processed;
            errors = result.errors;
            total = result.total || 0;
        } else if (importLayout === '2') {
            // Layout 2: Unified import
            const result = await this.processLayout2Import(tenantId, db, importId, extractDir, importVehicles, vehiclesRotative, importAsInactive, importVisitors, visitorsInactive);
            processed = result.processed;
            errors = result.errors;
        } else {
            // Layout 1: Original format
            // Process based on type
            if (isPerson) {
                // For persons: ZIP is REQUIRED and contains Pessoas.csv, Empresas.csv, Grupos.csv
                if (!zipFile) {
                    throw new Error('Para importação de pessoas, o arquivo ZIP é obrigatório e deve conter: pessoas.csv, empresas.csv, grupos.csv');
                }

                // Find pessoas.csv inside extracted folder
                const result = await this.processPersonsFromZip(
                    tenantId, db, importId, extractDir, importAsInactive
                );
                processed = result.processed;
                errors = result.errors;
            } else {
                // For visitors: Can be just CSV or ZIP with visitors.csv + photos
                // Read CSV from the uploaded file
                const csvPath = path.join(uploadDir, csvFile.filename);
                const csvContent = await fs.promises.readFile(csvPath, 'utf-8');
                const lines = csvContent.split('\n').filter(line => line.trim());

                if (lines.length < 2) {
                    throw new Error('CSV vazio ou sem dados');
                }

                // Parse header - detect delimiter
                const firstLine = lines[0];
                const delimiter = firstLine.includes(';') ? ';' : ',';
                const headers = this.parseCSVLine(lines[0], delimiter);
                const dataLines = lines.slice(1);

                // Update total
                await db.run('UPDATE imports SET total = ? WHERE id = ?', [dataLines.length, importId]);

                processed = await this.processVisitorsImport(
                    tenantId, db, importId, headers, dataLines, extractDir, delimiter, importAsInactive
                );
            }
        }

        // Update import status
        await db.run(
            `UPDATE imports SET status = 'finished', processed = ?, errors = ?, 
             finished_at = datetime('now'), updated_at = datetime('now') 
             WHERE id = ?`,
            [processed, errors, importId]
        );

        // Cleanup
        if (extractDir) {
            await this.cleanupDirectory(extractDir);
        }

        return { processed, errors };
    }

    // Full person import from ZIP file containing Pessoas.csv, Empresas.csv, Grupos.csv
    async processPersonsFromZip(tenantId, db, importId, extractDir, importAsInactive = false) {
        if (!extractDir) {
            throw new Error('Diretório extraído não encontrado');
        }

        // Step 1: Import Companies from Empresas.csv inside ZIP
        const companiesMap = await this.importCompaniesFromZip(tenantId, db, importId, extractDir);
        console.log(`[Import] ${companiesMap.size} empresas importadas/encontradas`);

        // Step 2: Import Groups from Grupos.csv inside ZIP
        const groupsMap = await this.importGroupsFromZip(tenantId, db, importId, extractDir);
        console.log(`[Import] ${groupsMap.size} grupos importados/encontrados`);

        // Step 3: Import Persons from Pessoas.csv inside ZIP
        const result = await this.processPersonsFromCsvFile(
            tenantId, db, importId, extractDir, companiesMap, groupsMap, importAsInactive
        );

        return result;
    }

    // Layout 2: Unified import from groups.csv and peoples.csv
    async processLayout2Import(tenantId, db, importId, extractDir, importVehicles = false, vehiclesRotative = false, importAsInactive = false, importVisitors = false, visitorsInactive = false) {
        if (!extractDir) {
            throw new Error('Diretório extraído não encontrado');
        }

        console.log('[Import Layout 2] Iniciando importação unificada...');
        console.log(`[Import Layout 2] Importar veículos: ${importVehicles}, Rotativo: ${vehiclesRotative}`);
        console.log(`[Import Layout 2] Importar visitantes: ${importVisitors}, Inativos: ${visitorsInactive}`);

        let processed = 0; let total = 0;
        let errors = 0;

        // Map for linking vehicle owners: csvId -> idDevice (database person id)
        // vehicles.csv "ID do usuário" corresponds to peoples.csv "id" column
        const peopleIdMap = new Map(); // csvId -> idDevice

        // Step 1: Import Groups and Companies from groups.csv
        // groups.csv: id,idType,name,disableADE,maxTimeInside
        // idType = 1 → grupo
        // idType = 2 → empresa
        const groupsMap = new Map();  // group_id -> group_id
        const companiesMap = new Map(); // company_id -> company_id

        try {
            const groupsFile = path.join(extractDir, 'groups.csv');
            await fs.promises.access(groupsFile);

            const csvContent = await fs.promises.readFile(groupsFile, 'utf-8');
            const lines = csvContent.split('\n').filter(line => line.trim());

            if (lines.length >= 2) {
                const delimiter = lines[0].includes(';') ? ';' : ',';
                const headers = this.parseCSVLine(lines[0], delimiter);
                const dataLines = lines.slice(1);

                const idIdx = this.findHeaderIndex(headers, 'id', 'ID');
                const idTypeIdx = this.findHeaderIndex(headers, 'idType', 'idtype', 'IDType');
                const nameIdx = this.findHeaderIndex(headers, 'name', 'Name', 'nome');

                console.log(`[Import Layout 2] Processando ${dataLines.length} registros de groups.csv...`);

                for (const line of dataLines) {
                    try {
                        const values = this.parseCSVLine(line, delimiter);
                        const id = idIdx !== -1 ? values[idIdx]?.trim() : '';
                        const idType = idTypeIdx !== -1 ? values[idTypeIdx]?.trim() : '';
                        const name = nameIdx !== -1 ? values[nameIdx]?.trim() : '';

                        if (!id || !name) continue;

                        if (idType === '1') {
                            // It's a group - insert or get existing
                            let existingGroup = await db.get('SELECT id FROM groups WHERE id = ?', [id]);
                            if (!existingGroup) {
                                const result = await db.run(
                                    'INSERT INTO groups (id, name, created_at) VALUES (?, ?, datetime("now"))',
                                    [id, name]
                                );
                            }
                            groupsMap.set(id, id);
                        } else if (idType === '2') {
                            // It's a company - insert or get existing
                            let existingCompany = await db.get('SELECT id FROM companies WHERE id = ?', [id]);
                            if (!existingCompany) {
                                await db.run(
                                    'INSERT INTO companies (id, corporate_name, created_at) VALUES (?, ?, datetime("now"))',
                                    [id, name]
                                );
                            }
                            companiesMap.set(id, id);
                        }
                    } catch (e) {
                        console.error(`[Import Layout 2] Erro ao processar linha de groups.csv: ${e.message}`);
                    }
                }
            }

            console.log(`[Import Layout 2] ${groupsMap.size} grupos e ${companiesMap.size} empresas processados`);
        } catch (e) {
            console.log(`[Import Layout 2] Arquivo groups.csv não encontrado: ${e.message}`);
        }

        // Step 2: Import Peoples (Persons and Visitors) from peoples.csv
        // peoples.csv: id;registration;name;idType;comments;cpf;rg;ddi;phone;email;idDevice;blacklist;inativo;hash;salt;groups;
        // idType: 0 = pessoa, 1 = visitante
        // person_id = idDevice (this is used as the ID in the database)
        // registration = registration (can be same as idDevice)
        // photos: usuario-<id>.jpg where id = column 'id'

        // Check for photos
        let photosMap = new Map();
        try {
            const photosDir = path.join(extractDir, 'photos');
            await fs.promises.access(photosDir);
            const files = await fs.promises.readdir(photosDir);
            for (const file of files) {
                const ext = path.extname(file).toLowerCase();
                if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
                    // Format: usuario-<id>.jpg
                    const baseName = path.basename(file, ext);
                    if (baseName.startsWith('usuario-')) {
                        const id = baseName.replace('usuario-', '');
                        photosMap.set(id, path.join(photosDir, file));
                    }
                }
            }
            console.log(`[Import Layout 2] ${photosMap.size} fotos encontradas`);
        } catch (e) {
            console.log(`[Import Layout 2] Pasta photos não encontrada: ${e.message}`);
        }

        try {
            const peoplesFile = path.join(extractDir, 'peoples.csv');
            await fs.promises.access(peoplesFile);

            const csvContent = await fs.promises.readFile(peoplesFile, 'utf-8');
            const lines = csvContent.split('\n').filter(line => line.trim());

            if (lines.length >= 2) {
                const delimiter = lines[0].includes(';') ? ';' : ',';
                const headers = this.parseCSVLine(lines[0], delimiter);
                const dataLines = lines.slice(1);

                // Find column indices
                const idIdx = this.findHeaderIndex(headers, 'id', 'ID');
                const registrationIdx = this.findHeaderIndex(headers, 'registration', 'Registration', 'matricula');
                const nameIdx = this.findHeaderIndex(headers, 'name', 'Name', 'nome');
                const idTypeIdx = this.findHeaderIndex(headers, 'idType', 'idtype', 'IDType', 'type');
                const cpfIdx = this.findHeaderIndex(headers, 'cpf', 'CPF');
                const rgIdx = this.findHeaderIndex(headers, 'rg', 'RG');
                const ddiIdx = this.findHeaderIndex(headers, 'ddi', 'DDI');
                const phoneIdx = this.findHeaderIndex(headers, 'phone', 'Phone', 'telefone', 'celular');
                const emailIdx = this.findHeaderIndex(headers, 'email', 'Email', 'e-mail', 'mail');
                const idDeviceIdx = this.findHeaderIndex(headers, 'idDevice', 'iddevice', 'IDDevice');
                const inativoIdx = this.findHeaderIndex(headers, 'inativo', 'inactive', 'Inativo');
                const groupsIdx = this.findHeaderIndex(headers, 'groups', 'Groups', 'grupos');

                console.log(`[Import Layout 2] Processando ${dataLines.length} registros de peoples.csv...`);

                for (const line of dataLines) {
                    try {
                        const values = this.parseCSVLine(line, delimiter);
                        const id = idIdx !== -1 ? values[idIdx]?.trim() : '';  // Used for photo lookup
                        const registration = registrationIdx !== -1 ? values[registrationIdx]?.trim() : '';
                        const name = nameIdx !== -1 ? values[nameIdx]?.trim() : '';
                        const idType = idTypeIdx !== -1 ? values[idTypeIdx]?.trim() : '';
                        const cpf = cpfIdx !== -1 ? values[cpfIdx]?.trim() : '';
                        const rg = rgIdx !== -1 ? values[rgIdx]?.trim() : '';
                        const ddi = ddiIdx !== -1 ? values[ddiIdx]?.trim() : '';
                        const phone = phoneIdx !== -1 ? values[phoneIdx]?.trim() : '';
                        const email = emailIdx !== -1 ? values[emailIdx]?.trim() : '';
                        const idDevice = idDeviceIdx !== -1 ? values[idDeviceIdx]?.trim() : '';
                        const inativo = inativoIdx !== -1 ? values[inativoIdx]?.trim() : '';
                        const groupsStr = groupsIdx !== -1 ? values[groupsIdx]?.trim() : '';

                        // person_id = idDevice (required)
                        const personId = idDevice;
                        if (!personId || !name) {
                            console.warn(`[Import Layout 2] Linha ignorada: personId=${personId}, name=${name}`);
                            continue;
                        }

                        // Determine if it's a person (0) or visitor (1)
                        const isVisitor = idType === '1';

                        // Determine status
                        let status = 'active';
                        if (isVisitor) {
                            // For visitors, status must be 'on_premises' or 'exited' (CHECK constraint)
                            status = visitorsInactive ? 'exited' : 'on_premises';
                        } else {
                            status = (inativo === '1' || importAsInactive) ? 'inactive' : 'active';
                        }

                        // Format phone
                        let fullPhone = '';
                        if (ddi && phone) {
                            fullPhone = ddi.replace(/\D/g, '') + phone.replace(/\D/g, '');
                        } else if (phone) {
                            fullPhone = phone.replace(/\D/g, '');
                        }

                        // Clean CPF - use as document, or empty string if not provided
                        const cleanCpf = cpf ? cpf.replace(/\D/g, '') : '';
                        const cleanRg = rg ? rg.replace(/\D/g, '') : '';

                        // Use CPF as document, if empty use RG
                        const document = cleanCpf || cleanRg || '';

                        // Use idDevice as registration if not provided
                        const finalRegistration = registration || personId;

                        if (isVisitor) {
                            // Import as visitor
                            if (!importVisitors) {
                                continue; // Skip visitors if not importing
                            }

                            const existingVisitor = await db.get(
                                'SELECT id FROM visitors WHERE id = ?',
                                [personId]
                            );

                            // Handle photo for visitor
                            let photoUrl = null;
                            if (photosMap.has(id)) {
                                photoUrl = await this.savePhotoFromPath(tenantId, photosMap.get(id), personId, 'visitor');
                            }

                            if (existingVisitor) {
                                await db.run(
                                    `UPDATE visitors SET name = ?, document = ?, rg = ?, cellphone = ?, email = ?, status = ?, photo_url = ?, updated_at = datetime('now') WHERE id = ?`,
                                    [name, document, cleanRg, fullPhone, email, status, photoUrl, personId]
                                );
                            } else {
                                await db.run(
                                    `INSERT INTO visitors (id, name, document, rg, cellphone, email, status, photo_url, created_at, updated_at, tenant_id, registration_number)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?)`,
                                    [personId, name, document, cleanRg, fullPhone, email, status, photoUrl, tenantId, finalRegistration]
                                );
                            }

                            // Link visitor to company if groups contains company id
                            if (groupsStr) {
                                const groupIds = groupsStr.split('|').filter(g => g.trim());
                                for (const groupId of groupIds) {
                                    if (companiesMap.has(groupId)) {
                                        await db.run(
                                            'UPDATE OR IGNORE visitors SET visited_company_id = ? WHERE id = ?',
                                            [groupId, personId]
                                        );
                                    }
                                }
                            }
                            processed++;
                        } else {
                            // Import as person
                            const existingPerson = await db.get(
                                'SELECT id FROM persons WHERE id = ?',
                                [personId]
                            );

                            // Handle photo for person
                            let photoUrl = null;
                            if (photosMap.has(id)) {
                                photoUrl = await this.savePhotoFromPath(tenantId, photosMap.get(id), personId, 'person');
                            }

                            if (existingPerson) {
                                await db.run(
                                    `UPDATE persons SET name = ?, registration_number = ?, email = ?, cellphone = ?, cpf = ?, rg = ?, status = ?, photo_url = ?, updated_at = datetime('now') WHERE id = ?`,
                                    [name, finalRegistration, email, fullPhone, cleanCpf || null, rg, status, photoUrl, personId]
                                );
                            } else {
                                await db.run(
                                    `INSERT INTO persons (id, name, registration_number, email, cellphone, cpf, rg, status, photo_url, created_at, updated_at)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
                                    [personId, name, finalRegistration, email, fullPhone, cleanCpf || null, rg, status, photoUrl]
                                );
                            }
                            processed++;

                            // Store mapping of csvId -> idDevice for vehicle import
                            // vehicles.csv "ID do usuário" corresponds to peoples.csv "id" column
                            if (id && personId) {
                                peopleIdMap.set(id, personId);
                            }

                            // Process groups and company association
                            if (groupsStr) {
                                const groupIds = groupsStr.split('|').filter(g => g.trim());
                                for (const groupId of groupIds) {
                                    if (groupsMap.has(groupId)) {
                                        // Link person to group
                                        await db.run(
                                            'UPDATE OR IGNORE persons SET group_id = ? WHERE id = ?',
                                            [groupId, personId]
                                        );
                                    }
                                    // Link person to company if groupId is a company
                                    if (companiesMap.has(groupId)) {
                                        await db.run(
                                            'UPDATE OR IGNORE persons SET company_id = ? WHERE id = ?',
                                            [groupId, personId]
                                        );
                                    }
                                }
                            }

                            // Import vehicles if enabled - done after all people are processed
                        }
                    } catch (e) {
                        errors++;
                        console.error(`[Import Layout 2] Erro ao processar linha de peoples.csv: ${e.message}`);
                    }
                }
            }

            // Import all vehicles after processing all people
            if (importVehicles) {
                await this.importAllVehiclesFromCsv(tenantId, db, extractDir, companiesMap, vehiclesRotative, peopleIdMap);
            }

            console.log(`[Import Layout 2] ${processed} pessoas/visitantes processados, ${errors} erros`);
        } catch (e) {
            console.error(`[Import Layout 2] Erro ao processar peoples.csv: ${e.message}`);
            errors++;
        }

        return { processed, errors };
    }

    // Import all vehicles from vehicles.csv at once (Layout 2)
    async importAllVehiclesFromCsv(tenantId, db, extractDir, companiesMap, isRotative = false, peopleIdMap = new Map()) {
        try {
            const vehiclesFile = path.join(extractDir, 'vehicles.csv');
            await fs.promises.access(vehiclesFile);

            const csvContent = await fs.promises.readFile(vehiclesFile, 'utf-8');
            const lines = csvContent.split('\n').filter(line => line.trim());

            if (lines.length < 2) return;

            const delimiter = lines[0].includes(';') ? ';' : ',';
            const headers = this.parseCSVLine(lines[0], delimiter);
            const dataLines = lines.slice(1);

            // Find column indices
            const idUserIdx = this.findHeaderIndex(headers, 'ID do usuário', 'id do usuário', 'idUser', 'ID user', 'user_id', 'ID DEVICE', 'id device', 'IDDEVICE', 'iddevice');
            const plateIdx = this.findHeaderIndex(headers, 'Placa', 'plate', 'license_plate', 'Placa do veículo');
            const brandIdx = this.findHeaderIndex(headers, 'Marca', 'brand', 'make', 'Fabricante');
            const modelIdx = this.findHeaderIndex(headers, 'Modelo', 'model', 'Veículo');
            const colorIdx = this.findHeaderIndex(headers, 'Cor', 'color', 'Cor do veículo');
            const groupIdIdx = this.findHeaderIndex(headers, 'ID do grupo', 'id do grupo', 'group_id', 'ID group', 'Grupo', 'ID da empresa');

            console.log(`[Import Layout 2] Headers de veículos: ${headers.join(' | ')}`);
            console.log(`[Import Layout 2] Índices: idUser=${idUserIdx}, plate=${plateIdx}, groupId=${groupIdIdx}`);

            let vehiclesImported = 0;

            for (const line of dataLines) {
                try {
                    const values = this.parseCSVLine(line, delimiter);

                    // Support both positional and header-based formats
                    // Positional format: ID,ID_USUARIO,ID_GRUPO,Placa,Marca,Modelo,Cor,Nome,Grupo
                    // Column 1 (index 1) = ID do usuário
                    // Column 2 (index 2) = ID do grupo
                    // Column 3 (index 3) = Placa
                    let idUser, plate, brand, model, color, groupId;

                    if (idUserIdx !== -1 && plateIdx !== -1) {
                        // Header-based format
                        idUser = values[idUserIdx]?.trim();
                        plate = values[plateIdx]?.trim();
                        brand = brandIdx !== -1 ? values[brandIdx]?.trim() : '';
                        model = modelIdx !== -1 ? values[modelIdx]?.trim() : '';
                        color = colorIdx !== -1 ? values[colorIdx]?.trim() : '';
                        groupId = groupIdIdx !== -1 ? values[groupIdIdx]?.trim() : '';
                    } else {
                        // Positional format: ID,ID_USUARIO,ID_GRUPO,Placa,Marca,Modelo,Cor,Nome,Grupo
                        idUser = values[1]?.trim();  // Second column
                        groupId = values[2]?.trim(); // Third column
                        plate = values[3]?.trim();   // Fourth column
                        brand = values[4]?.trim();   // Fifth column
                        model = values[5]?.trim();   // Sixth column
                        color = values[6]?.trim();   // Seventh column
                    }

                    // Skip if no owner or no plate
                    if (!idUser || !plate) {
                        console.log(`[Import Layout 2] Veículo ignorado: idUser=${idUser}, plate=${plate}`);
                        continue;
                    }

                    // Find the correct person ID using the mapping
                    // vehicles.csv "ID do usuário" corresponds to peoples.csv "id" column
                    // The actual person ID in DB is "idDevice" from peoples.csv
                    let personId = null;
                    if (peopleIdMap.has(idUser)) {
                        personId = peopleIdMap.get(idUser);
                    } else {
                        // Fallback: try direct lookup (for backward compatibility)
                        const person = await db.get('SELECT id FROM persons WHERE id = ?', [idUser]);
                        if (person) {
                            personId = person.id;
                        }
                    }

                    if (!personId) {
                        console.log(`[Import Layout 2] Veículo ignorado: pessoa não encontrada idUser=${idUser}`);
                        continue;
                    }

                    // Find company from groupId
                    let companyId = null;
                    if (groupId && companiesMap.has(groupId)) {
                        companyId = groupId;
                    }

                    const existingVehicle = await db.get(
                        'SELECT id FROM vehicles WHERE license_plate = ?',
                        [plate]
                    );

                    if (!existingVehicle) {
                        await db.run(
                            `INSERT INTO vehicles (person_id, license_plate, brand, model, color, company_id, status, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
                            [personId, plate, brand, model, color, companyId, isRotative ? 'inactive' : 'active']
                        );
                        vehiclesImported++;
                    }
                } catch (e) {
                    console.error(`[Import Layout 2] Erro ao processar veículo: ${e.message}`);
                }
            }

            console.log(`[Import Layout 2] ${vehiclesImported} veículos importados no total`);
        } catch (e) {
            console.log(`[Import Layout 2] vehicles.csv não encontrado ou erro: ${e.message}`);
        }
    }

    // Import vehicles from vehicles.csv (Layout 2) - DEPRECATED, use importAllVehiclesFromCsv
    async importVehiclesFromCsv(tenantId, db, extractDir, ownerPersonId, companiesMap, isRotative = false) {
        try {
            const vehiclesFile = path.join(extractDir, 'vehicles.csv');
            await fs.promises.access(vehiclesFile);

            const csvContent = await fs.promises.readFile(vehiclesFile, 'utf-8');
            const lines = csvContent.split('\n').filter(line => line.trim());

            if (lines.length < 2) return;

            const delimiter = lines[0].includes(';') ? ';' : ',';
            const headers = this.parseCSVLine(lines[0], delimiter);
            const dataLines = lines.slice(1);

            // Find column indices
            const idUserIdx = this.findHeaderIndex(headers, 'ID do usuário', 'id do usuário', 'idUser', 'ID user', 'user_id', 'ID DEVICE', 'id device', 'IDDEVICE', 'iddevice');
            const plateIdx = this.findHeaderIndex(headers, 'Placa', 'plate', 'license_plate', 'Placa do veículo');
            const brandIdx = this.findHeaderIndex(headers, 'Marca', 'brand', 'make', 'Fabricante');
            const modelIdx = this.findHeaderIndex(headers, 'Modelo', 'model', 'Veículo');
            const colorIdx = this.findHeaderIndex(headers, 'Cor', 'color', 'Cor do veículo');
            const groupIdIdx = this.findHeaderIndex(headers, 'ID do grupo', 'id do grupo', 'group_id', 'ID group', 'Grupo', 'ID da empresa');

            let vehiclesImported = 0;

            for (const line of dataLines) {
                try {
                    const values = this.parseCSVLine(line, delimiter);
                    const idUser = idUserIdx !== -1 ? values[idUserIdx]?.trim() : '';
                    const plate = plateIdx !== -1 ? values[plateIdx]?.trim() : '';
                    const brand = brandIdx !== -1 ? values[brandIdx]?.trim() : '';
                    const model = modelIdx !== -1 ? values[modelIdx]?.trim() : '';
                    const color = colorIdx !== -1 ? values[colorIdx]?.trim() : '';
                    const groupId = groupIdIdx !== -1 ? values[groupIdIdx]?.trim() : '';

                    // Only import vehicles for the specified owner
                    if (idUser !== ownerPersonId || !plate) continue;

                    // Find company from groupId
                    let companyId = null;
                    if (groupId && companiesMap.has(groupId)) {
                        companyId = groupId;
                    }

                    const existingVehicle = await db.get(
                        'SELECT id FROM vehicles WHERE license_plate = ?',
                        [plate]
                    );

                    if (!existingVehicle) {
                        await db.run(
                            `INSERT INTO vehicles (person_id, license_plate, model, color, company_id, status, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
                            [ownerPersonId, plate, model, color, companyId, isRotative ? 'inactive' : 'active']
                        );
                        vehiclesImported++;
                    }
                } catch (e) {
                    console.error(`[Import Layout 2] Erro ao processar veículo: ${e.message}`);
                }
            }

            console.log(`[Import Layout 2] ${vehiclesImported} veículos importados para pessoa ${ownerPersonId}`);
        } catch (e) {
            console.log(`[Import Layout 2] vehicles.csv não encontrado ou erro: ${e.message}`);
        }
    }

    // Save photo from path to uploads folder
    async savePhotoFromPath(tenantId, photoPath, personId, type) {
        try {
            const photoBuffer = await fs.promises.readFile(photoPath);
            const ext = path.extname(photoPath).toLowerCase();
            const fileName = `${tenantId}_${type}_${personId}_${Date.now()}${ext}`;

            const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'photos', type);
            await fs.promises.mkdir(uploadDir, { recursive: true });

            const destPath = path.join(uploadDir, fileName);
            await fs.promises.writeFile(destPath, photoBuffer);

            const photoUrl = `/uploads/photos/${type}/${fileName}`;
            console.log(`[Import] Foto salva para ${type} ${personId}: ${photoUrl}`);
            return photoUrl;
        } catch (e) {
            console.error(`[Import] Erro ao salvar foto: ${e.message}`);
            return null;
        }
    }

    // Process persons from a CSV file path with companies and groups maps
    async processPersonsFromCsvFile(tenantId, db, importId, extractDir, companiesMap, groupsMap, importAsInactive = false) {
        // Find Pessoas.csv in extracted folder
        const pessoasFile = path.join(extractDir, 'Pessoas.csv');

        try {
            await fs.promises.access(pessoasFile);
        } catch (e) {
            // Try case-insensitive search
            const files = await fs.promises.readdir(extractDir);
            const pessoasFileMatch = files.find(f => f.toLowerCase() === 'pessoas.csv');
            if (!pessoasFileMatch) {
                throw new Error('Arquivo Pessoas.csv não encontrado no ZIP');
            }
        }

        const pessoasCsvPath = path.join(extractDir, 'Pessoas.csv');

        // Check for photos in extractDir
        let photosMap = new Map();
        if (extractDir) {
            console.log(`[Import] Procurando fotos de pessoas em: ${extractDir}`);
            try {
                const photosDir = path.join(extractDir, 'photos');
                const dirToSearch = await fs.promises.access(photosDir).then(() => photosDir).catch(() => extractDir);

                const files = await fs.promises.readdir(dirToSearch);
                for (const file of files) {
                    const ext = path.extname(file).toLowerCase();
                    if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
                        const baseName = path.basename(file, ext);
                        photosMap.set(baseName, path.join(dirToSearch, file));
                        console.log(`[Import] Foto encontrada para pessoa: ${file} (ID: ${baseName})`);
                    }
                }
                console.log(`[Import] Total de fotos de pessoas encontradas: ${photosMap.size}`);
            } catch (e) {
                console.log(`[Import] Erro ao ler fotos de pessoas: ${e.message}`);
            }
        }

        const result = await this.processPersonsImport(
            tenantId, db, importId, pessoasCsvPath, companiesMap, groupsMap, importAsInactive, photosMap
        );

        return result;
    }

    // Import companies from ZIP extracted folder
    async importCompaniesFromZip(tenantId, db, importId, extractDir) {
        const companiesMap = new Map();

        try {
            // Look for Empresas.csv in extracted folder
            const empresaFile = path.join(extractDir, 'Empresas.csv');

            try {
                await fs.promises.access(empresaFile);
            } catch (e) {
                console.log('[Import] Arquivo Empresas.csv não encontrado no ZIP');
                return companiesMap;
            }

            const csvContent = await fs.promises.readFile(empresaFile, 'utf-8');
            const lines = csvContent.split('\n').filter(line => line.trim());

            if (lines.length < 2) {
                console.log('[Import] Arquivo Empresas.csv vazio');
                return companiesMap;
            }

            const delimiter = lines[0].includes(';') ? ';' : ',';
            const headers = this.parseCSVLine(lines[0], delimiter);
            const dataLines = lines.slice(1);

            // Find column indices
            const nameHeader = this.findHeaderIndex(headers, 'Empresa', 'empresa', 'name', 'nome');
            const cnpjHeader = this.findHeaderIndex(headers, 'CNPJ', 'cnpj');

            for (const line of dataLines) {
                try {
                    const values = this.parseCSVLine(line, delimiter);
                    const companyName = nameHeader !== -1 ? values[nameHeader]?.trim() : '';
                    // CNPJ não é mais validado - salva exatamente como está no CSV
                    const cnpj = cnpjHeader !== -1 ? values[cnpjHeader]?.trim() : '';

                    if (!companyName) continue;

                    // Check if company exists
                    let company = await db.get(
                        'SELECT id FROM companies WHERE corporate_name = ?',
                        [companyName]
                    );

                    if (!company) {
                        const result = await db.run(
                            'INSERT INTO companies (corporate_name, cnpj, created_at) VALUES (?, ?, datetime("now"))',
                            [companyName, cnpj || null]
                        );
                        company = { id: result.lastID };
                    }

                    companiesMap.set(companyName, company.id);
                } catch (e) {
                    console.error('[Import] Erro ao importar empresa:', e.message);
                }
            }

        } catch (error) {
            console.error('[Import] Erro ao importar Empresas.csv:', error.message);
        }

        return companiesMap;
    }

    // Import groups from ZIP extracted folder
    async importGroupsFromZip(tenantId, db, importId, extractDir) {
        const groupsMap = new Map();

        try {
            // Look for Grupos.csv in extracted folder
            const gruposFile = path.join(extractDir, 'Grupos.csv');

            try {
                await fs.promises.access(gruposFile);
            } catch (e) {
                console.log('[Import] Arquivo Grupos.csv não encontrado no ZIP');
                return groupsMap;
            }

            const csvContent = await fs.promises.readFile(gruposFile, 'utf-8');
            const lines = csvContent.split('\n').filter(line => line.trim());

            if (lines.length < 2) {
                console.log('[Import] Arquivo Grupos.csv vazio');
                return groupsMap;
            }

            const delimiter = lines[0].includes(';') ? ';' : ',';
            const headers = this.parseCSVLine(lines[0], delimiter);
            const dataLines = lines.slice(1);

            // Find column index
            const nameHeader = this.findHeaderIndex(headers, 'Grupo', 'grupo', 'name', 'nome');

            for (const line of dataLines) {
                try {
                    const values = this.parseCSVLine(line, delimiter);
                    const groupName = nameHeader !== -1 ? values[nameHeader]?.trim() : '';

                    if (!groupName) continue;

                    // Check if group exists
                    let group = await db.get(
                        'SELECT id FROM groups WHERE name = ? AND tenant_id = ?',
                        [groupName, tenantId]
                    );

                    if (!group) {
                        const result = await db.run(
                            'INSERT INTO groups (tenant_id, name, created_at) VALUES (?, ?, datetime("now"))',
                            [tenantId, groupName]
                        );
                        group = { id: result.lastID };
                    }

                    groupsMap.set(groupName, group.id);
                } catch (e) {
                    console.error('[Import] Erro ao importar grupo:', e.message);
                }
            }

        } catch (error) {
            console.error('[Import] Erro ao importar Grupos.csv:', error.message);
        }

        return groupsMap;
    }

    // Legacy: Import companies from file (used for backwards compatibility)
    async importCompaniesFromFile(tenantId, db, importId, uploadDir) {
        const companiesMap = new Map();

        try {
            const empresaFilePath = path.join(uploadDir, '..', 'Empresas.csv');
            // Check if file exists in parent directory (upload folder structure)
            let empresaFile = null;

            // Try different possible paths
            const possiblePaths = [
                path.join(uploadDir, 'Empresas.csv'),
                path.join(uploadDir, '..', 'Empresas.csv'),
                path.join(process.cwd(), 'exemples csv', 'Empresas.csv'),
            ];

            for (const p of possiblePaths) {
                try {
                    await fs.promises.access(p);
                    empresaFile = p;
                    break;
                } catch (e) {
                    // File doesn't exist, try next
                }
            }

            if (!empresaFile) {
                console.log('[Import] Arquivo Empresas.csv não encontrado, tentando pelo CSV principal...');
                return companiesMap;
            }

            const csvContent = await fs.promises.readFile(empresaFile, 'utf-8');
            const lines = csvContent.split('\n').filter(line => line.trim());

            if (lines.length < 2) {
                console.log('[Import] Arquivo Empresas.csv vazio');
                return companiesMap;
            }

            const delimiter = lines[0].includes(';') ? ';' : ',';
            const headers = this.parseCSVLine(lines[0], delimiter);
            const dataLines = lines.slice(1);

            // Find column indices
            const nameHeader = this.findHeaderIndex(headers, 'Empresa', 'empresa', 'name', 'nome');
            const cnpjHeader = this.findHeaderIndex(headers, 'CNPJ', 'cnpj');

            for (const line of dataLines) {
                try {
                    const values = this.parseCSVLine(line, delimiter);
                    const companyName = nameHeader !== -1 ? values[nameHeader]?.trim() : '';
                    const cnpj = cnpjHeader !== -1 ? values[cnpjHeader]?.trim() : '';

                    if (!companyName) continue;

                    // Check if company exists
                    let company = await db.get(
                        'SELECT id FROM companies WHERE corporate_name = ?',
                        [companyName]
                    );

                    if (!company) {
                        const result = await db.run(
                            'INSERT INTO companies (corporate_name, cnpj, created_at) VALUES (?, ?, datetime("now"))',
                            [companyName, cnpj || null]
                        );
                        company = { id: result.lastID };
                    }

                    companiesMap.set(companyName, company.id);
                } catch (e) {
                    console.error('[Import] Erro ao importar empresa:', e.message);
                }
            }

        } catch (error) {
            console.error('[Import] Erro ao importar Empresas.csv:', error.message);
        }

        return companiesMap;
    }

    // Import groups from Grupos.csv
    async importGroupsFromFile(tenantId, db, importId, uploadDir) {
        const groupsMap = new Map();

        try {
            let gruposFile = null;

            // Try different possible paths
            const possiblePaths = [
                path.join(uploadDir, 'Grupos.csv'),
                path.join(uploadDir, '..', 'Grupos.csv'),
                path.join(process.cwd(), 'exemples csv', 'Grupos.csv'),
            ];

            for (const p of possiblePaths) {
                try {
                    await fs.promises.access(p);
                    gruposFile = p;
                    break;
                } catch (e) {
                    // File doesn't exist, try next
                }
            }

            if (!gruposFile) {
                console.log('[Import] Arquivo Grupos.csv não encontrado');
                return groupsMap;
            }

            const csvContent = await fs.promises.readFile(gruposFile, 'utf-8');
            const lines = csvContent.split('\n').filter(line => line.trim());

            if (lines.length < 2) {
                console.log('[Import] Arquivo Grupos.csv vazio');
                return groupsMap;
            }

            const delimiter = lines[0].includes(';') ? ';' : ',';
            const headers = this.parseCSVLine(lines[0], delimiter);
            const dataLines = lines.slice(1);

            // Find column index
            const nameHeader = this.findHeaderIndex(headers, 'Grupo', 'grupo', 'name', 'nome');

            for (const line of dataLines) {
                try {
                    const values = this.parseCSVLine(line, delimiter);
                    const groupName = nameHeader !== -1 ? values[nameHeader]?.trim() : '';

                    if (!groupName) continue;

                    // Check if group exists
                    let group = await db.get(
                        'SELECT id FROM groups WHERE name = ? AND tenant_id = ?',
                        [groupName, tenantId]
                    );

                    if (!group) {
                        const result = await db.run(
                            'INSERT INTO groups (tenant_id, name, created_at) VALUES (?, ?, datetime("now"))',
                            [tenantId, groupName]
                        );
                        group = { id: result.lastID };
                    }

                    groupsMap.set(groupName, group.id);
                } catch (e) {
                    console.error('[Import] Erro ao importar grupo:', e.message);
                }
            }

        } catch (error) {
            console.error('[Import] Erro ao importar Grupos.csv:', error.message);
        }

        return groupsMap;
    }

    // Process persons import with full field mapping
    async processPersonsImport(tenantId, db, importId, csvPath, companiesMap, groupsMap, importAsInactive = false, photosMap = null) {
        const csvContent = await fs.promises.readFile(csvPath, 'utf-8');
        const lines = csvContent.split('\n').filter(line => line.trim());

        if (lines.length < 2) {
            throw new Error('CSV vazio ou sem dados');
        }

        const delimiter = lines[0].includes(';') ? ';' : ',';
        const headers = this.parseCSVLine(lines[0], delimiter);
        const dataLines = lines.slice(1);

        console.log(`[Import] Processando ${dataLines.length} pessoas...`);
        console.log(`[Import] FotosMap recebido: ${photosMap ? photosMap.size : 0} fotos`);

        // Find all column indices
        const typeHeader = this.findHeaderIndex(headers, 'Tipo', 'tipo', 'type');
        const idHeader = this.findHeaderIndex(headers, 'ID Number', 'id number', 'ID', 'id');
        const nameHeader = this.findHeaderIndex(headers, 'Nome', 'nome', 'name');
        const registrationHeader = this.findHeaderIndex(headers, 'Matricula', 'matricula', 'registration', 'registration_number');
        const pinHeader = this.findHeaderIndex(headers, 'Pin', 'pin');
        const emailHeader = this.findHeaderIndex(headers, 'E-mail', 'e-mail', 'email', 'mail');
        const ddiHeader = this.findHeaderIndex(headers, 'DDI', 'ddi');
        const phoneHeader = this.findHeaderIndex(headers, 'Numero de Celular', 'numero de celular', 'phone', 'telefone', 'Celular', 'celular');
        const addressHeader = this.findHeaderIndex(headers, 'Endereco', 'endereço', 'address');
        const cityHeader = this.findHeaderIndex(headers, 'Cidade', 'cidade', 'city');
        const neighborhoodHeader = this.findHeaderIndex(headers, 'Bairro', 'bairro', 'neighborhood');
        const zipCodeHeader = this.findHeaderIndex(headers, 'CEP', 'cep', 'zip', 'zipcode');
        const professionHeader = this.findHeaderIndex(headers, 'Profissao', 'profissão', 'profession');
        const admissionDateHeader = this.findHeaderIndex(headers, 'Data de admissao', 'data de admissão', 'admission_date', 'Data de admissão');
        const genderHeader = this.findHeaderIndex(headers, 'Genero', 'gênero', 'gender', 'sexo');
        const maritalStatusHeader = this.findHeaderIndex(headers, 'Estado Civil', 'estado civil', 'marital_status');
        const nationalityHeader = this.findHeaderIndex(headers, 'Nacionalidade', 'nacionalidade', 'nationality');
        const birthplaceHeader = this.findHeaderIndex(headers, 'Naturalidade', 'naturalidade', 'birthplace', 'naturalidade');
        const fatherNameHeader = this.findHeaderIndex(headers, 'Nome do pai', 'nome do pai', 'father_name');
        const motherNameHeader = this.findHeaderIndex(headers, 'Nome da mae', 'nome da mãe', 'mother_name');
        const birthDateHeader = this.findHeaderIndex(headers, 'Data de nascimento', 'data de nascimento', 'birth_date', 'nascimento');
        const accessStartHeader = this.findHeaderIndex(headers, 'Inicio da liberacao', 'início da liberação', 'access_start_date', 'access_start', 'Data de Inicio do Acesso');
        const accessEndHeader = this.findHeaderIndex(headers, 'Fim da liberacao', 'fim da liberação', 'access_end_date', 'access_end', 'Data de Fim do Acesso');
        const observationHeader = this.findHeaderIndex(headers, 'Observacao', 'observação', 'observation', 'obs');
        const groupsHeader = this.findHeaderIndex(headers, 'Grupos', 'grupos', 'group', 'groups');
        const companiesHeader = this.findHeaderIndex(headers, 'Empresas', 'empresas', 'company', 'companies', 'empresa');
        const cardsHeader = this.findHeaderIndex(headers, 'Cartoes', 'cartões', 'cards', 'cartões');
        const blockReasonHeader = this.findHeaderIndex(headers, 'Motivo do bloqueio', 'motivo do bloqueio', 'block_reason');
        const blockStartHeader = this.findHeaderIndex(headers, 'Data de Inicio do Bloqueio', 'data de início do bloqueio', 'block_start');
        const blockEndHeader = this.findHeaderIndex(headers, 'Data de Fim do Bloqueio', 'data de fim do bloqueio', 'block_end');
        const cpfHeader = this.findHeaderIndex(headers, 'CPF', 'cpf');
        const rgHeader = this.findHeaderIndex(headers, 'RG', 'rg');

        let processed = 0; let total = 0;
        let errors = 0;

        for (let i = 0; i < dataLines.length; i++) {
            try {
                // Skip empty lines or lines with only semicolons
                const trimmedLine = dataLines[i].trim();
                if (!trimmedLine || trimmedLine === '' || /^;+$/.test(trimmedLine)) {
                    continue;
                }

                const values = this.parseCSVLine(dataLines[i], delimiter);

                // Get ID (literal, not auto-increment)
                const personId = idHeader !== -1 ? values[idHeader]?.trim() : null;
                const name = nameHeader !== -1 ? values[nameHeader]?.trim() : '';

                // Validate required fields
                if (!personId || !name) {
                    throw new Error(`ID ou Nome inválido: id="${personId}", name="${name}"`);
                }

                // Get all fields
                const registration = registrationHeader !== -1 ? values[registrationHeader]?.trim() : null;
                const pin = pinHeader !== -1 ? values[pinHeader]?.trim() : null;
                const email = emailHeader !== -1 ? values[emailHeader]?.trim() : '';
                const ddi = ddiHeader !== -1 ? values[ddiHeader]?.trim() : '';
                const phone = phoneHeader !== -1 ? values[phoneHeader]?.trim() : '';
                const address = addressHeader !== -1 ? values[addressHeader]?.trim() : '';
                const city = cityHeader !== -1 ? values[cityHeader]?.trim() : '';
                const neighborhood = neighborhoodHeader !== -1 ? values[neighborhoodHeader]?.trim() : '';
                const zipCode = zipCodeHeader !== -1 ? values[zipCodeHeader]?.trim() : '';
                const profession = professionHeader !== -1 ? values[professionHeader]?.trim() : '';
                const admissionDate = admissionDateHeader !== -1 ? values[admissionDateHeader]?.trim() : '';
                const gender = genderHeader !== -1 ? values[genderHeader]?.trim() : '';
                // Normalize gender - only allow M, F, O, NI
                let normalizedGender = gender;
                if (!gender || gender === '') {
                    normalizedGender = 'NI';
                } else if (!['M', 'F', 'O', 'NI'].includes(gender.toUpperCase())) {
                    normalizedGender = 'NI';
                } else {
                    normalizedGender = gender.toUpperCase();
                }

                const maritalStatus = maritalStatusHeader !== -1 ? values[maritalStatusHeader]?.trim() : '';
                const nationality = nationalityHeader !== -1 ? values[nationalityHeader]?.trim() : '';
                const birthplace = birthplaceHeader !== -1 ? values[birthplaceHeader]?.trim() : '';
                const fatherName = fatherNameHeader !== -1 ? values[fatherNameHeader]?.trim() : '';
                const motherName = motherNameHeader !== -1 ? values[motherNameHeader]?.trim() : '';
                const birthDate = birthDateHeader !== -1 ? values[birthDateHeader]?.trim() : '';
                const accessStart = accessStartHeader !== -1 ? values[accessStartHeader]?.trim() : '';
                const accessEnd = accessEndHeader !== -1 ? values[accessEndHeader]?.trim() : '';
                const observation = observationHeader !== -1 ? values[observationHeader]?.trim() : '';
                const groupsStr = groupsHeader !== -1 ? values[groupsHeader]?.trim() : '';
                const companyName = companiesHeader !== -1 ? values[companiesHeader]?.trim() : '';
                const cards = cardsHeader !== -1 ? values[cardsHeader]?.trim() : '';
                const blockReason = blockReasonHeader !== -1 ? values[blockReasonHeader]?.trim() : '';
                const blockStart = blockStartHeader !== -1 ? values[blockStartHeader]?.trim() : '';
                const blockEnd = blockEndHeader !== -1 ? values[blockEndHeader]?.trim() : '';
                const cpf = cpfHeader !== -1 ? values[cpfHeader]?.trim() : '';
                // Clean CPF - remove non-numeric characters
                const cleanCpf = cpf.replace(/\D/g, '');
                // Use null if CPF is empty, otherwise use the cleaned CPF
                const finalCpf = cleanCpf === '' ? null : cleanCpf;
                const rg = rgHeader !== -1 ? values[rgHeader]?.trim() : '';

                // Get company_id from company name
                let companyId = null;
                if (companyName && companiesMap.has(companyName)) {
                    companyId = companiesMap.get(companyName);
                } else if (companyName) {
                    // Try to find by partial match
                    for (const [compName, compId] of companiesMap) {
                        if (compName.includes(companyName) || companyName.includes(compName)) {
                            companyId = compId;
                            break;
                        }
                    }
                }

                // Get group_id from group name
                let groupId = null;
                if (groupsStr && groupsMap.has(groupsStr)) {
                    groupId = groupsMap.get(groupsStr);
                } else if (groupsStr) {
                    // Try to find by partial match
                    for (const [grpName, grpId] of groupsMap) {
                        if (grpName.toLowerCase().includes(groupsStr.toLowerCase()) || groupsStr.toLowerCase().includes(grpName.toLowerCase())) {
                            groupId = grpId;
                            break;
                        }
                    }
                }

                // Determine status
                let status = 'active';
                if (importAsInactive || blockReason) {
                    status = 'inactive';
                }

                // Format phone number: combine DDI + phone (remove special chars)
                let fullPhone = '';
                if (ddi && phone) {
                    // Remove non-numeric chars from both and combine
                    const cleanDdi = ddi.replace(/\D/g, '');
                    const cleanPhone = phone.replace(/\D/g, '');
                    fullPhone = cleanDdi + cleanPhone;
                } else if (phone) {
                    fullPhone = phone.replace(/\D/g, '');
                }

                // If registration is empty, use personId as registration
                const finalRegistration = (registration && registration.trim() !== '') ? registration : personId;

                // Check if person exists
                const existingPerson = await db.get(
                    'SELECT id FROM persons WHERE id = ?',
                    [personId]
                );

                if (existingPerson) {
                    // Update existing person - only use columns that exist in the database
                    await db.run(
                        `UPDATE persons SET 
                            name = ?, 
                            registration_number = ?, 
                            email = ?, 
                            cellphone = ?, 
                            address = ?, 
                            city = ?, 
                            neighborhood = ?, 
                            cep = ?, 
                            profession = ?, 
                            admission_date = ?, 
                            gender = ?, 
                            marital_status = ?, 
                            birth_date = ?, 
                            group_id = ?, 
                            company_id = ?, 
                            cpf = ?, 
                            rg = ?,
                            status = ?,
                            updated_at = datetime('now') 
                        WHERE id = ?`,
                        [
                            name, finalRegistration, email, fullPhone, address, city, neighborhood,
                            zipCode, profession, admissionDate, normalizedGender, maritalStatus,
                            birthDate, groupId, companyId, finalCpf, rg, status, personId
                        ]
                    );
                } else {
                    // Insert new person with literal ID - only use columns that exist in the database
                    await db.run(
                        `INSERT INTO persons (
                            id, name, registration_number, email, cellphone, address, 
                            city, neighborhood, cep, profession, admission_date, gender, marital_status, 
                            birth_date, group_id, company_id, cpf, rg, status,
                            created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
                        [
                            personId, name, finalRegistration, email, fullPhone, address,
                            city, neighborhood, zipCode, profession, admissionDate, normalizedGender, maritalStatus,
                            birthDate, groupId, companyId, finalCpf, rg, status
                        ]
                    );
                }

                // Handle photo import for person
                let photoUrl = null;
                if (photosMap && photosMap.has(personId)) {
                    const photoPath = photosMap.get(personId);
                    try {
                        // Read photo and copy to person uploads folder
                        const photoBuffer = await fs.promises.readFile(photoPath);
                        const ext = path.extname(photoPath).toLowerCase();
                        const mimeType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
                        const fileName = `${tenantId}_person_${personId}_${Date.now()}${ext}`;

                        // Save to person uploads folder
                        const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'photos', 'person');
                        await fs.promises.mkdir(uploadDir, { recursive: true });

                        const destPath = path.join(uploadDir, fileName);
                        await fs.promises.writeFile(destPath, photoBuffer);

                        photoUrl = `/uploads/photos/person/${fileName}`;
                        console.log(`[Import] Foto salva para pessoa ${personId}: ${photoUrl}`);

                        // Update person with photo_url
                        await db.run(
                            `UPDATE persons SET photo_url = ?, updated_at = datetime('now') WHERE id = ?`,
                            [photoUrl, personId]
                        );
                    } catch (e) {
                        console.error(`[Import] Erro ao processar foto para pessoa ${personId}: ${e.message}`);
                    }
                }

                // If person has a company, add to company_owners (make them owner)
                if (companyId) {
                    try {
                        await db.run(
                            `INSERT OR IGNORE INTO company_owners (company_id, person_id) VALUES (?, ?)`,
                            [companyId, personId]
                        );
                    } catch (e) {
                        console.error(`[Import] Erro ao vincular pessoa como dona da empresa: ${e.message}`);
                    }
                }

                processed++;

            } catch (e) {
                errors++;
                console.error(`[Import] Erro na linha ${i + 2}: ${e.message}`);
                await this.logError(db, importId, i + 2, e.message, dataLines[i]);
            }
        }

        console.log(`[Import] Pessoas processadas: ${processed}, Erros: ${errors}`);

        return { processed, errors };
    }

    // Process visitors import
    async processVisitorsImport(tenantId, db, importId, headers, dataLines, extractDir, delimiter = ';', importAsInactive = false) {
        // Find all column indices
        const idHeader = this.findHeaderIndex(headers, 'ID Number', 'id number', 'ID', 'id');
        const nameHeader = this.findHeaderIndex(headers, 'Nome', 'nome', 'name');
        const cpfHeader = this.findHeaderIndex(headers, 'CPF', 'cpf');
        const rgHeader = this.findHeaderIndex(headers, 'RG', 'rg');

        console.log(`[Import] Headers encontrados:`, headers);
        console.log(`[Import] Índices - ID: ${idHeader}, Nome: ${nameHeader}, CPF: ${cpfHeader}, RG: ${rgHeader}`);
        console.log(`[Import] Processando ${dataLines.length} visitantes...`);

        // Check for photos in extractDir
        let photosMap = new Map();
        if (extractDir) {
            console.log(`[Import] Procurando fotos em: ${extractDir}`);
            try {
                const fs = require('fs');
                const path = require('path');
                const files = await fs.promises.readdir(extractDir);
                console.log(`[Import] Arquivos encontrados no diretório: ${files.join(', ')}`);
                const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif'];

                for (const file of files) {
                    const ext = path.extname(file).toLowerCase();
                    if (imageExtensions.includes(ext)) {
                        const baseName = path.basename(file, ext);
                        photosMap.set(baseName, path.join(extractDir, file));
                        console.log(`[Import] Foto encontrada: ${file} (ID: ${baseName})`);
                    }
                }
                console.log(`[Import] Total de fotos encontradas: ${photosMap.size}`);
            } catch (e) {
                console.log(`[Import] Erro ao ler fotos: ${e.message}`);
            }
        } else {
            console.log(`[Import] extractDir é nulo - não há fotos para processar`);
        }

        let processed = 0; let total = 0;
        let errors = 0;

        for (let i = 0; i < dataLines.length; i++) {
            try {
                const values = this.parseCSVLine(dataLines[i], delimiter);
                const visitorId = idHeader !== -1 ? values[idHeader]?.trim() : null;
                let name = nameHeader !== -1 ? values[nameHeader]?.trim() : '';
                const cpfRaw = cpfHeader !== -1 ? values[cpfHeader]?.trim() : '';
                // Clean CPF - remove non-numeric characters
                const cleanCpf = cpfRaw.replace(/\D/g, '');
                // Use null if CPF is empty, otherwise use the cleaned CPF
                const cpf = cleanCpf === '' ? null : cleanCpf;
                const rg = rgHeader !== -1 ? values[rgHeader]?.trim() : '';

                // Clean name (remove leading space)
                if (name && name.startsWith(' ')) {
                    name = name.trim();
                }

                // Validate required fields
                if (!visitorId || !name) {
                    throw new Error('ID ou Nome inválido');
                }

                // Check if visitor exists
                const existingVisitor = await db.get(
                    'SELECT id, photo_url FROM visitors WHERE id = ?',
                    [visitorId]
                );

                let photoUrl = null;

                // Check for photo
                if (photosMap.has(visitorId)) {
                    const photoPath = photosMap.get(visitorId);
                    const fs = require('fs');
                    const path = require('path');

                    // Read photo and convert to base64
                    const photoBuffer = await fs.promises.readFile(photoPath);
                    const base64 = photoBuffer.toString('base64');
                    const ext = path.extname(photoPath).toLowerCase();
                    const mimeType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';

                    // Save to visitor uploads folder
                    const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'photos', 'visitor');
                    await fs.promises.mkdir(uploadDir, { recursive: true });

                    const fileName = `${tenantId}_visitor_${visitorId}${ext}`;
                    const destPath = path.join(uploadDir, fileName);
                    await fs.promises.writeFile(destPath, photoBuffer);

                    photoUrl = `/uploads/photos/visitor/${fileName}`;
                    console.log(`[Import] Foto salva para visitante ${visitorId}: ${photoUrl}`);
                }

                if (existingVisitor) {
                    // Update
                    if (photoUrl) {
                        await db.run(
                            `UPDATE visitors SET name = ?, document = ?, rg = ?, photo_url = ?,
                             updated_at = datetime('now') WHERE id = ?`,
                            [name, cpf, rg, photoUrl, visitorId]
                        );
                    } else {
                        await db.run(
                            `UPDATE visitors SET name = ?, document = ?, rg = ?,
                             updated_at = datetime('now') WHERE id = ?`,
                            [name, cpf, rg, visitorId]
                        );
                    }
                } else {
                    // Insert with literal ID (for visitors)
                    // Status: 'on_premises' = ativo, 'exited' = inativo
                    const status = importAsInactive ? 'exited' : 'on_premises';
                    await db.run(
                        `INSERT INTO visitors (id, name, document, rg, status, registration_number, photo_url, created_at, updated_at, tenant_id)
                         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)`,
                        [visitorId, name, cpf, rg, status, visitorId, photoUrl, tenantId]
                    );
                }

                processed++;

            } catch (e) {
                errors++;
                console.error(`[Import] Erro na linha ${i + 2}: ${e.message}`);
                await this.logError(db, importId, i + 2, e.message, dataLines[i]);
            }
        }

        console.log(`[Import] Visitantes processados: ${processed}, Erros: ${errors}`);

        return processed;
    }

    // Helper: Find header index
    findHeaderIndex(headers, ...possibleNames) {
        for (const name of possibleNames) {
            const idx = headers.findIndex(h =>
                h.toLowerCase().trim() === name.toLowerCase().trim()
            );
            if (idx !== -1) return idx;
        }
        return -1;
    }

    // Helper: Parse CSV line
    parseCSVLine(line, delimiter = ';') {
        const result = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === delimiter && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        result.push(current.trim());

        return result;
    }

    // Helper: Extract ZIP
    async extractZip(zipPath, extractDir) {
        const AdmZip = (await import('adm-zip')).default;

        // Verify file exists and has content
        const fs = await import('fs');
        const stats = await fs.promises.stat(zipPath);

        if (stats.size < 100) {
            throw new Error(`Arquivo ZIP muito pequeno (${stats.size} bytes). Verifique se o arquivo está correto.`);
        }

        // Verify it's a valid ZIP by checking magic bytes
        const buffer = Buffer.alloc(2);
        const fd = await fs.promises.open(zipPath, 'r');
        await fd.read(buffer, 0, 2, 0);
        await fd.close();

        // ZIP files start with PK (0x50 0x4B)
        if (buffer[0] !== 0x50 || buffer[1] !== 0x4B) {
            throw new Error('O arquivo enviado não é um ZIP válido. O arquivo deve ter extensão .zip e ser um arquivo compactado.');
        }

        const zip = new AdmZip(zipPath);
        zip.extractAllTo(extractDir, true);
    }

    // Helper: Log error
    async logError(db, importId, lineNumber, message, rawData) {
        try {
            await db.run(
                'INSERT INTO import_errors (import_id, line_number, message, raw_data) VALUES (?, ?, ?, ?)',
                [importId, lineNumber, message, rawData?.substring(0, 1000)]
            );
        } catch (e) {
            console.error('[Import] Erro ao logar erro:', e.message);
        }
    }

    // Helper: Cleanup directory
    async cleanupDirectory(dirPath) {
        try {
            await fs.promises.rm(dirPath, { recursive: true, force: true });
        } catch (e) {
            console.error('[Import] Erro ao limpar diretório:', e.message);
        }
    }

    // Get import status
    async getImportStatus(req, res) {
        try {
            const { tenant_id, import_id } = req.params;

            if (!tenant_id || !import_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetros obrigatórios: tenant_id, import_id'
                });
            }

            const db = await getTenantDatabase(tenant_id);

            const importRecord = await db.get(
                'SELECT * FROM imports WHERE id = ? AND tenant_id = ?',
                [import_id, tenant_id]
            );

            if (!importRecord) {
                return res.status(404).json({
                    success: false,
                    message: 'Importação não encontrada'
                });
            }

            const errors = await db.all(
                'SELECT line_number, message, raw_data FROM import_errors WHERE import_id = ? LIMIT 100',
                [import_id]
            );

            return res.json({
                success: true,
                data: {
                    id: importRecord.id,
                    type: importRecord.type,
                    total: importRecord.total,
                    processed: importRecord.processed,
                    errors: importRecord.errors,
                    status: importRecord.status,
                    created_at: importRecord.created_at,
                    finished_at: importRecord.finished_at,
                    error_count: errors.length,
                    errors: errors
                }
            });

        } catch (error) {
            console.error('[Import] Erro ao buscar status:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao buscar status: ' + error.message
            });
        }
    }

    // List imports
    async listImports(req, res) {
        try {
            // Accept tenant_id from query parameter or header
            const tenant_id = req.query.tenant_id || req.headers['x-tenant-id'];
            const { status } = req.query;

            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetro obrigatório: tenant_id'
                });
            }

            const db = await getTenantDatabase(tenant_id);

            let query = 'SELECT * FROM imports WHERE tenant_id = ?';
            const params = [tenant_id];

            if (status) {
                query += ' AND status = ?';
                params.push(status);
            }

            query += ' ORDER BY created_at DESC LIMIT 50';

            const imports = await db.all(query, params);

            return res.json({
                success: true,
                data: imports
            });

        } catch (error) {
            console.error('[Import] Erro ao listar importações:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao listar importações: ' + error.message
            });
        }
    }

    // Helper: Find file by pattern (wildcard)
    // Helper: Find file by pattern (wildcard) - checks root and 1 level subdirs
    // Helper: Find file by pattern (wildcard) - truly recursive
    // Helper: Find file by pattern (wildcard) - truly recursive
    // Helper: Find file by pattern (wildcard) - truly recursive
    async findFileByPattern(dir, pattern) {
        try {
            // Normalizar: remover acentos e chars não-ASCII para comparação resiliente a encoding
            const normalize = str => str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x00-\x7F]/g, '').toLowerCase();

            const escapedParts = pattern.split('*').map(part =>
                normalize(part).replace(/[.*+?^${}\(\)\[\]\\|]/g, '\\$&')
            );
            const regex = new RegExp('^' + escapedParts.join('.*') + '$');

            async function scan(currentDir) {
                const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory() && regex.test(normalize(entry.name))) {
                        return path.relative(dir, path.join(currentDir, entry.name));
                    }
                }
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const found = await scan(path.join(currentDir, entry.name));
                        if (found) return found;
                    }
                }
                return null;
            }

            const result = await scan(dir);
            if (!result) {
                const allFiles = await fs.promises.readdir(dir, { recursive: true }).catch(() => []);
                console.log(`[Import] Pattern ${pattern} não encontrado em ${dir}. Arquivos disponíveis:`, allFiles);
            }
            return result;
        } catch (e) {
            console.error('[Import] Erro no scan de arquivos:', e.message);
            return null;
        }
    }

    // Layout 3: IDSecure Cloud CSVs
    // Layout 3: IDSecure Cloud CSVs
    async processLayout3Import(tenantId, db, importId, extractDir, importVehicles = false, vehiclesRotative = false, importAsInactive = false, importVisitors = false, visitorsInactive = false) {
        if (!extractDir) throw new Error('Diretório extraído não encontrado');

        console.log('[Import Layout 3] Iniciando importação IDSecure Cloud...');
        console.log('[Import Layout 3] Diretório extraído:', extractDir);
        let total = 0;
        let processed = 0;
        let errors = 0;

        // 1. Find Files
        const empresasFile = await this.findFileByPattern(extractDir, 'Empresas_*.csv');
        const gruposFile = await this.findFileByPattern(extractDir, 'Grupos_*.csv');
        const pessoasFile = await this.findFileByPattern(extractDir, 'Pessoas_*.csv');
        const veiculosFile = await this.findFileByPattern(extractDir, 'Veículos_*.csv')
                         || await this.findFileByPattern(extractDir, 'Veiculos_*.csv')
                         || await this.findFileByPattern(extractDir, 'Ve*culos_*.csv');

        console.log('[Import Layout 3] Arquivos encontrados:', { empresasFile, gruposFile, pessoasFile, veiculosFile });

        // 2. Import Companies (Delimiter: , or ;)
        const companiesMap = new Map();
        if (empresasFile) {
            console.log('[Import Layout 3] Processando empresas:', empresasFile);
            const content = await fs.promises.readFile(path.join(extractDir, empresasFile), 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());
            if (lines.length >= 2) {
                const delimiter = lines[0].includes(';') ? ';' : ',';
                const headers = this.parseCSVLine(lines[0], delimiter);
                const nameIdx = this.findHeaderIndex(headers, 'Empresa', 'empresa', 'name', 'nome');
                const cnpjIdx = this.findHeaderIndex(headers, 'CNPJ', 'cnpj');
                for (const line of lines.slice(1)) {
                    const values = this.parseCSVLine(line, delimiter);
                    const name = values[nameIdx]?.trim();
                    const cnpj = values[cnpjIdx]?.trim();
                    if (!name) continue;
                    let company = await db.get('SELECT id FROM companies WHERE corporate_name = ?', [name]);
                    if (!company) {
                        const res = await db.run('INSERT INTO companies (corporate_name, cnpj, created_at) VALUES (?, ?, datetime("now"))', [name, cnpj || null]);
                        company = { id: res.lastID };
                    }
                    companiesMap.set(name, company.id);
                }
            }
        }

        // 3. Import Groups (Delimiter: , or ;)
        const groupsMap = new Map();
        if (gruposFile) {
            console.log('[Import Layout 3] Processando grupos:', gruposFile);
            const content = await fs.promises.readFile(path.join(extractDir, gruposFile), 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());
            if (lines.length >= 2) {
                const delimiter = lines[0].includes(';') ? ';' : ',';
                const headers = this.parseCSVLine(lines[0], delimiter);
                const nameIdx = this.findHeaderIndex(headers, 'Grupo', 'grupo', 'name', 'nome');
                for (const line of lines.slice(1)) {
                    const values = this.parseCSVLine(line, delimiter);
                    const name = values[nameIdx]?.trim();
                    if (!name) continue;
                    let group = await db.get('SELECT id FROM groups WHERE name = ?', [name]);
                    if (!group) {
                        const res = await db.run('INSERT INTO groups (name, tenant_id, created_at) VALUES (?, ?, datetime("now"))', [name, tenantId]);
                        group = { id: res.lastID };
                    }
                    groupsMap.set(name, group.id);
                }
            }
        }

        // 4. Import Pessoas (Delimiter: ;)
        const peopleIdMap = new Map(); // Condutor ID -> DB Person ID
        if (pessoasFile) {
            console.log('[Import Layout 3] Processando pessoas:', pessoasFile);
            const content = await fs.promises.readFile(path.join(extractDir, pessoasFile), 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());
            if (lines.length >= 2) {
                total = lines.length - 1;
                const headers = this.parseCSVLine(lines[0], ';');
                const typeIdx = this.findHeaderIndex(headers, 'Tipo');
                const idIdx = this.findHeaderIndex(headers, 'ID Number');
                const nameIdx = this.findHeaderIndex(headers, 'Nome');
                const cpfIdx = this.findHeaderIndex(headers, 'CPF');
                const rgIdx = this.findHeaderIndex(headers, 'RG');
                const emailIdx = this.findHeaderIndex(headers, 'E-mail');
                const phoneIdx = this.findHeaderIndex(headers, 'Numero de Celular');
                const companiesIdx = this.findHeaderIndex(headers, 'Empresas');
                const groupsIdx = this.findHeaderIndex(headers, 'Grupos');
                const registrationIdx = this.findHeaderIndex(headers, 'Matricula');

                for (const line of lines.slice(1)) {
                    try {
                        const values = this.parseCSVLine(line, ';');
                        const type = values[typeIdx]?.trim() || 'Pessoa';
                        const personId = values[idIdx]?.trim();
                        const name = values[nameIdx]?.trim();
                        if (!personId || !name) continue;

                        const isVisitor = type.toLowerCase().includes('visitante');
                        if (isVisitor && !importVisitors) continue;

                        const cpf = values[cpfIdx]?.replace(/\D/g, '') || null;
                        const rg = values[rgIdx]?.trim() || '';
                        const email = values[emailIdx]?.trim() || '';
                        const phone = values[phoneIdx]?.replace(/\D/g, '') || '';
                        const companyNames = values[companiesIdx]?.split('|').map(n => n.trim()).filter(n => n) || [];
                        const groupNames = values[groupsIdx]?.split('|').map(n => n.trim()).filter(n => n) || [];
                        const registration = values[registrationIdx]?.trim() || personId;

                        let firstCompanyId = null;
                        for (const cName of companyNames) {
                            if (companiesMap.has(cName)) { firstCompanyId = companiesMap.get(cName); break; }
                        }
                        // Fallback: buscar empresa direto no banco pelo nome
                        if (!firstCompanyId && companyNames.length > 0) {
                            for (const cName of companyNames) {
                                const c = await db.get('SELECT id FROM companies WHERE corporate_name = ?', [cName]);
                                if (c) { firstCompanyId = c.id; break; }
                            }
                        }

                        // Coletar TODOS os group IDs (para person_groups)
                        const allGroupIds = [];
                        for (const gName of groupNames) {
                            let gId = groupsMap.get(gName) || null;
                            // Fallback: buscar direto no banco
                            if (!gId) {
                                const g = await db.get('SELECT id FROM groups WHERE name = ?', [gName]);
                                if (g) gId = g.id;
                            }
                            if (gId && !allGroupIds.includes(gId)) allGroupIds.push(gId);
                        }
                        const firstGroupId = allGroupIds[0] || null;

                        const table = isVisitor ? 'visitors' : 'persons';
                        const regField = 'registration_number';
                        const cpfField = isVisitor ? 'document' : 'cpf';

                        // Smart lookup
                        let existing = await db.get(`SELECT id FROM ${table} WHERE id = ?`, [personId]);
                        if (!existing && registration) existing = await db.get(`SELECT id FROM ${table} WHERE ${regField} = ?`, [registration]);
                        if (!existing && cpf) existing = await db.get(`SELECT id FROM ${table} WHERE ${cpfField} = ?`, [cpf]);

                        const targetId = existing ? existing.id : personId;
                        const isUpdate = !!existing;

                        if (isUpdate) {
                            // Selective UPDATE to preserve photos and handle UNIQUE constraints
                            const status = isVisitor ? (visitorsInactive ? 'exited' : 'on_premises') : (importAsInactive ? 'inactive' : 'active');
                            const updateFields = ["name = ?", "rg = ?", "status = ?", "updated_at = datetime('now')"];
                            const updateParams = [name, rg, status];

                            // Check conflicts before updating unique fields
                            if (cpf) {
                                const conflict = await db.get(`SELECT id FROM ${table} WHERE ${cpfField} = ? AND id != ?`, [cpf, targetId]);
                                if (!conflict) { updateFields.push(`${cpfField} = ?`); updateParams.push(cpf); }
                            }
                            if (registration) {
                                const conflict = await db.get(`SELECT id FROM ${table} WHERE ${regField} = ? AND id != ?`, [registration, targetId]);
                                if (!conflict) { updateFields.push(`${regField} = ?`); updateParams.push(registration); }
                            }
                            if (email) {
                                const conflict = await db.get(`SELECT id FROM ${table} WHERE email = ? AND id != ?`, [email, targetId]);
                                if (!conflict) { updateFields.push("email = ?"); updateParams.push(email); }
                            }
                            if (phone) {
                                const conflict = await db.get(`SELECT id FROM ${table} WHERE cellphone = ? AND id != ?`, [phone, targetId]);
                                if (!conflict) { updateFields.push("cellphone = ?"); updateParams.push(phone); }
                            }

                            if (isVisitor) {
                                updateFields.push("visited_company_id = ?"); updateParams.push(firstCompanyId);
                            } else {
                                updateFields.push("company_id = ?"); updateParams.push(firstCompanyId);
                                updateFields.push("group_id = ?"); updateParams.push(firstGroupId);
                            }

                            updateParams.push(targetId);
                            await db.run(`UPDATE ${table} SET ${updateFields.join(', ')} WHERE id = ?`, updateParams);
                        } else {
                            // INSERT
                            if (isVisitor) {
                                const status = visitorsInactive ? 'exited' : 'on_premises';
                                await db.run(`INSERT INTO visitors (id, name, document, rg, status, email, cellphone, visited_company_id, registration_number, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime("now"), datetime("now"))`,
                                    [targetId, name, cpf, rg, status, email, phone, firstCompanyId, registration, tenantId]);
                            } else {
                                const status = importAsInactive ? 'inactive' : 'active';
                                await db.run(`INSERT INTO persons (id, name, cpf, rg, status, email, cellphone, company_id, group_id, registration_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime("now"), datetime("now"))`,
                                    [targetId, name, cpf, rg, status, email, phone, firstCompanyId, firstGroupId, registration]);
                            }
                        }

                        if (!isVisitor) {
                            peopleIdMap.set(personId, targetId);
                            if (firstCompanyId) {
                                await db.run('INSERT OR IGNORE INTO company_owners (company_id, person_id) VALUES (?, ?)', [firstCompanyId, targetId]);
                            }
                            // Vincular todos os grupos em person_groups
                            for (const gId of allGroupIds) {
                                await db.run('INSERT OR IGNORE INTO person_groups (person_id, group_id) VALUES (?, ?)', [targetId, gId]);
                            }
                        }
                        processed++;
                    } catch (e) {
                        errors++;
                        console.error('[Import Layout 3] Erro na linha:', e.message);
                    }
                }
            }
        }
        // Layout 3: veículos sempre são processados se o arquivo existir
        if (veiculosFile) {
            console.log('[Import Layout 3] Processando veículos:', veiculosFile);
            const content = await fs.promises.readFile(path.join(extractDir, veiculosFile), 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());
            if (lines.length >= 2) {
                const headers = this.parseCSVLine(lines[0], ';');
                const marcaIdx       = this.findHeaderIndex(headers, 'Marca');
                const modeloIdx      = this.findHeaderIndex(headers, 'Modelo');
                const corIdx         = this.findHeaderIndex(headers, 'Cor');
                const placaIdx       = this.findHeaderIndex(headers, 'Placa');
                const condutorIdx    = this.findHeaderIndex(headers, 'Condutor');
                const driverTypeIdx  = this.findHeaderIndex(headers, 'DriverType', 'Tipo de Condutor');
                const uhfIdx         = this.findHeaderIndex(headers, 'Codigo Legivel', 'Código Legível', 'codigo_legivel');

                for (const line of lines.slice(1)) {
                    try {
                        const values = this.parseCSVLine(line, ';');
                        const plate      = values[placaIdx]?.trim().toUpperCase();
                        const condutorId = values[condutorIdx]?.trim();
                        if (!plate || !condutorId) continue;

                        // Ignorar condutores que são nomes de empresa (não numéricos)
                        const isNumericId = /^\d+$/.test(condutorId);
                        if (!isNumericId) continue;

                        const driverType = driverTypeIdx !== -1 ? (values[driverTypeIdx]?.trim().toLowerCase() || '') : '';
                        const isVisitorDriver = driverType.includes('visit');

                        // Localizar: primeiro no mapa da importação, depois no banco
                        // Buscar em persons E visitors conforme DriverType
                        let finalPersonId = peopleIdMap.get(condutorId) || null;
                        if (!finalPersonId) {
                            let p = null;
                            if (!isVisitorDriver) {
                                p = await db.get(
                                    'SELECT id FROM persons WHERE registration_number = ?',
                                    [condutorId]
                                );
                            }
                            if (!p) {
                                // Tentar em visitors também
                                p = await db.get(
                                    'SELECT id FROM visitors WHERE registration_number = ?',
                                    [condutorId]
                                );
                            }
                            if (!p) { console.warn('[Import Layout 3] Condutor não encontrado:', condutorId); continue; }
                            finalPersonId = p.id;
                        }

                        const brand  = values[marcaIdx]?.trim()  || null;
                        const model  = values[modeloIdx]?.trim() || null;
                        const color  = values[corIdx]?.trim()    || null;
                        const uhfTag = uhfIdx !== -1 ? (values[uhfIdx]?.replace(/^"|"$/g, '').trim() || null) : null;
                        const status = vehiclesRotative ? 'inactive' : 'active';

                        // Buscar company_id do proprietário para vincular ao veículo
                        const personData = await db.get('SELECT company_id FROM persons WHERE id = ?', [finalPersonId]);
                        const companyId = personData?.company_id || null;

                        const existing = await db.get('SELECT id FROM vehicles WHERE license_plate = ?', [plate]);
                        if (!existing) {
                            await db.run(
                                `INSERT INTO vehicles (person_id, license_plate, brand, model, color, status, uhf_tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime("now"))`,
                                [finalPersonId, plate, brand, model, color, status, uhfTag]
                            );
                        } else {
                            await db.run(
                                `UPDATE vehicles SET person_id = ?, brand = ?, model = ?, color = ?, status = ?, uhf_tag = ? WHERE license_plate = ?`,
                                [finalPersonId, brand, model, color, status, uhfTag, plate]
                            );
                        }
                        // Vincular veículo à empresa do proprietário (se tiver)
                        if (companyId) {
                            const veh = await db.get('SELECT id FROM vehicles WHERE license_plate = ?', [plate]);
                            if (veh) {
                                await db.run(
                                    'INSERT OR IGNORE INTO company_owners (company_id, person_id) VALUES (?, ?)',
                                    [companyId, finalPersonId]
                                );
                            }
                        }
                    } catch (e) {
                        console.error('[Import Layout 3] Erro veículo:', e.message);
                    }
                }
            }
        }

        console.log('[Import Layout 3] Concluído:', { total, processed, errors });
        return { total, processed, errors };
    }
}

export default new ImportController();
