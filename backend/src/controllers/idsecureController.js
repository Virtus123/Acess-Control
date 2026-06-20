import { getTenantDatabase } from '../middleware/tenantManager.js';
import fs from 'fs';
import path from 'path';
import { parse as csvParse } from 'csv-parse/sync';

class IdSecureController {

    // ─── Rota: importação via API iDSecure ───────────────────────────────────────
    async startImport(req, res) {
        try {
            const tenant_id = req.body.tenant_id || req.query.tenant_id;
            const {
                email,
                password,
                import_persons,
                person_active,
                person_inactive,
                import_visitors,
                visitor_active,
                visitor_inactive,
                force_inactive,
                first_page_only
            } = req.body;

            if (!tenant_id || !email || !password) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetros obrigatórios: tenant_id, email, password'
                });
            }

            const options = {
                import_persons:   import_persons   === 'true' || import_persons   === true,
                person_active:    person_active    === 'true' || person_active    === true,
                person_inactive:  person_inactive  === 'true' || person_inactive  === true,
                import_visitors:  import_visitors  === 'true' || import_visitors  === true,
                visitor_active:   visitor_active   === 'true' || visitor_active   === true,
                visitor_inactive: visitor_inactive === 'true' || visitor_inactive === true,
                force_inactive:   force_inactive   === 'true' || force_inactive   === true,
                first_page_only:  first_page_only  === 'true' || first_page_only  === true
            };

            const db = await getTenantDatabase(tenant_id);

            const importRecord = await db.run(
                `INSERT INTO imports (tenant_id, type, import_with_photo, import_as_inactive, status, file_path)
                 VALUES (?, 'person', 1, ?, 'pending', 'idsecure_api')`,
                [tenant_id, options.force_inactive ? 1 : 0]
            );

            this.processImport(tenant_id, importRecord.lastID, email, password, options)
                .catch(err => console.error('[IDSecure Import] Erro no background job:', err));

            return res.json({
                success: true,
                message: 'Importação via IDSecure iniciada em segundo plano.',
                importId: importRecord.lastID
            });

        } catch (error) {
            console.error('[IDSecure Import] Erro ao iniciar importação:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao iniciar importação: ' + error.message
            });
        }
    }

    // ─── Rota: importação de CSV de veículos ─────────────────────────────────────
    async importVehiclesCsv(req, res) {
        try {
            const tenant_id = req.body.tenant_id || req.query.tenant_id;
            if (!tenant_id) {
                return res.status(400).json({ success: false, message: 'tenant_id obrigatório' });
            }
            if (!req.file) {
                return res.status(400).json({ success: false, message: 'Arquivo CSV obrigatório' });
            }

            const db = await getTenantDatabase(tenant_id);
            const content = req.file.buffer.toString('utf-8').replace(/^\uFEFF/, ''); // remove BOM

            // Detectar delimitador
            const firstLine = content.split('\n')[0];
            const delimiter = firstLine.includes(';') ? ';' : ',';

            let rows;
            try {
                rows = csvParse(content, {
                    delimiter,
                    columns: true,
                    skip_empty_lines: true,
                    relax_quotes: true,
                    trim: true
                });
            } catch (e) {
                return res.status(400).json({ success: false, message: 'Erro ao parsear CSV: ' + e.message });
            }

            let processed = 0, errors = 0, notFound = 0;
            const results = [];

            for (const row of rows) {
                try {
                    // Colunas: Marca;Modelo;Cor;Placa;Tipo de Cartao;Codigo Legivel;DriverType;Condutor
                    const plate      = (row['Placa'] || row['placa'] || '').trim().toUpperCase();
                    const brand      = (row['Marca'] || row['marca'] || '').trim();
                    const model      = (row['Modelo'] || row['modelo'] || '').trim();
                    const color      = (row['Cor'] || row['cor'] || '').trim();
                    const condutorRaw = String(row['Condutor'] || row['condutor'] || '').trim();
                    const uhfRaw     = (row['Codigo Legivel'] || row['Código Legível'] || row['codigo_legivel'] || '').trim();

                    // Formatar UHF: "021,60313" → "021,60313" (mantém padrão iDSecure)
                    const uhfTag = uhfRaw.replace(/^"|"$/g, '').trim() || null;

                    if (!plate || !condutorRaw) {
                        errors++;
                        continue;
                    }

                    // Localizar pessoa: por idsecure_id, id ou registration_number
                    let person = null;
                    const numId = parseInt(condutorRaw, 10);

                    if (!isNaN(numId)) {
                        person = await db.get(
                            'SELECT id FROM persons WHERE idsecure_id = ? OR id = ? OR registration_number = ? LIMIT 1',
                            [condutorRaw, numId, condutorRaw]
                        );
                    } else {
                        person = await db.get(
                            'SELECT id FROM persons WHERE idsecure_id = ? OR registration_number = ? LIMIT 1',
                            [condutorRaw, condutorRaw]
                        );
                    }

                    if (!person) {
                        notFound++;
                        results.push({ plate, condutor: condutorRaw, status: 'pessoa_nao_encontrada' });
                        continue;
                    }

                    const existing = await db.get('SELECT id FROM vehicles WHERE license_plate = ?', [plate]);

                    if (existing) {
                        await db.run(
                            `UPDATE vehicles SET person_id = ?, brand = ?, model = ?, color = ?, uhf_tag = ? WHERE license_plate = ?`,
                            [person.id, brand, model, color, uhfTag, plate]
                        );
                        results.push({ plate, condutor: condutorRaw, status: 'atualizado' });
                    } else {
                        await db.run(
                            `INSERT INTO vehicles (person_id, license_plate, brand, model, color, status, uhf_tag, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?, datetime('now'))`,
                            [person.id, plate, brand, model, color, uhfTag]
                        );
                        results.push({ plate, condutor: condutorRaw, status: 'criado' });
                    }
                    processed++;

                } catch (e) {
                    errors++;
                    console.error('[IDSecure Vehicles CSV] Erro na linha:', e.message);
                    results.push({ status: 'erro', message: e.message });
                }
            }

            return res.json({
                success: true,
                message: `Veículos processados: ${processed}, não encontrados: ${notFound}, erros: ${errors}`,
                total: rows.length,
                processed,
                not_found: notFound,
                errors,
                details: results
            });

        } catch (error) {
            console.error('[IDSecure Vehicles CSV] Erro:', error);
            return res.status(500).json({ success: false, message: 'Erro: ' + error.message });
        }
    }

    // ─── Processamento em background ─────────────────────────────────────────────
    async processImport(tenantId, importId, email, password, options) {
        const db = await getTenantDatabase(tenantId);
        let processed = 0, errors = 0;
        const baseUrl = 'https://main.idsecure.com.br:5000/api/v1';

        try {
            await db.run('UPDATE imports SET status = "processing" WHERE id = ?', [importId]);

            // 1. Login
            console.log(`[IDSecure Import] Autenticando com ${email}...`);
            const loginRes = await fetch(`${baseUrl}/operators/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const loginData = await loginRes.json();
            if (!loginData?.data?.token) {
                throw new Error('Falha na autenticação do IDSecure. Verifique credenciais.');
            }
            const token = loginData.data.token;
            console.log('[IDSecure Import] Autenticado com sucesso.');

            const authHeaders = {
                'Content-Type': 'application/json',
                'accept': 'application/json',
                'Authorization': `Bearer ${token}`
            };

            // 2. Importar Empresas — TODOS os status para garantir mapeamento completo
            console.log('[IDSecure Import] Buscando Empresas...');
            const companiesMap = new Map(); // idsecure id → local id
            for (const status of [1, 0]) {
                let page = 1, totalPages = 1;
                do {
                    const compRes = await fetch(
                        `${baseUrl}/companys?GroupType=Company&PageSize=500&PageNumber=${page}&Status=${status}&SortOrder=asc&SortField=id`,
                        { headers: authHeaders }
                    );
                    const compData = await compRes.json();
                    totalPages = compData?.data?.pages || 1;
                    for (const company of (compData?.data?.data || [])) {
                        try {
                            const name = company.description || company.companyName || company.tradeName || 'Empresa Sem Nome';
                            let existing = await db.get('SELECT id FROM companies WHERE idsecure_id = ?', [String(company.id)]);
                            if (!existing) {
                                existing = await db.get('SELECT id FROM companies WHERE id = ?', [company.id]);
                            }
                            if (!existing) {
                                const res = await db.run(
                                    'INSERT INTO companies (id, corporate_name, idsecure_id, created_at) VALUES (?, ?, ?, datetime("now"))',
                                    [company.id, name, String(company.id)]
                                );
                                companiesMap.set(company.id, res.lastID || company.id);
                            } else {
                                await db.run('UPDATE companies SET idsecure_id = ? WHERE id = ?', [String(company.id), existing.id]);
                                companiesMap.set(company.id, existing.id);
                            }
                        } catch (err) {
                            console.error('[IDSecure Import] Erro empresa:', err.message);
                        }
                    }
                    page++;
                } while (page <= totalPages);
            }
            console.log(`[IDSecure Import] ${companiesMap.size} empresas mapeadas.`);

            // 3. Importar Grupos — TODOS os status
            console.log('[IDSecure Import] Buscando Grupos...');
            const groupsMap = new Map(); // idsecure id → local id
            for (const status of [1, 0]) {
                let page = 1, totalPages = 1;
                do {
                    const grpRes = await fetch(
                        `${baseUrl}/groups?GroupType=Persons&PageSize=500&PageNumber=${page}&Status=${status}&SortOrder=asc&SortField=id`,
                        { headers: authHeaders }
                    );
                    const grpData = await grpRes.json();
                    totalPages = grpData?.data?.pages || 1;
                    for (const group of (grpData?.data?.data || [])) {
                        try {
                            const name = group.description || group.name || 'Grupo Sem Nome';
                            let existing = await db.get('SELECT id FROM groups WHERE idsecure_id = ?', [String(group.id)]);
                            if (!existing) {
                                existing = await db.get('SELECT id FROM groups WHERE id = ?', [group.id]);
                            }
                            if (!existing) {
                                const res = await db.run(
                                    'INSERT INTO groups (id, name, tenant_id, idsecure_id, created_at) VALUES (?, ?, ?, ?, datetime("now"))',
                                    [group.id, name, tenantId, String(group.id)]
                                );
                                groupsMap.set(group.id, res.lastID || group.id);
                            } else {
                                await db.run('UPDATE groups SET idsecure_id = ? WHERE id = ?', [String(group.id), existing.id]);
                                groupsMap.set(group.id, existing.id);
                            }
                        } catch (err) {
                            console.error('[IDSecure Import] Erro grupo:', err.message);
                        }
                    }
                    page++;
                } while (page <= totalPages);
            }
            console.log(`[IDSecure Import] ${groupsMap.size} grupos mapeados.`);

            // 4. Categorias para importar
            const categories = [];
            if (options.import_persons) {
                if (options.person_active)   categories.push({ type: 'Person',   status: 1 });
                if (options.person_inactive) categories.push({ type: 'Person',   status: 0 });
            }
            if (options.import_visitors) {
                if (options.visitor_active)   categories.push({ type: 'Visitant', status: 1 });
                if (options.visitor_inactive) categories.push({ type: 'Visitant', status: 0 });
            }

            // 5. Loop de importação
            const maxPages = options.first_page_only ? 1 : Infinity;
            for (const cat of categories) {
                const isVisitor = cat.type === 'Visitant';
                console.log(`[IDSecure Import] Buscando ${isVisitor ? 'Visitantes' : 'Pessoas'} Status=${cat.status}${options.first_page_only ? ' [MODO TESTE - só pág 1]' : ''}...`);
                let page = 1, totalPages = 1;
                do {
                    console.log(`[IDSecure Import] ${isVisitor ? 'Visitantes' : 'Pessoas'} Pág ${page}/${totalPages}`);
                    const url = `${baseUrl}/accessExceptionRules/persons?personType=${cat.type}&PageSize=50&PageNumber=${page}&Status=${cat.status}&SortOrder=asc&SortField=id&photo=true`;
                    const res = await fetch(url, { headers: authHeaders });
                    const resData = await res.json();
                    totalPages = resData?.data?.pages || 1;

                    for (const pessoa of (resData?.data?.data || [])) {
                        try {
                            await this.savePerson(db, pessoa, isVisitor, options.force_inactive, cat.status, tenantId, companiesMap, groupsMap);
                            processed++;
                        } catch (err) {
                            errors++;
                            console.error(`[IDSecure Import] Erro ID ${pessoa.id}: ${err.message}`);
                        }
                    }
                    await db.run('UPDATE imports SET processed = ?, errors = ? WHERE id = ?', [processed, errors, importId]);
                    page++;
                } while (page <= totalPages && page <= maxPages);
            }

            await db.run(
                `UPDATE imports SET status = 'finished', processed = ?, errors = ?, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
                [processed, errors, importId]
            );
            console.log(`[IDSecure Import] Concluído! ${processed} processados, ${errors} erros.`);

        } catch (error) {
            console.error('[IDSecure Import] Falha global:', error);
            await db.run(
                `UPDATE imports SET status = 'error', processed = ?, errors = ?, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
                [processed, errors + 1, importId]
            );
        }
    }

    // ─── Salvar pessoa/visitante ──────────────────────────────────────────────────
    async savePerson(db, pessoa, isVisitor, forceInactive, idsecureStatus, tenantId, companiesMap, groupsMap) {
        const idsecureId = pessoa.id;
        const registration = pessoa.registration || String(idsecureId);

        // Status
        let status;
        if (forceInactive) {
            status = isVisitor ? 'exited' : 'inactive';
        } else {
            if (isVisitor) {
                status = (idsecureStatus === 1) ? 'on_premises' : 'exited';
            } else {
                status = (idsecureStatus === 1) ? 'active' : 'inactive';
            }
            if (pessoa.blockedAt) status = isVisitor ? 'exited' : 'inactive';
        }

        // Telefone
        let cellphone = '';
        let cellphoneDDI = '';
        if (pessoa.phoneDDI && pessoa.phoneNumber) {
            cellphoneDDI = String(pessoa.phoneDDI).replace(/\D/g, '');
            cellphone    = String(pessoa.phoneNumber).replace(/\D/g, '');
        } else if (pessoa.phoneNumber) {
            cellphone = String(pessoa.phoneNumber).replace(/\D/g, '');
        }

        // Documentos (CPF do personDocuments)
        let cleanCpf = null;
        if (pessoa.personDocuments?.length > 0) {
            const val = (pessoa.personDocuments[0].value || '').replace(/\D/g, '');
            if (val.length > 0) cleanCpf = val;
        }
        const cleanRg = pessoa.rg ? String(pessoa.rg).replace(/[^\w\-]/g, '') : null;

        // Data de nascimento
        const birthDate  = pessoa.birthDate     ? pessoa.birthDate.split('T')[0]     : null;
        const admDate    = pessoa.admissionDate  ? pessoa.admissionDate.split('T')[0] : null;

        // Gênero: iDSecure usa "Male"/"Female"/"Unknown"/"NotInformed"
        let gender = null;
        if (pessoa.gender) {
            const g = String(pessoa.gender).toLowerCase();
            if (g === 'male')   gender = 'M';
            else if (g === 'female') gender = 'F';
            else gender = 'O';
        }

        // Estado civil: iDSecure usa "Single","Married","Divorced","Widowed","Other"
        const maritalMap = {
            single: 'solteiro', married: 'casado', divorced: 'divorciado',
            widowed: 'viuvo', other: 'outro'
        };
        const maritalStatus = pessoa.maritalStatus
            ? (maritalMap[String(pessoa.maritalStatus).toLowerCase()] || pessoa.maritalStatus)
            : null;

        // Localizar registro existente
        const table  = isVisitor ? 'visitors' : 'persons';
        const docCol = isVisitor ? 'document' : 'cpf';

        let existing =
            await db.get(`SELECT id FROM ${table} WHERE idsecure_id = ?`, [String(idsecureId)]) ||
            await db.get(`SELECT id FROM ${table} WHERE registration_number = ?`, [registration]) ||
            (cleanCpf ? await db.get(`SELECT id FROM ${table} WHERE ${docCol} = ?`, [cleanCpf]) : null) ||
            (pessoa.name ? await db.get(`SELECT id FROM ${table} WHERE LOWER(name) = LOWER(?)`, [pessoa.name]) : null);

        const finalId = existing ? existing.id : idsecureId;

        // Foto
        let photoUrl = null;
        if (pessoa.personPhoto) {
            let b64 = typeof pessoa.personPhoto === 'object' ? pessoa.personPhoto.photo : pessoa.personPhoto;
            if (b64 && typeof b64 === 'string') {
                if (b64.includes(',')) b64 = b64.split(',')[1];
                photoUrl = await this.saveBase64Photo(tenantId, b64, finalId, isVisitor ? 'visitor' : 'person');
            }
        }

        // Determinar group_id e company_id a partir de personGroup
        let firstGroupId   = null;
        let firstCompanyId = null;
        if (pessoa.personGroup?.length > 0) {
            // Log na primeira vez para diagnóstico
            if (idsecureId && !IdSecureController._loggedPersonGroup) {
                IdSecureController._loggedPersonGroup = true;
                console.log('[IDSecure Import] personGroup sample:', JSON.stringify(pessoa.personGroup.slice(0, 3)));
            }

            for (const g of pessoa.personGroup) {
                // iDSecure pode usar groupId, id, ou group.id — tentar todos
                const gId = g.groupId ?? g.id ?? g.group?.id;
                if (gId == null) continue;

                // 1. Tentar pelo mapa em memória
                if (firstGroupId === null && groupsMap.has(gId)) {
                    firstGroupId = groupsMap.get(gId);
                }
                if (firstCompanyId === null && companiesMap.has(gId)) {
                    firstCompanyId = companiesMap.get(gId);
                }

                // 2. Fallback: buscar direto no banco pelo idsecure_id ou id
                if (firstGroupId === null) {
                    const grp = await db.get(
                        'SELECT id FROM groups WHERE idsecure_id = ? OR id = ?',
                        [String(gId), gId]
                    );
                    if (grp) firstGroupId = grp.id;
                }
                if (firstCompanyId === null) {
                    const comp = await db.get(
                        'SELECT id FROM companies WHERE idsecure_id = ? OR id = ?',
                        [String(gId), gId]
                    );
                    if (comp) firstCompanyId = comp.id;
                }
            }
        }

        if (isVisitor) {
            await db.run(
                `INSERT OR REPLACE INTO visitors
                    (id, name, document, rg, cellphone, email, status, photo_url,
                     tenant_id, registration_number, idsecure_id, visited_company_id,
                     created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     ?,
                     COALESCE((SELECT created_at FROM visitors WHERE id = ?), datetime('now')),
                     datetime('now'))`,
                [finalId, pessoa.name, cleanCpf, cleanRg, cellphone,
                 pessoa.email || '', status, photoUrl,
                 tenantId, registration, String(idsecureId),
                 firstCompanyId,
                 finalId]
            );
        } else {
            await db.run(
                `INSERT OR REPLACE INTO persons
                    (id, name, registration_number, email, cellphone, cellphone_ddi,
                     cpf, rg, birth_date, gender, marital_status,
                     profession, admission_date,
                     father_name, mother_name,
                     nationality, naturality,
                     address, neighborhood, city, state, cep,
                     status, photo_url,
                     group_id, company_id, idsecure_id,
                     created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?,
                     ?, ?,
                     ?, ?,
                     ?, ?,
                     ?, ?, ?, ?, ?,
                     ?, ?,
                     ?, ?, ?,
                     COALESCE((SELECT created_at FROM persons WHERE id = ?), datetime('now')),
                     datetime('now'))`,
                [
                    finalId,
                    pessoa.name,
                    registration,
                    pessoa.email || '',
                    cellphone,
                    cellphoneDDI || '+55',
                    cleanCpf,
                    cleanRg,
                    birthDate,
                    gender,
                    maritalStatus,
                    pessoa.professionalRole || null,
                    admDate,
                    pessoa.fathersName || null,
                    pessoa.mothersName || null,
                    pessoa.nacionality || null,
                    pessoa.naturality  || null,
                    pessoa.address      || null,
                    pessoa.neighborhood || null,
                    pessoa.city         || null,
                    pessoa.state        || null,
                    pessoa.zipCode      || null,
                    status,
                    photoUrl,
                    firstGroupId,
                    firstCompanyId,
                    String(idsecureId),
                    finalId
                ]
            );

            // Vincular empresa em company_owners
            if (firstCompanyId) {
                await db.run(
                    'INSERT OR IGNORE INTO company_owners (company_id, person_id) VALUES (?, ?)',
                    [firstCompanyId, finalId]
                );
            }
        }
    }

    // ─── Salvar foto base64 ───────────────────────────────────────────────────────
    async saveBase64Photo(tenantId, base64Data, personId, type) {
        try {
            const buffer   = Buffer.from(base64Data, 'base64');
            const fileName = `${tenantId}_${type}_${personId}_${Date.now()}.jpg`;
            const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'photos', type);
            await fs.promises.mkdir(uploadDir, { recursive: true });
            await fs.promises.writeFile(path.join(uploadDir, fileName), buffer);
            return `/uploads/photos/${type}/${fileName}`;
        } catch (e) {
            console.error(`[IDSecure Import] Erro ao salvar foto ${type} ${personId}: ${e.message}`);
            return null;
        }
    }
}

IdSecureController._loggedPersonGroup = false;

export default new IdSecureController();
