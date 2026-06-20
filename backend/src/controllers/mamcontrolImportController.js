import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import dbManager from '../config/database.js';

async function downloadAndLink(vpsDb, localDb, table, baseUrl, vpsToken) {
    let rows;
    try {
        rows = vpsDb.prepare(
            `SELECT id, photo_url FROM ${table} WHERE photo_url IS NOT NULL AND photo_url != ''`
        ).all();
    } catch {
        // Table may not exist in this .db
        return { total: 0, downloaded: 0, updated: 0, errors: 0, results: [] };
    }

    const photoType = table === 'visitors' ? 'visitor' : 'person';
    const photosDir = path.join(process.cwd(), 'public', 'uploads', 'photos', photoType);
    await fs.mkdir(photosDir, { recursive: true });

    let downloaded = 0, updated = 0, errors = 0;
    const results = [];

    for (const row of rows) {
        try {
            let photoUrl = row.photo_url;

            if (!photoUrl.startsWith('http')) {
                photoUrl = baseUrl + '/' + photoUrl.replace(/^\//, '');
            }

            let urlObj;
            try {
                urlObj = new URL(photoUrl);
            } catch {
                errors++;
                results.push({ table, id: row.id, status: 'error', reason: 'URL inválida: ' + photoUrl });
                continue;
            }

            if (vpsToken) {
                urlObj.searchParams.set('token', vpsToken);
            }

            const pathParts = urlObj.pathname.split('/');
            let filename = pathParts[pathParts.length - 1];
            if (!filename) {
                filename = `mamcontrol_${photoType}_${row.id}_${Date.now()}.jpg`;
            }

            const localFilePath = path.join(photosDir, filename);

            const fetchResponse = await fetch(urlObj.toString(), {
                headers: vpsToken ? { Authorization: `Bearer ${vpsToken}` } : {}
            });

            if (!fetchResponse.ok) {
                errors++;
                results.push({ table, id: row.id, status: 'error', reason: `HTTP ${fetchResponse.status}` });
                continue;
            }

            const writeStream = createWriteStream(localFilePath);
            await pipeline(fetchResponse.body, writeStream);
            downloaded++;

            const localRelPath = `uploads/photos/${photoType}/${filename}`;
            const updateResult = await localDb.run(
                `UPDATE ${table} SET photo_url = ? WHERE id = ?`,
                [localRelPath, row.id]
            );

            if (updateResult.changes > 0) {
                updated++;
                results.push({ table, id: row.id, status: 'ok', filename });
            } else {
                results.push({ table, id: row.id, status: 'not_found', filename });
            }
        } catch (err) {
            errors++;
            results.push({ table, id: row.id, status: 'error', reason: err.message });
        }
    }

    return { total: rows.length, downloaded, updated, errors, results };
}

export async function importMamcontrol(req, res) {
    const tenantId = req.tenantId;
    const dbFile = req.file;
    const { vps_url, vps_token } = req.body;

    if (!dbFile) {
        return res.json({ success: false, message: 'Arquivo .db não enviado' });
    }
    if (!vps_url) {
        await fs.unlink(dbFile.path).catch(() => {});
        return res.json({ success: false, message: 'URL da VPS não informada' });
    }

    const baseUrl = vps_url.replace(/\/$/, '');

    try {
        const vpsDb = new Database(dbFile.path, { readonly: true });
        const localDb = await dbManager.getConnection(tenantId);

        let personsResult, visitorsResult;
        try {
            [personsResult, visitorsResult] = await Promise.all([
                downloadAndLink(vpsDb, localDb, 'persons', baseUrl, vps_token),
                downloadAndLink(vpsDb, localDb, 'visitors', baseUrl, vps_token)
            ]);
        } finally {
            vpsDb.close();
        }

        await fs.unlink(dbFile.path).catch(() => {});

        return res.json({
            success: true,
            data: {
                total: personsResult.total + visitorsResult.total,
                downloaded: personsResult.downloaded + visitorsResult.downloaded,
                updated: personsResult.updated + visitorsResult.updated,
                errors: personsResult.errors + visitorsResult.errors,
                persons: personsResult,
                visitors: visitorsResult
            }
        });
    } catch (err) {
        await fs.unlink(dbFile.path).catch(() => {});
        return res.json({ success: false, message: err.message });
    }
}
