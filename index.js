// index.js（ヘッダー自動検出版）
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { google } = require('googleapis');

const app = express();
app.use(cors());

// ==== ENV ====
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
// タブ名が分からなくても動くように既定は先頭シート全体
const RANGE = process.env.HOSPITAL_RANGE || 'A1:Z200';

// ==== Auth loader ====
function getAuth() {
  if (process.env.GOOGLE_CREDENTIALS_BASE64) {
    const json = Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf8');
    const creds = JSON.parse(json);
    return new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  }
  throw new Error('No Google credentials found.');
}

function getServiceAccountEmailSafe() {
  try {
    if (process.env.GOOGLE_CREDENTIALS_BASE64) {
      const json = Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf8');
      return JSON.parse(json)?.client_email || null;
    }
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      const raw = fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8');
      return JSON.parse(raw)?.client_email || null;
    }
  } catch (_) {}
  return null;
}

// ==== helpers ====
async function getFirstSheetTitle(auth) {
  const s = google.sheets({ version: 'v4', auth });
  const meta = await s.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets(properties(title))',
  });
  const titles = (meta.data.sheets || []).map(x => x.properties.title);
  return titles[0] || null;
}

async function readRowsWithFallback(auth, range) {
  const s = google.sheets({ version: 'v4', auth });

  async function read(r) {
    const resp = await s.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: r,
    });
    return { rows: resp.data.values || [], effectiveRange: r };
  }

  try {
    return await read(range);
  } catch (e) {
    const code = e?.code || e?.response?.status;
    const msg = e?.message || '';
    const isRangeErr = code === 400 && msg.includes('Unable to parse range');
    if (!isRangeErr) throw e;

    const title = await getFirstSheetTitle(auth);
    if (!title) throw e;

    const fallback = range.includes('!') ? `'${title}'!A1:Z200` : `'${title}'!${range}`;
    return await read(fallback);
  }
}

// 見出し「病院名」「病院コード」を自動検出
function detectHeader(rows) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].map(v => (v ?? '').toString().trim());
    const nameCol = r.findIndex(c => c === '病院名');
    const codeCol = r.findIndex(c => c === '病院コード');
    if (nameCol !== -1 && codeCol !== -1) {
      return { headerRow: i, nameCol, codeCol };
    }
  }
  return { headerRow: -1, nameCol: -1, codeCol: -1 };
}

// ==== routes ====
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/debug/env', (_req, res) => {
  res.json({
    SPREADSHEET_ID_head: (SPREADSHEET_ID || '').slice(0, 10),
    RANGE,
    hasBase64: !!process.env.GOOGLE_CREDENTIALS_BASE64,
    hasLocalKey: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
    sa_email: getServiceAccountEmailSafe(),
  });
});

app.get('/debug/sheets', async (_req, res) => {
  try {
    const auth = getAuth();
    const s = google.sheets({ version: 'v4', auth });
    const meta = await s.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: 'sheets(properties(title))',
    });
    const titles = (meta.data.sheets || []).map(x => x.properties.title);
    res.json({ ok: true, sheets: titles, first: titles[0] || null });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message });
  }
});

app.get('/debug/sheet', async (_req, res) => {
  try {
    const auth = getAuth();
    const { rows, effectiveRange } = await readRowsWithFallback(auth, RANGE);
    const det = detectHeader(rows);
    res.json({
      ok: true,
      rows: rows.length,
      firstRow: rows[0] || null,
      headerRow: det.headerRow,
      nameCol: det.nameCol,
      codeCol: det.codeCol,
      effectiveRange,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      kind: 'sheet_read_failed',
      message: e?.message,
      code: e?.code || e?.response?.status || null,
      details: e?.response?.data || null,
    });
  }
});

// ?code=H00001 -> 病院名
app.get('/api/hospital', async (req, res) => {
  try {
    const code = (req.query.code || '').toString().trim();
    if (!code) return res.status(400).json({ error: 'code is required' });

    const auth = getAuth();
    const { rows } = await readRowsWithFallback(auth, RANGE);
    const norm = v => (v ?? '').toString().trim();

    const { headerRow, nameCol, codeCol } = detectHeader(rows);
    let data = rows;

    // ヘッダーが見つかったら、その行の次から検索
    if (headerRow !== -1) data = rows.slice(headerRow + 1);

    // 1) 見出しが検出できたらその列で検索
    if (nameCol !== -1 && codeCol !== -1) {
      const hit = data.find(r => norm(r[codeCol]) === code);
      if (hit) return res.json({ code, name: norm(hit[nameCol]) });
    }

    // 2) フォールバック：行内でコードがある列を見つけ、隣の非空セルを名前とみなす
    for (const r of data) {
      const idx = r.findIndex(cell => norm(cell) === code);
      if (idx !== -1) {
        const neighbors = [r[idx - 1], r[idx + 1]].map(norm).filter(Boolean);
        if (neighbors.length) return res.json({ code, name: neighbors[0] });
      }
    }

    return res.status(404).json({ error: 'not found' });
  } catch (e) {
    res.status(500).json({ error: 'internal_error', message: e?.message || 'unknown' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on :${PORT}`));
