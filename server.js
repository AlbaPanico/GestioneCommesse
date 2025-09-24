// File: server.js

const express = require('express');
const fs = require('fs');
const fse = require('fs-extra');
const path = require('path');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const cron = require('node-cron');
const { startMultiPrinterScheduler, rigeneraSettimana } = require('./stampantiMultiScheduler');
const crypto = require('crypto');
const app = express();
const { PDFDocument, StandardFonts } = require('pdf-lib');



const XLSX_STYLE = require('xlsx-style'); // per stili/scrittura
const XLSX = require('xlsx');             // per creare fogli da array
const { spawn } = require('child_process');

const TEMPLATE_DDT_PATH = path.join(__dirname, 'Template', 'DDT_Work.xlsx');
const PYTHON_PATH = 'python'; // o 'python3'
const MATERIALI_SCRIPT = 'C:\\Users\\Applicazioni\\Gestione Commesse\\FinestraMateriali.py';

// ───────────────────────────────────────────────────────────────────────────────
// Target automatico: mappa IP chiamante -> PC (da presence files degli agent)
// ───────────────────────────────────────────────────────────────────────────────
const AGENTS_DIR = '\\\\192.168.1.250\\users\\applicazioni\\gestione commesse\\data\\agents';

function getClientIp(req) {
  let ip = (req.headers['x-forwarded-for'] || req.connection?.remoteAddress || req.socket?.remoteAddress || '').toString();
  ip = ip.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.substring(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

function readJsonSafe(fp) {
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8') || '{}');
  } catch {}
  return {};
}

function pickPcFromPresenceByIp(ip) {
  try {
    if (!fs.existsSync(AGENTS_DIR)) return null;
    const files = fs.readdirSync(AGENTS_DIR).filter(f => f.toLowerCase().endsWith('.json'));
    let best = null; // { pcname, ip, last_seen_ts }
    for (const f of files) {
      const obj = readJsonSafe(path.join(AGENTS_DIR, f));
      const pc  = (obj.pcname || '').toString().trim();
      const pip = (obj.ip || '').toString().trim();
      const ls  = Date.parse(obj.last_seen || '') || 0;
      if (!pc || !pip) continue;
      if (pip !== ip) continue;
      const fresh = (Date.now() - ls) <= 60_000; // “vivo” negli ultimi 60s
      if (!fresh) continue;
      if (!best || ls > best.last_seen_ts) best = { pcname: pc, ip: pip, last_seen_ts: ls };
    }
    return best ? best.pcname : null;
  } catch {
    return null;
  }
}


// ───────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ───────────────────────────────────────────────────────────────────────────────
console.log('Controllo backend materiali Flask...');
try {
  const { execSync } = require('child_process');
  const list = execSync('tasklist /FI "IMAGENAME eq python.exe" /V').toString().toLowerCase();

  if (!list.includes('finestramateriali.py')) {
    console.log('Avvio backend materiali Flask…');
    const materialiProc = spawn(PYTHON_PATH, [MATERIALI_SCRIPT], { detached: false, stdio: 'ignore' });

    materialiProc.on('error', (e) => {
      console.warn('[materiali] errore avvio:', e?.message || String(e));
    });

    // chiudi il python quando chiude il server node
    process.on('exit', () => { try { materialiProc.kill(); } catch {} });
  } else {
    console.log('Backend materiali Flask già in esecuzione: skip avvio.');
  }
} catch (e) {
  console.warn('Impossibile verificare i processi Python:', e?.message || String(e));
}

app.use(cors());
app.use(express.json({ limit: '200mb' }));

// Utenti attivi (websocket presence)
let activeUsers = [];
const notifyActiveUsers = () => {
  const message = JSON.stringify({ type: 'activeUsers', data: activeUsers });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(message); });
};

// ───────────────────────────────────────────────────────────────────────────────
// Impostazioni globali + file data
// ───────────────────────────────────────────────────────────────────────────────
const settingsFolderPath = '\\\\192.168.1.250\\users\\applicazioni\\gestione commesse\\data';
if (!fs.existsSync(settingsFolderPath)) fs.mkdirSync(settingsFolderPath, { recursive: true });
const settingsFilePath = path.join(settingsFolderPath, 'impostazioni.json');

// ── BOLLE USCITA (SENZA reset: progressivo monotono crescente)
const bolleUscitaPath = path.join(__dirname, 'data', 'bolle_in_uscita.json');
const oggiISO = () => new Date().toISOString().split('T')[0];

function ensureFile(dirPath, defaultObj) {
  if (!fs.existsSync(path.dirname(dirPath))) fs.mkdirSync(path.dirname(dirPath), { recursive: true });
  if (!fs.existsSync(dirPath)) fs.writeFileSync(dirPath, JSON.stringify(defaultObj, null, 2));
}

function getBolleUscita() {
  // file minimale { progressivo: N } – accetta anche vecchia struttura con ultimaData
  ensureFile(bolleUscitaPath, { progressivo: 1 });
  try {
    const data = JSON.parse(fs.readFileSync(bolleUscitaPath, 'utf8')) || {};
    const progressivo = Number(data.progressivo) > 0 ? Number(data.progressivo) : 1;
    return { progressivo };
  } catch {
    const initial = { progressivo: 1 };
    fs.writeFileSync(bolleUscitaPath, JSON.stringify(initial, null, 2));
    return initial;
  }
}

function saveBolleUscita(prog) {
  const record = { progressivo: prog };
  fs.writeFileSync(bolleUscitaPath, JSON.stringify(record, null, 2));
  console.log('🚚 SALVATO bolle_in_uscita.json:', record);
}


// ── BOLLE ENTRATA (senza reset)
const bolleEntrataPath = path.join(__dirname, 'data', 'bolle_in_entrata.json');
function getBolleEntrata() {
  ensureFile(bolleEntrataPath, { progressivo: 1 });
  try {
    return JSON.parse(fs.readFileSync(bolleEntrataPath, 'utf8')) || { progressivo: 1 };
  } catch {
    const initial = { progressivo: 1 };
    fs.writeFileSync(bolleEntrataPath, JSON.stringify(initial, null, 2));
    return initial;
  }
}
function saveBolleEntrata(prog) {
  const record = { progressivo: prog };
  fs.writeFileSync(bolleEntrataPath, JSON.stringify(record, null, 2));
  console.log('🚚 SALVATO bolle_in_entrata.json:', record);
}

// ───────────────────────────────────────────────────────────────────────────────
// Users (demo auth locale)
// ───────────────────────────────────────────────────────────────────────────────
const usersFilePath = path.join(__dirname, 'data', 'users.json');
const readUsers = () => (fs.existsSync(usersFilePath) ? JSON.parse(fs.readFileSync(usersFilePath, 'utf8') || '[]') : []);
const saveUsers = (users) => {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2));
};

app.post('/api/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e password sono obbligatorie.' });
  const users = readUsers();
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(400).json({ error: 'Email già registrata.' });
  }
  const newUser = { email, password };
  users.push(newUser); saveUsers(users);
  console.log(`Nuovo utente registrato: ${email}`);
  res.json({ message: 'Registrazione completata!', user: newUser });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e password sono obbligatorie.' });
  const users = readUsers();
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password);
  if (!user) return res.status(401).json({ error: 'Credenziali non valide.' });
  console.log(`Utente loggato: ${email}`);
  res.json({ message: 'Login effettuato con successo!', user });
  if (!activeUsers.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    activeUsers.push({ email, lastPing: Date.now() });
    notifyActiveUsers();
  }
});

app.post('/api/logout', (req, res) => {
  const { email } = req.body;
  activeUsers = activeUsers.filter(u => u.email.toLowerCase() !== String(email).toLowerCase());
  notifyActiveUsers();
  res.json({ message: 'Logout effettuato con successo!' });
});

app.post('/api/ping', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email mancante' });
  const user = activeUsers.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (user) user.lastPing = Date.now(); else activeUsers.push({ email, lastPing: Date.now() });
  notifyActiveUsers();
  res.json({ message: 'Ping ricevuto' });
});

// ───────────────────────────────────────────────────────────────────────────────
// Utility locali
// ───────────────────────────────────────────────────────────────────────────────
app.post('/api/open-folder-local', (req, res) => {
  const { folderPath, target, targets, broadcast } = req.body || {};
  if (!folderPath) return res.status(400).json({ message: 'Percorso mancante' });

  // Percorso del file comando (stesso che legge ApptimepassV2)
  const cmdDir  = '\\\\192.168.1.250\\users\\applicazioni\\gestione commesse\\data';
  const cmdFile = path.join(cmdDir, 'apptimepass_cmd.json');
  const tmpFile = cmdFile + '.tmp';

  try {
    if (!fs.existsSync(cmdDir)) fs.mkdirSync(cmdDir, { recursive: true });

    // === Auto-target se non specificato esplicitamente ===
    let finalTarget = target;
    let finalTargetsArr = Array.isArray(targets) ? targets : undefined;
    let finalBroadcast = (broadcast === true);

    if (!finalBroadcast && !finalTarget && !finalTargetsArr) {
      const callerIp = getClientIp(req);
      const pcname = pickPcFromPresenceByIp(callerIp);
      if (pcname) finalTarget = pcname; // usa il PC rilevato dall’IP
    }

    const payload = {
      action: 'open_folder',
      folder: folderPath,
      ...(finalBroadcast ? { broadcast: true } : {}),
      ...(finalTargetsArr ? { targets: finalTargetsArr } : (finalTarget ? { target: finalTarget } : {})),
    };

    // scrittura JSON “pulita” (senza BOM) e atomica
    fs.writeFileSync(tmpFile, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmpFile, cmdFile);

    return res.json({
      ok: true,
      message: 'Comando scritto.',
      debug: { autoTargetUsed: !broadcast && !targets && !target, target: finalTarget, callerIp: getClientIp(req) }
    });
  } catch (err) {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
    return res.status(500).json({ ok: false, message: 'Errore scrivendo il file comando.', error: String(err) });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// // ───────────────────────────────────────────────────────────────────────────────
// Upload report (PDF/Excel) in cartelle commessa
// – Patch: anti-doppio DDT W nello stesso giorno per la stessa commessa
// ───────────────────────────────────────────────────────────────────────────────
app.post('/api/save-pdf-report', (req, res) => {
  const { folderPath, pdfData, fileName } = req.body;
  if (!folderPath || !pdfData) {
    return res.status(400).json({ message: "I parametri 'folderPath' e 'pdfData' sono obbligatori." });
  }

  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  const pdfPath = path.join(folderPath, fileName || 'report.pdf');

  // togli la parte "data:application/pdf;base64," e tieni solo i byte
  const idx = pdfData.indexOf('base64,');
  if (idx === -1) {
    return res.status(400).json({ message: 'Formato di pdfData non valido.' });
  }
  const pdfBuffer = Buffer.from(pdfData.substring(idx + 'base64,'.length), 'base64');

  // ───────────────────────────────────────────────────────────────────────────
  // LOCK di cartella per evitare salvataggi concorrenti ravvicinati
  // ───────────────────────────────────────────────────────────────────────────
  const locksDir = path.join(__dirname, 'data', 'locks');
  if (!fs.existsSync(locksDir)) fs.mkdirSync(locksDir, { recursive: true });
  const lockName = 'save_' + crypto.createHash('md5').update(path.resolve(folderPath)).digest('hex') + '.lock';
  const lockFile = path.join(locksDir, lockName);
  let lockFd = null;
  try {
    lockFd = fs.openSync(lockFile, 'wx');
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      return res.status(423).json({ message: 'Salvataggio in corso, riprova tra poco.' });
    }
    return res.status(500).json({ message: 'Errore creando il lock.', error: String(e) });
  }

  const releaseLock = () => {
    try { if (lockFd !== null) fs.closeSync(lockFd); } catch {}
    try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch {}
  };

  try {
    // ⛔ se esiste già proprio quel file, blocchiamo
    if (fs.existsSync(pdfPath)) {
      releaseLock();
      return res.status(409).json({ message: 'File già esistente: non sovrascrivo.', path: pdfPath });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Se il file è un DDT di ENTRATA (…W…) imponiamo “al massimo 1 al giorno”
    // per la stessa commessa (codice visivo derivato dalla cartella).
    // Nome atteso: DDT_####W_<qualcosa_con_codice>_dd-mm-yyyy.pdf (o dd_mm_yyyy)
    // ─────────────────────────────────────────────────────────────────────────
    const name = String(fileName || '').trim();
    const isW = /^DDT_\d{4}W_/i.test(name);
    if (isW) {
      // codice “visivo” dalla cartella (es. C8888-11)
      const codiceVisivo = normalizeCodiceVisivo(getCodiceCommessaVisuale(folderPath));
      // data dal nome file (preferibile al "today" del server)
      const m = name.match(/_(\d{2})[-_](\d{2})[-_](\d{4})\.pdf$/i);
      if (codiceVisivo && m) {
        const dd = m[1], mm = m[2], yyyy = m[3];
        const pattOggi = new RegExp(
          `^DDT_(\\d{4})W_.*${escapeReg(codiceVisivo)}_${escapeReg(dd)}[-_]${escapeReg(mm)}[-_]${escapeReg(yyyy)}\\.pdf$`,
          'i'
        );
        const materialiPath = folderPath; // in questo endpoint arriva già MATERIALI come folderPath
        // se invece ci passano la cartella madre, prova a puntare a MATERIALI
        const dirToScan = fs.existsSync(path.join(folderPath, 'MATERIALI')) ? path.join(folderPath, 'MATERIALI') : folderPath;

        try {
          const existsSameDay = fs.readdirSync(dirToScan).some(fn => pattOggi.test(fn));
          if (existsSameDay) {
            releaseLock();
            return res.status(409).json({
              message: 'Bolla di ENTRATA già presente per questa commessa nella stessa data. Blocco duplicato.',
              code: 'W_ALREADY_EXISTS_TODAY',
            });
          }
        } catch (e) {
          // se la scansione fallisce non blocchiamo, ma logghiamo
          console.warn('[save-pdf-report] warning scanning dir for duplicate W:', e?.message || String(e));
        }
      }
    }

    // scrittura atomica: fallisce se il file esiste già
    fs.open(pdfPath, 'wx', (err, fd) => {
      if (err) {
        releaseLock();
        return res.status(500).json({ message: 'Errore apertura file (wx).', error: err.toString() });
      }
      fs.write(fd, pdfBuffer, 0, pdfBuffer.length, null, (err2) => {
        try { fs.closeSync(fd); } catch {}
        releaseLock();
        if (err2) {
          return res.status(500).json({ message: 'Errore scrivendo il PDF', error: err2.toString() });
        }
        return res.json({ message: 'PDF salvato con successo!', path: pdfPath });
      });
    });
  } catch (e) {
    releaseLock();
    return res.status(500).json({ message: 'Errore interno salvataggio PDF.', error: String(e) });
  }
});


app.post('/api/save-excel-report', (req, res) => {
  const { folderPath, excelData, fileName } = req.body;
  if (!folderPath || !excelData) return res.status(400).json({ message: "I parametri 'folderPath' e 'excelData' sono obbligatori." });
  if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });

  const excelPath = path.join(folderPath, fileName || 'distinta_materiali.xlsx');
  const idx = excelData.indexOf('base64,'); if (idx === -1) return res.status(400).json({ message: 'Formato di excelData non valido.' });
  const excelBuffer = Buffer.from(excelData.substring(idx + 'base64,'.length), 'base64');

  fs.writeFile(excelPath, excelBuffer, (err) => {
    if (err) return res.status(500).json({ message: "Errore nel salvataggio dell'Excel", error: err.toString() });
    res.json({ message: 'Excel salvato con successo!', path: excelPath });
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// DDT Excel via Python
// ───────────────────────────────────────────────────────────────────────────────
app.post('/api/genera-ddt-excel', (req, res) => {
  try {
    const reportDdtPath = req.body.reportDdtPath || req.body.reportDdtBasePath || req.body.basePath;
    const datiDdtIn = req.body.datiDdt || req.body;
    if (!reportDdtPath || !datiDdtIn) return res.status(400).json({ error: 'reportDdtPath e datiDdt sono obbligatori' });

    let descrizione = (datiDdtIn.descrizione || '').trim();
    let nomeCommessa = (datiDdtIn.nomeCommessa || '').trim();

    const folderPath =
      datiDdtIn.folderPath ||
      datiDdtIn.percorso ||
      (datiDdtIn.percorsoPdf && path.dirname(datiDdtIn.percorsoPdf) && path.dirname(path.dirname(datiDdtIn.percorsoPdf)));

    if ((!descrizione || !nomeCommessa) && folderPath) {
      try {
        const reportFile = path.join(folderPath, 'report.json');
        if (fs.existsSync(reportFile)) {
          const rep = JSON.parse(fs.readFileSync(reportFile, 'utf8') || '{}');
          const nomeCartella = rep?.brand && rep?.nomeProdotto && rep?.codiceProgetto && rep?.codiceCommessa
            ? `${rep.brand}_${rep.nomeProdotto}_${rep.codiceProgetto}_${rep.codiceCommessa}` : '';
          if (!descrizione) descrizione = nomeCartella ? `Assembraggio ${nomeCartella}` : '';
          if (!nomeCommessa && nomeCartella) {
            const m = String(descrizione || (`Assembraggio ${nomeCartella}`)).split('_');
            if (m.length >= 3) nomeCommessa = m[1].trim();
          }
        }
      } catch (e) { console.warn('[/api/genera-ddt-excel] Warning leggendo report.json:', e.toString()); }
    }

    if (!nomeCommessa && descrizione) {
      const parti = String(descrizione).split('_'); if (parti.length >= 3) nomeCommessa = parti[1].trim();
    }
    if (!descrizione) {
      const brand = (datiDdtIn.brand || '').trim();
      const nomeProdotto = (datiDdtIn.nomeProdotto || '').trim();
      const codiceProgetto = (datiDdtIn.codiceProgetto || '').trim();
      const codiceCommessa = (datiDdtIn.codiceCommessa || '').trim();
      const nomeCartella = (brand && nomeProdotto && codiceProgetto && codiceCommessa) ? `${brand}_${nomeProdotto}_${codiceProgetto}_${codiceCommessa}` : '';
      descrizione = nomeCartella ? `Assembraggio ${nomeCartella}` : '';
    }

    const datiPerPython = { ...datiDdtIn, descrizione, nomeCommessa };
    const tempJsonPath = path.join(__dirname, 'data', `temp_ddt_${Date.now()}.json`);
    fs.writeFileSync(tempJsonPath, JSON.stringify(datiPerPython, null, 2), 'utf8');

    const pythonScript = path.join(__dirname, 'genera_excel_ddt.py');
    const proc = spawn(PYTHON_PATH, [pythonScript, tempJsonPath, reportDdtPath]);

    let stdoutData = '', stderrData = '';
    proc.stdout?.on('data', d => { stdoutData += d.toString(); });
    proc.stderr?.on('data', d => { stderrData += d.toString(); });

    proc.on('exit', (code) => {
      try { fs.unlinkSync(tempJsonPath); } catch {}
      if (stdoutData.includes('NON aggiornato')) return res.status(409).json({ message: stdoutData.trim(), debug: stdoutData });
      if (code === 0) return res.json({ message: 'Report Excel generato!', debug: stdoutData.trim() });
      return res.status(500).json({ error: `Python script failed (code ${code})`, stderr: stderrData, stdout: stdoutData });
    });

    proc.on('error', (err) => {
      try { fs.unlinkSync(tempJsonPath); } catch {}
      res.status(500).json({ error: err.toString() });
    });
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────────────
// File utils + Archivio predefinito
// ───────────────────────────────────────────────────────────────────────────────
const DEFAULT_ARCHIVIO_DIR = '\\\\192.168.1.248\\time dati\\ARCHIVIO TECNICO\\ARCHIVIO\\';

app.post('/api/lista-file', (req, res) => {
  const { folderPath } = req.body;
  if (!folderPath) return res.status(400).json({ error: 'folderPath mancante' });
  fs.readdir(folderPath, { withFileTypes: true }, (err, files) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(files.filter(f => f.isFile()).map(f => f.name));
  });
});

// Elenco cartelle commessa nell'ARCHIVIO (default UNC)
// Ritorna: [{ name, fullPath, mtimeMs }]

// ───────────────────────────────────────────────────────────────
// Browse cartelle di rete (default su UNC archivio tecnico)
// ───────────────────────────────────────────────────────────────
function normalizeBackslashes(p) { return String(p || '').replace(/[\\/]+/g, '\\').trim(); }
function parentPathWin(p) {
  const norm = normalizeBackslashes(p);
  if (norm.startsWith('\\\\')) {
    const parts = norm.split('\\').filter(Boolean);
    if (parts.length <= 2) return null; // non si sale sopra \\server\share
    return '\\\\' + parts.slice(0, parts.length - 1).join('\\') + '\\';
  } else {
    const par = path.dirname(norm.endsWith('\\') ? norm.slice(0, -1) : norm);
    if (!par || par === norm) return null;
    return par.endsWith('\\') ? par : (par + '\\');
  }
}

app.post('/api/browse-dir', (req, res) => {
  try {
    const { basePath } = req.body || {};
    const target = normalizeBackslashes(basePath && basePath.length ? basePath : DEFAULT_ARCHIVIO_DIR);

    if (!fs.existsSync(target)) {
      return res.status(404).json({ error: 'Percorso non raggiungibile', path: target });
    }

    let entries = [];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true })
        .map(e => ({
          name: e.name,
          isDir: e.isDirectory(),
          isFile: e.isFile(),
          mtimeMs: (() => {
            try { return fs.statSync(path.join(target, e.name)).mtimeMs; } catch { return 0; }
          })()
        }))
        .sort((a, b) => (a.isDir !== b.isDir) ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));
    } catch {
      return res.status(403).json({ error: 'Accesso negato alla cartella', path: target });
    }

    res.json({
      path: target.endsWith('\\') ? target : target + '\\',
      parentPath: parentPathWin(target),
      entries
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});





/**
 * Elenco cartelle “commesse” in una base directory (default: UNC ARCHIVIO).
 * - Metodo: GET /api/lista-commesse?basePath=\\server\share\cartella (opzionale)
 * - Ritorna: [{ name, fullPath, mtimeMs }]
 */
app.get('/api/lista-commesse', (req, res) => {
  // Base UNC “di default” richiesta
  const DEFAULT_BASE = '\\\\192.168.1.248\\time dati\\ARCHIVIO TECNICO\\ARCHIVIO\\';

  // Permetti override opzionale via query, ma di default usa la UNC
  const basePathRaw = (req.query?.basePath || DEFAULT_BASE).toString().trim();
  const basePath = basePathRaw.replace(/[\\/]+$/,''); // togli eventuale slash finale

  try {
    if (!fs.existsSync(basePath)) {
      return res.status(404).json({ ok: false, error: 'Base path inesistente o non raggiungibile.', basePath });
    }

    // Leggi directory e filtra solo cartelle
    const entries = fs.readdirSync(basePath, { withFileTypes: true })
      .filter(d => d && typeof d.isDirectory === 'function' && d.isDirectory());

    // Mappa: name, fullPath e mtime (per ordinare o mostrare info)
    const out = entries.map(d => {
      const fullPath = path.join(basePath, d.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(fullPath).mtimeMs; } catch {}
      return { name: d.name, fullPath, mtimeMs };
    })
    // Ordina per mtime desc (recenti in alto)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

    return res.json({ ok: true, basePath, items: out });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err), basePath: basePathRaw });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Progressivi Bolle
// ───────────────────────────────────────────────────────────────────────────────
app.get('/api/prossima-bolla', (req, res) => {
  try { syncProgressivi({ forT: true, forW: false }); } catch {}
  const bolle = getBolleUscita();
  res.json({ numeroBolla: String(bolle.progressivo).padStart(4, '0') });
});

// Uscita (T): AVANZA (senza reset) + nome file standard
app.post('/api/avanza-bolla', (req, res) => {
  try { syncProgressivi({ forT: true, forW: false }); } catch {}

  const lockPath = path.join(__dirname, 'data', 'bolle_in_uscita.lock');
  let lockFd = null;

  try {
    // Lock atomico: evita doppi avanzamenti concorrenti
    lockFd = fs.openSync(lockPath, 'wx');

    const bolle = getBolleUscita();
    const progressivo = bolle.progressivo;              // numero da usare ORA
    saveBolleUscita(progressivo + 1);                   // prepara il prossimo

    const todayIso = oggiISO();

    // Nome file: DDT_<NNNNT>_<Cxxxx[-yy]>_<dd-mm-yyyy>.pdf
    const folderPath = req.body?.folderPath || '';
    let codiceVisivoRaw = folderPath ? getCodiceCommessaVisuale(folderPath) : '';
    let codiceVisivo = normalizeCodiceVisivo(codiceVisivoRaw);

    const suffissoC = codiceVisivo ? `_${codiceVisivo}` : '';
    const nomeFileSuggerito = `DDT_${String(progressivo).padStart(4,'0')}T${suffissoC}_${oggiStr()}.pdf`;

    const logLine = `[${new Date().toISOString()}] BOLLA generata - Numero: ${String(progressivo).padStart(4, '0')}T\n`;
    fs.appendFileSync(path.join(__dirname, 'data', 'bolle.log'), logLine);

    const payload = {
      numeroBolla: String(progressivo).padStart(4, '0'),
      dataTrasporto: todayIso,
      suggestedFileName: nomeFileSuggerito
    };

    // Rilascia lock
    try { fs.closeSync(lockFd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}

    return res.json(payload);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      return res.status(423).json({ message: 'Progressivo in aggiornamento, riprova tra pochi istanti.' });
    }
    return res.status(500).json({ message: 'Errore avanzando progressivo bolla uscita.', error: String(err) });
  } finally {
    try { if (lockFd !== null) fs.closeSync(lockFd); } catch {}
    try { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch {}
  }
});


// Entrata: SOLO LETTURA (senza prefisso)
app.get('/api/prossima-bolla-entrata', (req, res) => {
  const bolle = getBolleEntrata();
  res.json({ numeroBolla: String(bolle.progressivo).padStart(4, '0') });
});

// Entrata: AVANZA (senza prefisso)
app.post('/api/avanza-bolla-entrata', (req, res) => {
  const lockPath = path.join(__dirname, 'data', 'bolle_in_entrata.lock');
  let lockFd = null;
  try {
    // Acquisisci lock atomico: fallisce se già presente
    lockFd = fs.openSync(lockPath, 'wx');

    const bolle = getBolleEntrata();
    const progressivo = bolle.progressivo;
    saveBolleEntrata(progressivo + 1);

    const payload = { numeroBolla: String(progressivo).padStart(4, '0') };

    // Rilascia lock
    try { fs.closeSync(lockFd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}

    return res.json(payload);
  } catch (err) {
    // Se un'altra richiesta sta avanzando in questo istante
    if (err && err.code === 'EEXIST') {
      return res.status(423).json({ message: 'Progressivo in aggiornamento, riprova tra pochi istanti.' });
    }
    return res.status(500).json({ message: 'Errore avanzando progressivo bolla entrata.', error: String(err) });
  } finally {
    // Safety: in caso di eccezioni intermedie
    try { if (lockFd !== null) fs.closeSync(lockFd); } catch {}
    try { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch {}
  }
});

// --- SYNC progressivi dai PDF esistenti (T e W ENTRAMBI globali) --------------
function syncProgressivi({ forT = true, forW = true } = {}) {
  try {
    if (!fs.existsSync(settingsFilePath)) return;
    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8') || '{}');
    const baseFolder = settings.percorsoCartella;
    if (!baseFolder || !fs.existsSync(baseFolder)) return;

    const patternCartella = /^([^_]+)_([^_]+)_([^_]+)_([^_]+)$/;
    const entries = fs.readdirSync(baseFolder, { withFileTypes: true });
    let maxT = 0, maxW = 0;

    // pattern GENERICI (qualsiasi data)
    const patT = [/^DDT_(\d{4})T_.*\.pdf$/i];
    const patW = [
      /^DDT_(\d{4})W_.*_(\d{2})-(\d{2})-(\d{4})\.pdf$/i,
      /^DDT_(\d{4})W_.*_(\d{2})_(\d{2})_(\d{4})\.pdf$/i,
    ];

    for (const e of entries) {
      if (!e.isDirectory() || !patternCartella.test(e.name)) continue;
      const materiali = path.join(baseFolder, e.name, 'MATERIALI');
      if (!fs.existsSync(materiali)) continue;

      for (const f of fs.readdirSync(materiali)) {
        if (forT) {
          for (const p of patT) {
            const m = f.match(p);
            if (m) { const n = parseInt(m[1], 10); if (n > maxT) maxT = n; break; }
          }
        }
        if (forW) {
          for (const p of patW) {
            const m = f.match(p);
            if (m) { const n = parseInt(m[1], 10); if (n > maxW) maxW = n; break; }
          }
        }
      }
    }

    if (forT) {
      // prossimo T = max GLOBALE + 1 (nessun reset)
      const nextT = (maxT || 0) + 1;
      saveBolleUscita(nextT);
    }
    if (forW) {
      // prossimo W = max globale + 1 (già senza reset)
      const nextW = (maxW || 0) + 1;
      saveBolleEntrata(nextW);
    }
  } catch (e) {
    console.warn('[syncProgressivi] warning:', e?.message || String(e));
  }
}


// === UTIL per generare la Bolla ENTRATA (W) anche senza T ===
function pad4(n) { return String(n).padStart(4, '0'); }
function oggiStr() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth()+1)}-${d.getFullYear()}`; // dd-mm-yyyy
}
function oggiStrSlash() { return oggiStr().replace(/-/g, '/'); }       // dd/mm/yyyy
function escapeReg(s) { return String(s).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'); }

// Prendo 'Cxxxx-yy' da report.json se c'è, altrimenti dal nome cartella (..._Cxxxx-yy)
function getCodiceCommessaVisuale(folderPath) {
  try {
    const repPath = path.join(folderPath, 'report.json');
    if (fs.existsSync(repPath)) {
      const rep = JSON.parse(fs.readFileSync(repPath, 'utf8') || '{}');
      if (rep && typeof rep.codiceCommessa === 'string' && rep.codiceCommessa.trim()) {
        return rep.codiceCommessa.trim(); // es. C8888-11
      }
    }
  } catch {}
  const base = path.basename(folderPath);
  const m = base.match(/_C([A-Za-z0-9\-]+)$/);
  return m ? ('C' + m[1]) : '';
}

function normalizeCodiceVisivo(input) {
  const s = String(input || '').trim();
  if (!s) return '';

  // caso tipico preso dal nome cartella: "..._C9999-11"
  let m = s.match(/_C([A-Za-z0-9\-]+)$/);
  if (m) return 'C' + m[1];

  // se è già "C..." lascialo così
  if (/^C[A-Za-z0-9\-]+$/.test(s)) return s;

  // stringhe tipo "AAA_aaa_P123_C9999" -> prendi l’ultimo token che inizia con C
  const parts = s.split('_').filter(Boolean);
  const lastC = [...parts].reverse().find(p => /^C[A-Za-z0-9\-]+$/.test(p));
  return lastC || '';
}


// Somma colli da report.json (fallback opzionale)
function getColliDaReportSync(folderPath, fallback = '') {
  try {
    const rf = path.join(folderPath, 'report.json');
    if (!fs.existsSync(rf)) return fallback;
    const data = JSON.parse(fs.readFileSync(rf, 'utf8') || '{}');
    if (data && Array.isArray(data.consegne) && data.consegne.length > 0) {
      let somma = 0;
      for (const c of data.consegne) {
        if (Array.isArray(c.bancali)) {
          somma += c.bancali.reduce((t, b) => t + (parseInt(b.quantiBancali) || 0), 0);
        }
      }
      if (somma > 0) return somma;
    }
    return fallback;
  } catch { return fallback; }
}

// Cerca la T più recente (opzionale): se non trovata, ritorna null
function findUscitaOptional(materialiPath, codiceVisivo) {
  try {
    const files = fs.readdirSync(materialiPath);
    let best = null; // { num, dd, mm, yyyy }
    const pats = [
      new RegExp(`^DDT_(\\d{4})T_.*${escapeReg(codiceVisivo)}_(\\d{2})-(\\d{2})-(\\d{4})\\.pdf$`, 'i'),
      new RegExp(`^DDT_(\\d{4})T_.*${escapeReg(codiceVisivo)}_(\\d{2})_(\\d{2})_(\\d{4})\\.pdf$`, 'i'),
    ];
    for (const f of files) {
      for (const pat of pats) {
        const m = f.match(pat);
        if (m) {
          const num = parseInt(m[1], 10);
          if (!best || num > best.num) best = { num, dd: m[2], mm: m[3], yyyy: m[4] };
          break;
        }
      }
    }
    if (!best) return null;
    return { numeroT: pad4(best.num) + 'T', dataT: `${best.dd}/${best.mm}/${best.yyyy}` };
  } catch { return null; }
}

// Core: genera il PDF W e lo salva in <cartella>/MATERIALI
// Funzione unica per DDT ENTRATA (manuale e automatica)
async function generaBollaEntrata({ folderPath, advance = true }) {
  try {
    if (!folderPath || !fs.existsSync(folderPath)) {
      return { ok: false, error: 'folderPath non valido' };
    }

    const materialiPath = path.join(folderPath, 'MATERIALI');
    if (!fs.existsSync(materialiPath)) fs.mkdirSync(materialiPath, { recursive: true });

    // ── LOCK per CARTELLA: una sola generazione W alla volta per questa commessa
    const locksDir = path.join(__dirname, 'data', 'locks');
    if (!fs.existsSync(locksDir)) fs.mkdirSync(locksDir, { recursive: true });
    const lockName = 'w_' + crypto.createHash('md5').update(path.resolve(folderPath)).digest('hex') + '.lock';
    const lockPath = path.join(locksDir, lockName);
    let lockFd = null;
    try {
      lockFd = fs.openSync(lockPath, 'wx'); // fallisce se già in corso
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        return { ok: true, note: 'Generazione W già in corso per questa commessa: skip' };
      }
      return { ok: false, error: e?.message || String(e) };
    }

    try {
      // sincronizza sempre prima di usare progressivo W
      try { syncProgressivi({ forT: false, forW: true }); } catch {}

      // impostazioni: master ENTRATA
      if (!fs.existsSync(settingsFilePath)) return { ok:false, error:'impostazioni non trovate' };
      const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8') || '{}');
      const masterPDF = settings.masterBolleEntrata;
      if (!masterPDF || !fs.existsSync(masterPDF)) {
        return { ok:false, error:'masterBolleEntrata non impostato/trovato' };
      }

      // dati base
      let codiceVisivoRaw = getCodiceCommessaVisuale(folderPath); // es. C8888-11
      let codiceVisivo = normalizeCodiceVisivo(codiceVisivoRaw);

      const dataDocIT = new Date().toLocaleDateString('it-IT');
      const dataFileDash = oggiStr();               // dd-mm-yyyy
      const dataFileUnd  = dataFileDash.replace(/-/g, '_');

      // ── PRE-CHECK: se esiste già una W per QUESTO CODICE e OGGI, non rigenerare
      const pattToday = [
        new RegExp(`^DDT_(\\d{4})W_.*${escapeReg(codiceVisivo)}_${escapeReg(dataFileDash)}\\.pdf$`, 'i'),
        new RegExp(`^DDT_(\\d{4})W_.*${escapeReg(codiceVisivo)}_${escapeReg(dataFileUnd)}\\.pdf$`,  'i'),
      ];
      const giàPresenteOggi = fs.readdirSync(materialiPath).some(fn => pattToday.some(p => p.test(fn)));
      if (giàPresenteOggi) {
        return {
          ok: true,
          materialiPath,
          fileName: null,
          numeroDoc: null,
          dataDocIT,
          codiceVisivo,
          note: 'DDT W odierno già presente per questa commessa: evitata duplicazione'
        };
      }

      // progressivo ENTRATA: leggi ma NON avanzare ancora
      const bolle = getBolleEntrata();
      const progressivoCorrente = bolle.progressivo;
      const numeroPuro = pad4(progressivoCorrente);
      const numeroDoc = numeroPuro + 'W';

      // descrizione, qta, colli
      const baseName = path.basename(folderPath);
      const descrizione = 'Assembraggio ' + baseName;

      let quantita = '';
      try {
        const rep = JSON.parse(fs.readFileSync(path.join(folderPath, 'report.json'), 'utf8') || '{}');
        if (rep && (rep.quantita !== undefined && rep.quantita !== null)) quantita = String(rep.quantita);
      } catch {}
      const colli = getColliDaReportSync(folderPath, '');

      // Ns DDT uscita opzionale
      const uscita = findUscitaOptional(materialiPath, codiceVisivo);
      const nsDdt = uscita?.numeroT || '';
      const dataNsDdt = uscita?.dataT || '';

      // date operative (trasporto/ritiro): se non c'è T -> OGGI
      const dataTrasportoRitiro = uscita?.dataT || dataDocIT;

      // file di destinazione (con numero corrente)
      const nomeFile = `DDT_${numeroPuro}W_${codiceVisivo}_${dataFileDash}.pdf`;
      const outPath  = path.join(materialiPath, nomeFile);

      // se esiste già proprio questo file, non avanzare
      if (fs.existsSync(outPath)) {
        return {
          ok: true,
          path: outPath,
          fileName: nomeFile,
          numeroDoc,
          dataDocIT,
          codiceVisivo,
          materialiPath,
          note: 'DDT W già presente (stesso numero): evitata duplicazione'
        };
      }

      // compila PDF (form se presente)
      const pdfBytes = fs.readFileSync(masterPDF);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      try {
        const form = pdfDoc.getForm();
        const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);

        const fields = form.getFields();
        for (const f of fields) {
          const name = f.getName();
          const lname = String(name).toLowerCase();
          try {
            if (lname.includes('numero documento')) { form.getTextField(name).setText(numeroDoc); continue; }
            if (lname.includes('data documento'))   { form.getTextField(name).setText(dataDocIT); continue; }

            if (name === 'Descrizione') {
              const tf = form.getTextField(name);

              // una sola riga: niente multiline
              tf.disableMultiline?.();

              // calcolo larghezza utile del campo (widget rect)
              const widget = tf.acroField.getWidgets()[0];
              let fieldWidth = 220; // fallback
              try {
                const r = widget.getRectangle ? widget.getRectangle() : widget.getRect?.();
                fieldWidth = Array.isArray(r) ? Math.abs(r[2] - r[0]) : (r?.width ?? fieldWidth);
              } catch {}
              const maxWidth = fieldWidth - 4; // piccolo margine

              const testo = descrizione;
              let size = 14;
              const minSize = 5;
              while (size > minSize && helv.widthOfTextAtSize(testo, size) > maxWidth) {
                size -= 0.5;
              }

              tf.setText(testo);
              tf.setFontSize?.(size);
              continue;
            }

            if (name === 'qta')     { form.getTextField(name).setText(String(quantita ?? '')); continue; }
            if (name === 'colli')   { form.getTextField(name).setText(String(colli ?? '')); continue; }
            if (name === 'Ns DDT')  { form.getTextField(name).setText(nsDdt); continue; }
            if (name === 'del')     { form.getTextField(name).setText(dataNsDdt); continue; }
            if (name === 'Testo8')  { form.getTextField(name).setText(dataTrasportoRitiro); continue; }
            if (name === 'Testo9')  { form.getTextField(name).setText(dataTrasportoRitiro); continue; }
            if (lname.includes('trasporto')) { form.getTextField(name).setText(dataTrasportoRitiro); continue; }
            if (lname.includes('ritiro'))    { form.getTextField(name).setText(dataTrasportoRitiro); continue; }
          } catch {}
        }

        try { form.updateFieldAppearances(helv); } catch {}
      } catch {} // PDF senza form: va bene, salviamo copia


      // ── SCRITTURA ATOMICA + AVANZO SOLO SE SCRITTO
      const outBytes = await pdfDoc.save();
      try {
        const fd = fs.openSync(outPath, 'wx'); // fallisce se qualcuno l'ha appena creato
        try { fs.writeFileSync(fd, outBytes); }
        finally { try { fs.closeSync(fd); } catch {} }
      } catch (err) {
        if (err && err.code === 'EEXIST') {
          // file creato da un’altra chiamata nel frattempo → non avanzare
          return {
            ok: true,
            path: outPath,
            fileName: nomeFile,
            numeroDoc,
            dataDocIT,
            codiceVisivo,
            materialiPath,
            note: 'DDT W già presente: creazione concorrente rilevata'
          };
        }
        console.warn('[generaBollaEntrata] errore scrittura atomica:', err?.message || String(err));
        return { ok:false, error: err?.message || String(err) };
      }

      // Avanza il progressivo SOLO ora che il file è stato scritto
      if (advance) saveBolleEntrata(progressivoCorrente + 1);

      return {
        ok: true,
        path: outPath,
        fileName: nomeFile,
        numeroDoc,
        dataDocIT,
        codiceVisivo,
        materialiPath
      };
    } finally {
      // Rilascio lock per la cartella
      try { if (lockFd !== null) fs.closeSync(lockFd); } catch {}
      try { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch {}
    }

  } catch (e) {
    return { ok:false, error: e?.message || String(e) };
  }
}

// ============================================================
// FUNZIONE UNICA: crea DDT ENTRATA + aggiorna Excel (manuale/auto)
// ============================================================

function _oggiStrSlash() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
}
function _readJsonSafe(fp) {
  try {
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, "utf8");
      return raw ? JSON.parse(raw) : {};
    }
  } catch {}
  return {};
}
function _getColliDaReport(folderPath) {
  const report = _readJsonSafe(path.join(folderPath, "report.json"));
  return report?.colli ?? "";
}

/**
 * Crea bolla entrata (PDF) e aggiorna Excel se configurato.
 * Usa SEMPRE la stessa logica per manuale e automatico.
 */
async function creaBollaEntrataConExcel(folderPath, advance = true, opts = {}) {
  try {
    const r = await generaBollaEntrata({ folderPath, advance });
    if (!r || !r.ok) return r || { ok: false, msg: "generaBollaEntrata ha restituito esito negativo" };

    // Aggiorna Excel se impostato (salta se il PDF era già presente)
    try {
      // Se la generazione ha segnalato duplicazione, non rigenerare l'Excel
      if (r && typeof r.note === 'string' && r.note.toLowerCase().includes('ddt w già presente')) {
        console.log('[creaBollaEntrataConExcel] skip Excel: DDT W già presente.');
      } else {
        const settings = _readJsonSafe(settingsFilePath);
        const reportDdtPath = settings?.reportDdtPath;
        if (reportDdtPath && fs.existsSync(reportDdtPath)) {
          const datiReport = _readJsonSafe(path.join(folderPath, "report.json"));
          const prezzoVendita = (() => {
            const v = datiReport?.prezzoVendita;
            const n = Number(String(v).replace(",", "."));
            return Number.isFinite(n) ? n : 0;
          })();

          const payload = {
            reportDdtPath,
            datiDdt: {
              dataDdt: _oggiStrSlash(),
              numeroDdt: r.numeroDoc,
              codiceCommessa: r.codiceVisivo || "",
              quantita: (datiReport?.quantita ?? ""),
              colli: getColliDaReportSync(folderPath, ""),
              nsDdt: "",           // lasciamo vuoto se non c’è T
              del: "",
              percorsoPdf: r.materialiPath && r.fileName ? path.join(r.materialiPath, r.fileName) : "",
              folderPath,
              descrizione: `Assembraggio ${path.basename(folderPath)}`,
              nomeCommessa: path.basename(folderPath),
              prezzoVendita,
              ...(opts?.extra || {})
            }
          };

          await fetch("http://127.0.0.1:3001/api/genera-ddt-excel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          }).catch(() => {});
        }
      }
    } catch (errExcel) {
      console.warn("[creaBollaEntrataConExcel] Excel warn:", errExcel?.message || String(errExcel));
    }

    return r;
  } catch (e) {
    return { ok: false, msg: "[creaBollaEntrataConExcel] " + (e?.message || String(e)) };
  }
}


// ───────────────────────────────────────────────────────────────────────────────
// API unica per generare la Bolla di Entrata (manuale/automatica)
// ───────────────────────────────────────────────────────────────────────────────
app.post('/api/genera-bolla-entrata', async (req, res) => {
  try {
    const { folderPath, advance = true, extra } = req.body || {};
    if (!folderPath || !fs.existsSync(folderPath)) {
      return res.status(400).json({ ok:false, error: 'folderPath non valido' });
    }
    const r = await creaBollaEntrataConExcel(folderPath, advance, { source: 'manual', extra });
    if (!r?.ok) return res.status(500).json({ ok:false, error: r?.error || r?.msg || 'Errore generazione PDF' });
    res.json({ ok:true, ...r });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
});






// ───────────────────────────────────────────────────────────────────────────────
// Gestione commesse
// ───────────────────────────────────────────────────────────────────────────────

// Anti-doppio trigger per la generazione automatica della W
const AUTO_W_DEBOUNCE_MS = 15000; // 15s: regola a piacere
const autoWRecent = new Map();    // key = folderPath normalizzato -> timestamp ultimo trigger

function shouldTriggerAutoW(folderPath) {
  try {
    const key = path.resolve(String(folderPath || ''));
    const now = Date.now();
    const last = autoWRecent.get(key) || 0;
    if (now - last < AUTO_W_DEBOUNCE_MS) {
      console.log('[auto-bolla-entrata] debounce: trigger ravvicinato ignorato per', key);
      return false;
    }
    autoWRecent.set(key, now);
    return true;
  } catch (e) {
    // in caso di problemi imprevisti, meglio non bloccare il flusso
    return true;
  }
}

let ultimoHashCommesse = null;
let percorsoCartellaMonitorata = null;
let monitorInterval = null;

const startMonitoring = () => {
  if (monitorInterval === null && percorsoCartellaMonitorata) {
    monitorInterval = setInterval(() => {
      const hashPrima = ultimoHashCommesse;
      refreshCommesseJSON(percorsoCartellaMonitorata);
      if (ultimoHashCommesse !== hashPrima) notifyClients();
    }, 30000);
    console.log('Monitoraggio avviato.');
  }
};
const stopMonitoring = () => { if (monitorInterval !== null) { clearInterval(monitorInterval); monitorInterval = null; } };

app.post('/api/monitor-folder', (req, res) => {
  const { percorsoCartella } = req.body;
  if (!percorsoCartella) return res.status(400).json({ message: 'Percorso cartella non specificato.' });
  if (!fs.existsSync(percorsoCartella)) return res.status(404).json({ message: 'Cartella non trovata.' });
  percorsoCartellaMonitorata = percorsoCartella;
  startMonitoring();
  monitorFile(path.join(percorsoCartella, 'commesse.json'));
  res.status(200).json({ message: 'Monitoraggio avviato con successo.' });
});

app.get('/api/commesse', (req, res) => {
  const { percorsoCartella } = req.query;
  if (!percorsoCartella) return res.status(400).json({ message: 'Percorso cartella non specificato.' });

  const jsonFilePath = path.join(percorsoCartella, 'commesse.json');
  if (!fs.existsSync(jsonFilePath)) fs.writeFileSync(jsonFilePath, JSON.stringify([], null, 2));

  try {
    const rawData = fs.readFileSync(jsonFilePath, 'utf8');
    let commesse = rawData.trim() ? JSON.parse(rawData) : [];

    // dedup per chiave "cartella"
    const uniqueMap = new Map();
    commesse.forEach(c => {
      const key = `${(c.brand||'').trim()}_${(c.nomeProdotto||'').trim()}_${(c.codiceProgetto||'').trim()}_${(c.codiceCommessa||'').trim()}`;
      if (!uniqueMap.has(key)) uniqueMap.set(key, c); else uniqueMap.get(key).presente = uniqueMap.get(key).presente || c.presente;
    });
    commesse = Array.from(uniqueMap.values());

    // rispecchia cartelle presenti
    const entries = fs.readdirSync(percorsoCartella, { withFileTypes: true });
    const pattern = /^([^_]+)_([^_]+)_([^_]+)_([^_]+)$/;
    const cartellePresenti = entries.filter(e => e.isDirectory() && pattern.test(e.name)).map(e => e.name.trim());

    cartellePresenti.forEach(cartella => {
      const m = pattern.exec(cartella);
      if (!m) return;
      const [_, brandVal, nomeProdottoVal, codiceProgettoVal, codiceCommessaVal] = m;
      const uniqueKey = `${brandVal}_${nomeProdottoVal}_${codiceProgettoVal}_${codiceCommessaVal}`;
      const found = commesse.find(c =>
        `${(c.brand||'').trim()}_${(c.nomeProdotto||'').trim()}_${(c.codiceProgetto||'').trim()}_${(c.codiceCommessa||'').trim()}` === uniqueKey
      );
      if (found) found.presente = true;
      else commesse.push({
        nome: cartella,
        cliente: '',
        brand: brandVal,
        nomeProdotto: nomeProdottoVal,
        quantita: 0,
        codiceProgetto: codiceProgettoVal,
        codiceCommessa: codiceCommessaVal,
        dataConsegna: '',
        presente: true,
        percorso: path.join(percorsoCartella, cartella)
      });
    });

    // merge archiviata/presente
    const finalMap = new Map();
    commesse.forEach(c => {
      c.archiviata = (c.archiviata === true || c.archiviata === 'true');
      const key = `${(c.brand||'').trim()}_${(c.nomeProdotto||'').trim()}_${(c.codiceProgetto||'').trim()}_${(c.codiceCommessa||'').trim()}`;
      if (!finalMap.has(key)) finalMap.set(key, c);
      else {
        const ex = finalMap.get(key);
        ex.archiviata = ex.archiviata || c.archiviata;
        ex.presente = ex.presente || c.presente;
      }
    });
    commesse = Array.from(finalMap.values());

    fs.writeFileSync(jsonFilePath, JSON.stringify(commesse, null, 2));
    res.status(200).json({ commesse });
  } catch (error) {
    console.error('❌ Errore nel recupero delle commesse:', error);
    res.status(500).json({ message: 'Errore nel recupero delle commesse.' });
  }
});

app.get('/api/commessa-dettagli', (req, res) => {
  const { percorsoCartella, commessaNome } = req.query;
  if (!percorsoCartella || !commessaNome) return res.status(400).json({ message: 'Parametri mancanti.' });
  const jsonFilePath = path.join(percorsoCartella, 'commesse.json');
  if (!fs.existsSync(jsonFilePath)) return res.status(404).json({ message: 'File JSON non trovato.' });
  try {
    const commesse = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8') || '[]');
    const commessa = commesse.find(c => `${c.brand}_${c.nomeProdotto}_${c.codiceProgetto}_${c.codiceCommessa}` === commessaNome);
    if (!commessa) return res.status(404).json({ message: 'Commessa non trovata.' });
    res.status(200).json(commessa);
  } catch (error) {
    res.status(500).json({ message: 'Errore nel recupero dei dettagli della commessa.' });
  }
});

/**
 * Clona ricorsivamente la cartella sorgente.
 * - Copia tutto (sottocartelle e file)
 * - Se incontra una cartella chiamata "MATERIALI" (case-insensitive),
 *   la crea SOLTANTO VUOTA (non copia i contenuti).
 */
const copyDirectory = (source, destination) => {
  try {
    if (!fs.existsSync(destination)) fs.mkdirSync(destination, { recursive: true });
    const entries = fs.readdirSync(source);

    for (const entry of entries) {
      const src = path.join(source, entry);
      const dst = path.join(destination, entry);
      const stat = fs.statSync(src);

      // NON copiare mai la cartella "MATERIALI" (creala vuota)
      if (stat.isDirectory() && entry.toLowerCase() === 'materiali') {
        if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
        continue;
      }

      // ⛔ NON copiare mai "report.pdf" (ovunque si trovi)
      if (!stat.isDirectory() && entry.toLowerCase() === 'report.pdf') {
        continue;
      }

      if (stat.isDirectory()) {
        copyDirectory(src, dst);
      } else {
        fs.copyFileSync(src, dst);
      }
    }
  } catch (error) {
    console.error(`❌ Errore nella clonazione ${source}:`, error);
  }
};

app.post('/api/genera-commessa', (req, res) => {
  const {
    cliente,
    brand,
    nomeProdotto,
    quantita,
    codiceProgetto,
    codiceCommessa,
    dataConsegna,
    percorsoCartella,
    cartellaDaClonare,
    duplicaDa,
    selectedCalendarData
  } = req.body || {};

  // ✅ Nuova validazione: obbligatori Cliente, Brand, Nome Prodotto, e ALMENO uno tra P/C
  if (!cliente || !brand || !nomeProdotto || (!codiceProgetto && !codiceCommessa) || !percorsoCartella) {
    return res.status(400).json({ message: 'Compila Cliente, Brand, Nome Prodotto e almeno uno tra Codice Progetto o Codice Commessa.' });
  }

  // Se non duplichi da una commessa, serve un template
  if (!duplicaDa && !cartellaDaClonare) {
    return res.status(400).json({ message: 'Manca la sorgente: duplicaDa oppure cartellaDaClonare.' });
  }

  // Normalizza: aggiunge P/C se mancano; se uno è assente, genera un segnaposto univoco
  const ensureCode = (val, letter) => {
    const v = String(val || '').trim().toUpperCase();
    if (!v) return `${letter}${Date.now().toString().slice(-4)}`; // es. P1234/C1234
    return v.startsWith(letter) ? v : (letter + v);
  };
  const effP = ensureCode(codiceProgetto, 'P');
  const effC = ensureCode(codiceCommessa, 'C');

  const quantitaFinale = quantita || 0;
  const dataConsegnaFinale = dataConsegna || '';
  const folderName = `${brand}_${nomeProdotto}_${effP}_${effC}`;
  const folderPath = path.join(percorsoCartella, folderName);

  // Blocca se già esiste
  if (fs.existsSync(folderPath)) {
    return res.status(409).json({
      message: 'La cartella di destinazione esiste già. Scegli un altro codice progetto/commessa.',
      folderPath
    });
  }

  // Sorgente copia
  let sourceDir = duplicaDa
    ? (path.isAbsolute(duplicaDa) ? duplicaDa : path.join(percorsoCartella, duplicaDa))
    : cartellaDaClonare;

  if (!sourceDir || !fs.existsSync(sourceDir)) {
    return res.status(404).json({ message: 'Cartella sorgente non trovata.', sourceDir });
  }

  // Regola: se DUPLICO da una COMMESSA (duplicaDa) pretendo nome ..._P..._C...
  // Se invece sto usando un TEMPLATE generico (cartellaDaClonare), NON forzo il pattern.
  try {
    const baseName = path.basename(sourceDir);
    const parts = baseName.split('_');
    const hasPC =
      parts.length >= 4 &&
      /^P[A-Za-z0-9\-]*$/i.test(parts[2]) &&
      /^C[A-Za-z0-9\-]*$/i.test(parts[3]);

    if (duplicaDa && !hasPC) {
      return res.status(400).json({
        message: "La cartella selezionata per 'Duplica da commessa' deve chiamarsi 'BRAND_PRODOTTO_Pxxx_Cyyy'.",
        sorgente: baseName
      });
    }
    // Per cartellaDaClonare (template) va bene anche senza P/C
  } catch (e) {
    // Non bloccare se fallisce la validazione del nome sorgente: gestiamo sopra i casi veri
  }

  try {
    fs.mkdirSync(folderPath, { recursive: true });
    copyDirectory(sourceDir, folderPath); // (già aggiornata per NON copiare MATERIALI e report.pdf)
  } catch (error) {
    return res.status(500).json({ message: 'Errore nella creazione/clonazione della cartella.', error: String(error) });
  }

  // Aggiorna commesse.json con i codici effettivi (inclusi eventuali segnaposto)
  const jsonFilePath = path.join(percorsoCartella, 'commesse.json');
  let commesseData = [];
  if (fs.existsSync(jsonFilePath)) {
    try { const raw = fs.readFileSync(jsonFilePath, 'utf8'); if (raw.trim()) commesseData = JSON.parse(raw); } catch {}
  }

  const nuovaCommessa = {
    nome: folderName,
    cliente,
    brand,
    nomeProdotto,
    quantita: quantitaFinale,
    codiceProgetto: effP,
    codiceCommessa: effC,
    dataConsegna: dataConsegnaFinale,
    percorso: folderPath
  };

  const uniqueKey = `${brand}_${nomeProdotto}_${effP}_${effC}`;
  const existingIdx = commesseData.findIndex(c =>
    `${(c.brand||'').trim()}_${(c.nomeProdotto||'').trim()}_${(c.codiceProgetto||'').trim()}_${(c.codiceCommessa||'').trim()}` === uniqueKey
  );
  if (existingIdx >= 0) commesseData[existingIdx] = { ...commesseData[existingIdx], ...nuovaCommessa };
  else commesseData.push(nuovaCommessa);

  try { fs.writeFileSync(jsonFilePath, JSON.stringify(commesseData, null, 2)); } 
  catch (error) { return res.status(500).json({ message: 'Errore nel salvataggio della commessa.', error: error.toString() }); }

  // report.json
  const report = {
    cliente, brand, nomeProdotto,
    quantita: quantitaFinale,
    codiceProgetto: effP,
    codiceCommessa: effC,
    dataConsegna: dataConsegnaFinale,
    selectedCalendarData
  };
  try { fs.writeFileSync(path.join(folderPath, 'report.json'), JSON.stringify(report, null, 2)); } catch {}

  return res.status(200).json({
    message: `Cartella ${folderName} creata con successo (origine: ${duplicaDa ? 'duplicaDa' : 'cartellaDaClonare'})!`,
    folderPath
  });
});

app.post('/api/modifica-commessa', (req, res) => {
  const { cartellaDaClonare, nomeOriginale, nuovaCommessa, percorsoCartella } = req.body;
  if (!cartellaDaClonare || !nomeOriginale || !nuovaCommessa || !percorsoCartella) return res.status(400).json({ message: 'Dati mancanti per la modifica.' });

  const jsonFilePath = path.join(percorsoCartella, 'commesse.json');
  if (!fs.existsSync(jsonFilePath)) return res.status(404).json({ message: 'File commesse non trovato.' });

  try {
    let commesse = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
    const index = commesse.findIndex(c => `${c.brand}_${c.nomeProdotto}_${c.codiceProgetto}_${c.codiceCommessa}` === nomeOriginale);
    if (index === -1) return res.status(404).json({ message: 'Commessa non trovata.' });

    const oldFolderPath = commesse[index].percorso;
    const newFolderName = `${nuovaCommessa.brand}_${nuovaCommessa.nomeProdotto}_${nuovaCommessa.codiceProgetto}_${nuovaCommessa.codiceCommessa}`;
    const newFolderPath = path.join(path.dirname(oldFolderPath), newFolderName);

    if (fs.existsSync(oldFolderPath)) fs.renameSync(oldFolderPath, newFolderPath);

    const reportFileOld = path.join(oldFolderPath, 'report.json');
    const reportFileNew = path.join(newFolderPath, 'report.json');

    let reportData = {};
    if (fs.existsSync(reportFileOld)) { try { reportData = JSON.parse(fs.readFileSync(reportFileOld, 'utf8')); } catch {} }
    reportData = {
      ...reportData,
      cliente: nuovaCommessa.cliente || reportData.cliente || '',
      brand: nuovaCommessa.brand || reportData.brand || '',
      nomeProdotto: nuovaCommessa.nomeProdotto || reportData.nomeProdotto || '',
      quantita: nuovaCommessa.quantita || reportData.quantita || 0,
      codiceProgetto: nuovaCommessa.codiceProgetto || reportData.codiceProgetto || '',
      codiceCommessa: nuovaCommessa.codiceCommessa || reportData.codiceCommessa || '',
      dataConsegna: nuovaCommessa.dataConsegna || reportData.dataConsegna || ''
    };
    try { fs.writeFileSync(reportFileNew, JSON.stringify(reportData, null, 2)); } catch {}

    commesse[index] = { ...commesse[index], ...nuovaCommessa, percorso: newFolderPath };

    try {
      const nuovoContenuto = JSON.stringify(commesse, null, 2);
      let vecchio = ''; if (fs.existsSync(jsonFilePath)) try { vecchio = fs.readFileSync(jsonFilePath, 'utf8'); } catch {}
      if (nuovoContenuto !== vecchio) fs.writeFileSync(jsonFilePath, nuovoContenuto);
    } catch (error) {
      return res.status(500).json({ message: 'Errore nel salvataggio della commessa.', error: error.toString() });
    }

    res.status(200).json({ message: 'Commessa aggiornata con successo.', commessa: commesse[index] });
    setTimeout(() => notifyClients(), 500);
    setTimeout(() => notifyClients(), 1000);
  } catch (error) {
    res.status(500).json({ message: 'Errore nel salvataggio della commessa.', error: error.toString() });
  }
});

app.post('/api/rinomina-cartella', (req, res) => {
  const { cartellaDaClonare, nomeVecchio, nomeNuovo } = req.body;
  if (!cartellaDaClonare || !nomeVecchio || !nomeNuovo) return res.status(400).json({ message: 'Dati mancanti per la rinomina.' });
  const vecchioPercorso = path.join(cartellaDaClonare, nomeVecchio);
  const nuovoPercorso = path.join(cartellaDaClonare, nomeNuovo);
  if (!fs.existsSync(vecchioPercorso)) return res.status(404).json({ message: 'Cartella originale non trovata.' });
  try { fs.renameSync(vecchioPercorso, nuovoPercorso); res.status(200).json({ message: 'Cartella rinominata con successo.' }); }
  catch (error) { res.status(500).json({ message: 'Errore nella rinomina della cartella.' }); }
});

app.delete('/api/cancella-commessa/:percorsoCartella/:commessaNome', (req, res) => {
  const { percorsoCartella, commessaNome } = req.params;
  if (!percorsoCartella || !commessaNome) return res.status(400).json({ message: 'Parametri mancanti per la cancellazione.' });
  const jsonFilePath = path.join(percorsoCartella, 'commesse.json');
  if (!fs.existsSync(jsonFilePath)) return res.status(404).json({ message: 'File commesse non trovato.' });

  let commesse;
  try { commesse = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8') || '[]'); } catch { return res.status(500).json({ message: 'Errore nella lettura del file JSON.' }); }
  const index = commesse.findIndex(c => c.nome === commessaNome);
  if (index === -1) return res.status(404).json({ message: 'Commessa non trovata.' });

  const folderPath = commesse[index].percorso;
  try { fs.rmSync(folderPath, { recursive: true, force: true }); } catch (error) { return res.status(500).json({ message: 'Errore cancellando la cartella.', error: error.toString() }); }
  commesse.splice(index, 1);
  try { fs.writeFileSync(jsonFilePath, JSON.stringify(commesse, null, 2)); }
  catch (error) { return res.status(500).json({ message: 'Errore aggiornando il file JSON.', error: error.toString() }); }
  res.status(200).json({ message: 'Commessa cancellata con successo.' });
});

// report.json get/set
app.get('/api/report', (req, res) => {
  const { folderPath } = req.query;
  if (!folderPath) return res.status(400).json({ message: 'Il parametro folderPath è obbligatorio.' });
  const reportFilePath = path.join(folderPath, 'report.json');
  if (!fs.existsSync(reportFilePath)) { try { fs.writeFileSync(reportFilePath, JSON.stringify({}, null, 2)); } catch (e) { return res.status(500).json({ message: 'Errore nella creazione del file report.json.' }); } }
  try { const reportData = JSON.parse(fs.readFileSync(reportFilePath, 'utf8') || '{}'); return res.status(200).json({ report: reportData }); }
  catch { return res.status(500).json({ message: 'Errore nella lettura del file report.json.' }); }
});

app.post('/api/report', (req, res) => {
  const { folderPath, reportData } = req.body;
  if (!folderPath || !reportData) return res.status(400).json({ message: 'I parametri folderPath e reportData sono obbligatori.' });

  const reportFilePath = path.join(folderPath, 'report.json');

  try {
    let existing = {};
    if (fs.existsSync(reportFilePath)) {
      const raw = fs.readFileSync(reportFilePath, 'utf8');
      existing = raw ? JSON.parse(raw) : {};
    }

    const merged = { ...existing, ...reportData };

    const nuovo = JSON.stringify(merged, null, 2);
    let vecchio = '';
    if (fs.existsSync(reportFilePath)) {
      try { vecchio = fs.readFileSync(reportFilePath, 'utf8'); } catch {}
    }
    if (nuovo !== vecchio) fs.writeFileSync(reportFilePath, nuovo);

    const parentFolder = path.dirname(folderPath);
    refreshCommesseJSON(parentFolder);
    notifyClients();

    // ── Trigger: se archiviata passa da false -> true, genera la W automaticamente (con debounce)
    try {
      const prima = existing?.archiviata === true || existing?.archiviata === 'true';
      const dopo  = merged?.archiviata === true   || merged?.archiviata === 'true';

      if (!prima && dopo) {
        if (shouldTriggerAutoW(folderPath)) {
          setTimeout(async () => {
            const r = await creaBollaEntrataConExcel(folderPath, true, { source: 'auto' });
            if (!r?.ok) {
              console.warn('[auto-bolla-entrata] errore:', r?.error || r?.msg);
              return;
            }
            console.log('[auto-bolla-entrata] creata:', r.fileName);
          }, 0);
        } else {
          console.log('[auto-bolla-entrata] debounce: generazione auto W già in corso o appena eseguita per', folderPath);
        }
      }
    } catch (e) {
      console.warn('[auto-bolla-entrata] warning:', e?.message || String(e));
    }

    res.status(200).json({ message: 'Report aggiornato con successo.' });
  } catch (error) {
    res.status(500).json({ message: "Errore nell'aggiornamento del file report.json.", error: error.toString() });
  }
});

// Mantieni commesse.json allineato alle cartelle + report.json
function refreshCommesseJSON(percorsoCartella) {
  const jsonFilePath = path.join(percorsoCartella, 'commesse.json');
  let jsonData = [];
  if (fs.existsSync(jsonFilePath)) {
    try { const rawData = fs.readFileSync(jsonFilePath, 'utf8'); jsonData = rawData.trim() ? JSON.parse(rawData) : []; }
    catch (e) { console.error('❌ Errore nella lettura del file JSON:', e); }
  }
  const entries = fs.readdirSync(percorsoCartella, { withFileTypes: true });
  const pattern = /^([^_]+)_([^_]+)_([^_]+)_([^_]+)$/;
  const cartellePresenti = entries.filter(e => e.isDirectory() && pattern.test(e.name)).map(e => e.name.trim());

  const mapping = {}; jsonData.forEach(r => { mapping[r.nome] = r; });

  const nuovoArray = cartellePresenti.map(cartella => {
    let commessa = mapping[cartella] ? { ...mapping[cartella] } : {
      nome: cartella, cliente: '', brand: '', nomeProdotto: '', quantita: 0,
      codiceProgetto: '', codiceCommessa: '', dataConsegna: '', presente: true,
      percorso: path.join(percorsoCartella, cartella)
    };
    if (!commessa.brand || !commessa.nomeProdotto || !commessa.codiceProgetto || !commessa.codiceCommessa) {
      const m = pattern.exec(cartella);
      if (m) { commessa.brand = m[1]; commessa.nomeProdotto = m[2]; commessa.codiceProgetto = m[3]; commessa.codiceCommessa = m[4]; }
    }
    commessa.percorso = path.join(percorsoCartella, cartella);
    commessa.presente = true;

    const reportPath = path.join(percorsoCartella, cartella, 'report.json');
    if (fs.existsSync(reportPath)) {
      try {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8') || '{}');
        commessa.inizioProduzione = report.inizioProduzione || '';
        commessa.archiviata = report.archiviata === true || report.archiviata === 'true' || false;
        commessa.fineProduzioneEffettiva = report.fineProduzioneEffettiva || null;
      } catch (e) { console.error(`Errore nella lettura di report.json in ${cartella}:`, e); }
    } else {
      commessa.archiviata = !!commessa.archiviata;
    }
    return commessa;
  });

  try {
    const nuovoJson = JSON.stringify(nuovoArray, null, 2);
    const nuovoHash = crypto.createHash('md5').update(nuovoJson).digest('hex');
    if (nuovoHash === ultimoHashCommesse) return;
    ultimoHashCommesse = nuovoHash;
    fs.writeFileSync(jsonFilePath, nuovoJson);
  } catch (e) { console.error('❌ Errore nell’aggiornamento del file JSON:', e); }
}

function monitorFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  fs.watchFile(filePath, { interval: 1000 }, () => { notifyClients(); });
}

function notifyClients() {
  if (!percorsoCartellaMonitorata) return;
  const jsonFilePath = path.join(percorsoCartellaMonitorata, 'commesse.json');
  if (!fs.existsSync(jsonFilePath)) return;
  try {
    const commesse = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8') || '[]');
    const commesseConStato = commesse.map(c => ({ ...c, nome: c.nome || `${c.brand}_${c.nomeProdotto}_${c.codiceProgetto}_${c.codiceCommessa}` }));
    wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(commesseConStato)); });
  } catch (e) { console.error('❌ Errore nella lettura del file JSON:', e); }
}

// Check report.json nelle cartelle all’avvio (se impostato percorsoCartella)
function checkAllReportFiles() {
  if (!fs.existsSync(settingsFilePath)) return;
  let settingsData;
  try { settingsData = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8')); } catch { return; }
  const baseFolder = settingsData.percorsoCartella;
  if (!baseFolder || !fs.existsSync(baseFolder)) return;
  const entries = fs.readdirSync(baseFolder, { withFileTypes: true });
  entries.forEach(entry => {
    if (!entry.isDirectory()) return;
    const folderPath = path.join(baseFolder, entry.name);
    const reportFilePath = path.join(folderPath, 'report.json');
    if (!fs.existsSync(reportFilePath)) { try { fs.writeFileSync(reportFilePath, JSON.stringify({}, null, 2)); } catch {} }
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// Impostazioni generali app
// ───────────────────────────────────────────────────────────────────────────────
app.post('/api/save-settings', (req, res) => {
  const {
    percorsoCartella, cartellaDaClonare,
    emailDestinatariApertura, emailDestinatariLavorazione,
    emailOggetto, emailContenuto,
    masterBolleUscita, masterBolleEntrata,
    reportDdtPath
  } = req.body;

  const settingsData = {
    percorsoCartella, cartellaDaClonare,
    emailDestinatariApertura, emailDestinatariLavorazione,
    emailOggetto, emailContenuto,
    masterBolleUscita, masterBolleEntrata,
    reportDdtPath
  };

  try {
    fs.writeFileSync(settingsFilePath, JSON.stringify(settingsData, null, 2));
    console.log('✅ Impostazioni salvate in', settingsFilePath);
    res.json({ message: 'Impostazioni salvate con successo.' });
  } catch (err) {
    res.status(500).json({ message: 'Errore nel salvataggio delle impostazioni.', error: err.toString() });
  }
});

app.get('/api/leggi-impostazioni', (req, res) => {
  if (!fs.existsSync(settingsFilePath)) return res.status(404).json({ message: 'File delle impostazioni non trovato.' });
  try { const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8') || '{}'); return res.status(200).json({ settings }); }
  catch (error) { return res.status(500).json({ message: 'Errore nella lettura delle impostazioni.', error: error.toString() }); }
});

// restituisce master PDF (uscita/entrata)
app.get('/api/master-bolla', (req, res) => {
  const tipo = req.query.tipo;
  if (!tipo || (tipo !== 'uscita' && tipo !== 'entrata')) return res.status(400).send('Tipo non valido. Usa ?tipo=uscita oppure ?tipo=entrata');
  if (!fs.existsSync(settingsFilePath)) return res.status(404).send('Impostazioni non trovate');
  const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
  const pathPDF = tipo === 'uscita' ? settings.masterBolleUscita : settings.masterBolleEntrata;
  if (!pathPDF || !fs.existsSync(pathPDF)) return res.status(404).send('File master PDF non trovato o non impostato');
  res.sendFile(path.resolve(pathPDF));
});

// ───────────────────────────────────────────────────────────────────────────────
// Stampanti – report generale
// ───────────────────────────────────────────────────────────────────────────────
app.get('/api/stampanti-parsed', (req, res) => {
  const parsedPath = path.join(__dirname, 'data', 'stampanti_parsed.json');
  if (!fs.existsSync(parsedPath)) return res.status(404).json({ message: 'Nessun file parsato ancora.' });
  const data = fs.readFileSync(parsedPath, 'utf8');
  res.json(JSON.parse(data));
});

app.get('/api/stampanti/settings', (req, res) => {
  const settingsPath = path.join(__dirname, 'data', 'stampantiSettings.json');
  try {
    let data = {};
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf8').trim();
      data = raw ? JSON.parse(raw) : {};
    }
    if (!Array.isArray(data.printers)) data.printers = [];
    if (typeof data.monitorJsonPath !== 'string') data.monitorJsonPath = '';
    if (typeof data.reportGeneralePath !== 'string') data.reportGeneralePath = '';
    if (typeof data.storicoConsumiUrl !== 'string') data.storicoConsumiUrl = '';
    res.json(data);
  } catch {
    res.status(500).json({ error: 'Impossibile leggere le impostazioni' });
  }
});

app.post('/api/stampanti/settings', (req, res) => {
  const settingsDir = path.join(__dirname, 'data');
  if (!fs.existsSync(settingsDir)) fs.mkdirSync(settingsDir, { recursive: true });

  const filePath = path.join(settingsDir, 'stampantiSettings.json');

  // leggi esistenti per merge non distruttivo
  let current = {};
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8').trim();
      current = raw ? JSON.parse(raw) : {};
    }
  } catch {}

  const {
    printers,
    monitorJsonPath,
    reportGeneralePath,
    storicoConsumiUrl
  } = req.body || {};

  const next = {
    ...current,
    printers: Array.isArray(printers) ? printers : (current.printers || []),
    monitorJsonPath: typeof monitorJsonPath === 'string' ? monitorJsonPath : (current.monitorJsonPath || ''),
    reportGeneralePath: typeof reportGeneralePath === 'string' ? reportGeneralePath : (current.reportGeneralePath || ''),
    storicoConsumiUrl: typeof storicoConsumiUrl === 'string' ? storicoConsumiUrl : (current.storicoConsumiUrl || '')
  };

  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
  res.json({ ok: true });
});

app.get('/api/stampanti/latest-csv', (req, res) => {
  const folder = req.query.folder;
  if (!folder) return res.status(400).json({ error: 'folder missing' });
  try {
    const files = fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith('.csv'));
    if (!files.length) return res.json({ headers: [], rows: [] });
    const latest = files.map(name => ({ name, mtime: fs.statSync(path.join(folder, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0].name;

    const content = fs.readFileSync(path.join(folder, latest), 'utf8').trim();
    const lines = content.split(/\r?\n/);
    if (!lines.length) return res.json({ headers: [], rows: [] });

    const rawHeaders = lines[0].split(';').map(f => f.trim().replace(/^"|"$/g, ''));
    const rawRows = lines.slice(1).map(line => line.split(';').map(f => f.trim().replace(/^"|"$/g, '')));
    res.json({ headers: rawHeaders, rows: rawRows });
  } catch (err) { res.status(500).json({ error: err.toString() }); }
});

// storico settimanale
app.get('/api/storico-settimana', (req, res) => {
  const settingsPath = path.join(__dirname, 'data', 'stampantiSettings.json');
  let reportGeneralePath = path.join(__dirname, 'data');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      reportGeneralePath = settings.reportGeneralePath || reportGeneralePath;
    } catch {}
  }

  let week = parseInt(req.query.week), year = parseInt(req.query.year);
  const now = new Date();
  const getWeekNumber = (d) => { d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1)); return Math.ceil((((d - yearStart) / 86400000) + 1)/7); };
  if (!week) week = getWeekNumber(now);
  if (!year) year = now.getFullYear();

  // nuova nomenclatura
  const fileNew = path.join(reportGeneralePath, `Reportgenerali_Arizona_${week}_${year}.json`);
  // fallback legacy (solo lettura se presente)
  const fileOld = path.join(reportGeneralePath, `Reportgenerali_Stampanti_${week}_${year}.json`);

  const file = fs.existsSync(fileNew) ? fileNew : (fs.existsSync(fileOld) ? fileOld : null);
  if (!file) return res.json([]);

  try {
    return res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return res.json([]);
  }
});

// serve file dalla cartella reportGeneralePath
app.get('/report_generale/:nomefile', (req, res) => {
  const settingsPath = path.join(__dirname, 'data', 'stampantiSettings.json');
  if (!fs.existsSync(settingsPath)) return res.status(404).send('Impostazioni non trovate');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const reportGeneralePath = settings.reportGeneralePath;
    if (!reportGeneralePath || !fs.existsSync(reportGeneralePath)) return res.status(404).send('Cartella REPORT GENERALE non trovata!');
    const filePath = path.join(reportGeneralePath, req.params.nomefile);
    if (!fs.existsSync(filePath)) return res.status(404).send('File non trovato');
    res.sendFile(filePath);
  } catch { return res.status(500).send('Errore interno nel recupero del file'); }
});

// rigenera settimanale manuale
app.post('/api/rigenera-report-settimanale', async (req, res) => {
  try {
    const now = new Date();
    const getISOWeek = (date) => { const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return Math.ceil((((d - yearStart) / 86400000) + 1) / 7); };
    const getISOWeekYear = (date) => { const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); return d.getUTCFullYear(); };
    const week = Number(req.query.week ?? req.body?.week ?? getISOWeek(now));
    const year = Number(req.query.year ?? req.body?.year ?? getISOWeekYear(now));
    await rigeneraSettimana(week, year);
    res.json({ ok: true, week, year, message: `Reportgenerali_Stampanti_${week}_${year}.json rigenerato` });
  } catch (e) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
});


// elenco settimanali disponibili
app.get('/api/settimanali-disponibili', (req, res) => {
  const settingsPath = path.join(__dirname, 'data', 'stampantiSettings.json');
  let reportGeneralePath = path.join(__dirname, 'data');
  if (fs.existsSync(settingsPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (s.reportGeneralePath) reportGeneralePath = s.reportGeneralePath;
    } catch {}
  }

  // elenca SOLO i nuovi file unificati; se non ce ne sono, tenta il legacy per retrocompatibilità
  let files = fs.readdirSync(reportGeneralePath).filter(f => /^Reportgenerali_Arizona_(\d+)_(\d+)\.json$/.test(f));
  if (!files.length) {
    files = fs.readdirSync(reportGeneralePath).filter(f => /^Reportgenerali_Stampanti_(\d+)_(\d+)\.json$/.test(f));
  }

  const weeks = files.map(f => {
    const m = f.match(/_(\d+)_(\d+)\.json$/);
    return m ? { week: Number(m[1]), year: Number(m[2]), filename: f } : null;
  }).filter(Boolean).sort((a, b) => b.year - a.year || b.week - a.week);

  res.json(weeks);
});

// ───────────────────────────────────────────────────────────────────────────────
// PROTEK – settings + CSV grezzi
// ───────────────────────────────────────────────────────────────────────────────
app.post('/api/protek/settings', (req, res) => {
  const { monitorPath, pantografi, storicoConsumiUrl } = req.body;
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const protekSettingsFile = path.join(dataDir, 'Proteksetting.json');

  // normalizza pantografi a array
  const pantografiArr = Array.isArray(pantografi) ? pantografi : [];
  const storicoClean = typeof storicoConsumiUrl === 'string' ? storicoConsumiUrl.replace(/"/g, '').trim() : '';

  try {
    const toSave = { monitorPath, pantografi: pantografiArr, storicoConsumiUrl: storicoClean };
    fs.writeFileSync(protekSettingsFile, JSON.stringify(toSave, null, 2), 'utf8');
    // 👉 ora il backend fa eco dei valori salvati
    return res.json({ ok: true, monitorPath, pantografi: pantografiArr, storicoConsumiUrl: storicoClean });
  } catch (err) {
    return res.status(500).json({ error: err.toString() });
  }
});

app.get('/api/protek/settings', (req, res) => {
  const file = path.join(__dirname, 'data', 'Proteksetting.json');
  if (!fs.existsSync(file)) return res.json({ monitorPath: '', pantografi: [], storicoConsumiUrl: '' });
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    res.json({
      monitorPath: data.monitorPath || '',
      pantografi: Array.isArray(data.pantografi) ? data.pantografi : [],
      storicoConsumiUrl: typeof data.storicoConsumiUrl === 'string' ? data.storicoConsumiUrl.replace(/\"/g, '').trim() : ''
    });
  } catch { res.json({ monitorPath: '', pantografi: [], storicoConsumiUrl: '' }); }
});

function readProtekSettings() {
  const file = path.join(__dirname, 'data', 'Proteksetting.json');
 if (!fs.existsSync(file)) return { monitorPath: '', pantografi: [], storicoConsumiUrl: '' };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      monitorPath: data.monitorPath || '',
      pantografi: Array.isArray(data.pantografi) ? data.pantografi : [],
      storicoConsumiUrl: typeof data.storicoConsumiUrl === 'string' ? data.storicoConsumiUrl.replace(/\"/g, '').trim() : ''
    };
  } catch {
    return { monitorPath: '', pantografi: [], storicoConsumiUrl: '' };
  }
}
function detectDelimiter(firstLine) { const sc = (firstLine.match(/;/g) || []).length; const cc = (firstLine.match(/,/g) || []).length; return sc >= cc ? ';' : ','; }
function csvToObjects(csvText) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim() !== ''); if (!lines.length) return [];
  const delimiter = detectDelimiter(lines[0]);
  const headers = lines[0].split(delimiter).map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const cols = line.split(delimiter).map(c => c.trim().replace(/^"|"$/g, ''));
    const obj = {}; headers.forEach((h, i) => { obj[h || `col_${i}`] = cols[i] ?? ''; }); return obj;
  });
}
function loadCSVFrom(folder, filename) {
  const full = path.join(folder, filename);
  if (!fs.existsSync(full)) return [];
  try { const raw = fs.readFileSync(full, 'utf8'); return csvToObjects(raw); } catch (e) { console.error(`[PROTEK] Errore leggendo ${filename}:`, e.toString()); return []; }
}

app.get('/api/protek/csv', (req, res) => {
  const { monitorPath } = readProtekSettings();
  if (!monitorPath || !fs.existsSync(monitorPath)) return res.status(404).json({ error: 'Percorso di monitoraggio Protek non impostato o non esistente.' });

  const files = {
    JOBS: 'JOBS.csv',
    JOB_ORDERS: 'JOB_ORDERS.csv',
    PART_PROGRAMS: 'PART_PROGRAMS.csv',
    PART_SUB_PROGRAMS: 'PART_SUB_PROGRAMS.csv',
    PART_PROGRAM_WORKINGS: 'PART_PROGRAM_WORKINGS.csv',
    PART_PROGRAM_WORKING_LINES: 'PART_PROGRAM_WORKING_LINES.csv',
    NESTINGS_ORDERS: 'NESTINGS_ORDERS.csv',
    NESTING_OCCURENCES: 'NESTING_OCCURENCES.csv',
    LIFECYCLE: 'LIFECYCLE.csv'
  };

  const payload = {};
  for (const [key, filename] of Object.entries(files)) payload[key] = loadCSVFrom(monitorPath, filename);
  payload.__meta = { monitorPath, loadedAt: new Date().toISOString() };
  res.json(payload);
});

// === PROTEK: lettura CSV passando il percorso direttamente dal client ==========
app.post('/api/protek/csv-direct', (req, res) => {
  const monitorPath = (req.body?.monitorPath || req.query?.monitorPath || '').trim();
  if (!monitorPath || !fs.existsSync(monitorPath)) {
    return res.status(404).json({ error: 'Percorso CSV non valido o non raggiungibile.' });
  }
  const files = {
    JOBS: 'JOBS.csv',
    JOB_ORDERS: 'JOB_ORDERS.csv',
    PART_PROGRAMS: 'PART_PROGRAMS.csv',
    PART_SUB_PROGRAMS: 'PART_SUB_PROGRAMS.csv',
    PART_PROGRAM_WORKINGS: 'PART_PROGRAM_WORKINGS.csv',
    PART_PROGRAM_WORKING_LINES: 'PART_PROGRAM_WORKING_LINES.csv',
    NESTINGS_ORDERS: 'NESTINGS_ORDERS.csv',
    NESTING_OCCURENCES: 'NESTING_OCCURENCES.csv',
    LIFECYCLE: 'LIFECYCLE.csv'
  };
  const payload = {};
  for (const [key, filename] of Object.entries(files)) {
    payload[key] = loadCSVFrom(monitorPath, filename);
  }
  payload.__meta = { monitorPath, loadedAt: new Date().toISOString() };
  res.json(payload);
});

// === PROTEK: diagnostica percorso (esistenza, permessi, file attesi) ===========
app.post('/api/protek/diagnose-path', (req, res) => {
  const monitorPath = (req.body?.monitorPath || '').trim();
  if (!monitorPath) {
    return res.status(400).json({ ok: false, error: 'monitorPath mancante' });
  }

  const expected = [
    'JOBS.csv',
    'JOB_ORDERS.csv',
    'PART_PROGRAMS.csv',
    'PART_SUB_PROGRAMS.csv',
    'PART_PROGRAM_WORKINGS.csv',
    'PART_PROGRAM_WORKING_LINES.csv',
    'NESTINGS_ORDERS.csv',
    'NESTING_OCCURENCES.csv',
    'LIFECYCLE.csv'
  ];

  const result = {
    ok: false,
    monitorPath,
    existsPath: false,
    canRead: false,
    files: {},       // { filename: { exists, size } }
    readableCount: 0,
    missing: []
  };

  try {
    // 1) esistenza cartella
    if (!fs.existsSync(monitorPath)) {
      result.existsPath = false;
      return res.status(404).json({ ...result, error: 'Percorso inesistente o non raggiungibile dal server.' });
    }
    result.existsPath = true;

    // 2) lettura directory (permessi)
    try {
      fs.readdirSync(monitorPath);
      result.canRead = true;
    } catch (e) {
      result.canRead = false;
      return res.status(403).json({ ...result, error: 'Accesso negato alla cartella (permessi).' });
    }

    // 3) file attesi
    let count = 0;
    for (const fname of expected) {
      const fp = path.join(monitorPath, fname);
      const exists = fs.existsSync(fp);
      let size = null;
      if (exists) {
        try { size = fs.statSync(fp).size; } catch {}
        count++;
      } else {
        result.missing.push(fname);
      }
      result.files[fname] = { exists, size };
    }
    result.readableCount = count;

    // ok se almeno un CSV atteso è presente
    result.ok = count > 0;
    return res.json(result);

  } catch (e) {
    return res.status(500).json({ ...result, error: e?.message || String(e) });
  }
});

// === PROTEK: vista unificata JOBS passando il percorso direttamente dal client ==
app.post('/api/protek/jobs-direct', (req, res) => {
  const monitorPath = (req.body?.monitorPath || req.query?.monitorPath || '').trim();
  if (!monitorPath || !fs.existsSync(monitorPath)) {
    return res.status(404).json({ error: 'Percorso CSV non valido o non raggiungibile.' });
  }
  const JOBS               = loadCSVFrom(monitorPath, 'JOBS.csv');
  const JOB_ORDERS         = loadCSVFrom(monitorPath, 'JOB_ORDERS.csv');
  const NESTINGS_ORDERS    = loadCSVFrom(monitorPath, 'NESTINGS_ORDERS.csv');
  const LIFECYCLE          = loadCSVFrom(monitorPath, 'LIFECYCLE.csv');

  const ordersByJobId = new Map();
  JOB_ORDERS.forEach(o => {
    const k = String(o.JOB_ID);
    if (!ordersByJobId.has(k)) ordersByJobId.set(k, []);
    ordersByJobId.get(k).push(o);
  });

  const nestingsByOrderId = new Map();
  NESTINGS_ORDERS.forEach(n => {
    const k = String(n.JOB_ORDER_ID);
    if (!nestingsByOrderId.has(k)) nestingsByOrderId.set(k, []);
    nestingsByOrderId.get(k).push(n);
  });

  function latestByEntity(type) {
    const map = new Map();
    LIFECYCLE
      .filter(r => String(r.ENTITY_TYPE).toUpperCase() === String(type).toUpperCase())
      .forEach(r => {
        const id = String(r.ENTITY_ID);
        const ts = new Date(r.TIMESTAMP || r.timestamp || 0).getTime();
        const prev = map.get(id);
        if (!prev || ts > new Date(prev.TIMESTAMP || prev.timestamp || 0).getTime()) {
          map.set(id, r);
        }
      });
    return map;
  }
  const lastJobLifecycle      = latestByEntity('JOB');
  const lastJobOrderLifecycle = latestByEntity('JOB_ORDER');

  const toInt = v => (v === undefined || v === null || v === '' || isNaN(Number(v))) ? 0 : parseInt(v, 10);

  const out = JOBS.map(job => {
    const jobId   = String(job.ID);
    const ords = (ordersByJobId.get(jobId) || []).map(o => {
      const orderId = String(o.ID);
      const qty     = toInt(o.QTY);
      const nestings = (nestingsByOrderId.get(orderId) || []);
      const pieces  = nestings.reduce((acc, n) => acc + toInt(n.PIECES || n.PIECE_COUNT), 0);
      const lc      = lastJobOrderLifecycle.get(orderId);
      return {
        id: orderId,
        code: o.ORDER_CODE || o.CODE || '',
        qtyOrdered: qty,
        piecesFromNestings: pieces,
        latestState: lc ? (lc.STATE || lc.STATUS || '') : ''
      };
    });
    const jobLc = lastJobLifecycle.get(jobId);
    return {
      id: jobId,
      code: job.CODE || '',
      description: job.DESCRIPTION || '',
      customer: job.CUSTOMER || '',
      latestState: jobLc ? (jobLc.STATE || jobLc.STATUS || '') : '',
      totals: {
        qtyOrdered: ords.reduce((a, o) => a + o.qtyOrdered, 0),
        piecesFromNestings: ords.reduce((a, o) => a + o.piecesFromNestings, 0)
      },
      orders: ords
    };
  });

  res.json({ jobs: out, meta: { monitorPath, generatedAt: new Date().toISOString() } });
});

// === PROTEK: endpoint unificato /api/protek/jobs ===============================
app.get('/api/protek/jobs', (req, res) => {
  const { monitorPath } = readProtekSettings();
  if (!monitorPath || !fs.existsSync(monitorPath)) {
    return res.status(404).json({ error: 'Percorso di monitoraggio Protek non impostato o non esistente.' });
  }

  const JOBS                  = loadCSVFrom(monitorPath, 'JOBS.csv');
  const JOB_ORDERS            = loadCSVFrom(monitorPath, 'JOB_ORDERS.csv');
  const PART_PROGRAMS         = loadCSVFrom(monitorPath, 'PART_PROGRAMS.csv');
  const NESTINGS_ORDERS       = loadCSVFrom(monitorPath, 'NESTINGS_ORDERS.csv');
  const NESTING_OCCURENCES    = loadCSVFrom(monitorPath, 'NESTING_OCCURENCES.csv');
  const LIFECYCLE             = loadCSVFrom(monitorPath, 'LIFECYCLE.csv');

  const jobById = new Map(JOBS.map(j => [String(j.ID), j]));
  const ordersByJobId = new Map();
  JOB_ORDERS.forEach(o => {
    const k = String(o.JOB_ID);
    if (!ordersByJobId.has(k)) ordersByJobId.set(k, []);
    ordersByJobId.get(k).push(o);
  });

  function latestByEntity(type) {
    const map = new Map();
    LIFECYCLE
      .filter(r => String(r.ENTITY_TYPE).toUpperCase() === String(type).toUpperCase())
      .forEach(r => {
        const id = String(r.ENTITY_ID);
        const ts = new Date(r.TIMESTAMP || r.timestamp || 0).getTime();
        const prev = map.get(id);
        if (!prev || ts > new Date(prev.TIMESTAMP || prev.timestamp || 0).getTime()) {
          map.set(id, r);
        }
      });
    return map;
  }
  const lastJobLifecycle      = latestByEntity('JOB');
  const lastJobOrderLifecycle = latestByEntity('JOB_ORDER');

  const nestingsByOrderId = new Map();
  NESTINGS_ORDERS.forEach(n => {
    const k = String(n.JOB_ORDER_ID);
    if (!nestingsByOrderId.has(k)) nestingsByOrderId.set(k, []);
    nestingsByOrderId.get(k).push(n);
  });

  const toInt = v => (v === undefined || v === null || v === '' || isNaN(Number(v))) ? 0 : parseInt(v, 10);

  const out = JOBS.map(job => {
    const jobId   = String(job.ID);
    const jobCode = job.CODE || '';
    const jobDesc = job.DESCRIPTION || '';
    const customer= job.CUSTOMER || '';

    const ords = (ordersByJobId.get(jobId) || []).map(o => {
      const orderId   = String(o.ID);
      const orderCode = o.ORDER_CODE || o.CODE || '';
      const qty       = toInt(o.QTY);

      const nestings  = (nestingsByOrderId.get(orderId) || []);
      const piecesFromNestings = nestings.reduce((acc, n) => acc + toInt(n.PIECES || n.PIECE_COUNT), 0);

      const lc = lastJobOrderLifecycle.get(orderId);
      const orderState = lc ? (lc.STATE || lc.STATUS || '') : '';

      return {
        id: orderId,
        code: orderCode,
        qtyOrdered: qty,
        piecesFromNestings,
        latestState: orderState
      };
    });

    const jobLc = lastJobLifecycle.get(jobId);
    const jobState = jobLc ? (jobLc.STATE || jobLc.STATUS || '') : '';

    const qtyOrderedTot = ords.reduce((a, o) => a + toInt(o.qtyOrdered), 0);
    const piecesTot     = ords.reduce((a, o) => a + toInt(o.piecesFromNestings), 0);

    return {
      id: jobId,
      code: jobCode,
      description: jobDesc,
      customer,
      latestState: jobState,
      totals: {
        qtyOrdered: qtyOrderedTot,
        piecesFromNestings: piecesTot
      },
      orders: ords
    };
  });

  res.json({ jobs: out, meta: { monitorPath, generatedAt: new Date().toISOString() } });
});


// === PROTEK: riepilogo PROGRAMMI arricchito (operatori, macchine, ordini, pezzi, allarmi, tempi) ===
app.get('/api/protek/programs', (req, res) => {
  const { monitorPath } = readProtekSettings();
  if (!monitorPath || !fs.existsSync(monitorPath)) {
    return res.status(404).json({ error: 'Percorso di monitoraggio Protek non impostato o non esistente.' });
  }

  // CSV necessari
  const PART_PROGRAMS               = loadCSVFrom(monitorPath, 'PART_PROGRAMS.csv');
  const PART_PROGRAM_WORKINGS       = loadCSVFrom(monitorPath, 'PART_PROGRAM_WORKINGS.csv');
  const PART_PROGRAM_WORKING_LINES  = loadCSVFrom(monitorPath, 'PART_PROGRAM_WORKING_LINES.csv');
  const USERS                       = loadCSVFrom(monitorPath, 'USERS.csv');
  const WORK_CONFIGURATIONS         = loadCSVFrom(monitorPath, 'WORK_CONFIGURATIONS.csv');
  const JOB_ORDERS                  = loadCSVFrom(monitorPath, 'JOB_ORDERS.csv');
  const JOBS                        = loadCSVFrom(monitorPath, 'JOBS.csv');
  const CUSTOMERS                   = loadCSVFrom(monitorPath, 'CUSTOMERS.csv');
  const NESTINGS_ORDERS             = loadCSVFrom(monitorPath, 'NESTINGS_ORDERS.csv');
  const ALARMS                      = loadCSVFrom(monitorPath, 'ALARMS.csv');

  // Util
  const toNum = (v) => {
    if (v === undefined || v === null || v === '') return 0;
    const s = String(v).replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  };
  const parseTs = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const truthy = (v) => {
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 't';
  };

  // Mappe di supporto
  const userNameById = new Map(USERS.map(u => [String(u.ID), (u.USERNAME || u.NAME || u.LOGIN || '').trim()]));
  const cfgNameById  = new Map(WORK_CONFIGURATIONS.map(c => [String(c.ID), (c.NAME || c.CODE || '').trim()]));
  const jobById      = new Map(JOBS.map(j => [String(j.ID), j]));
  const custNameById = new Map(CUSTOMERS.map(c => [String(c.ID || c.CUSTOMER_ID || c.Code), (c.NAME || c.DESCRIPTION || c.CODE || '').trim()]));

  const orderById    = new Map(JOB_ORDERS.map(o => [String(o.ID), o]));
  const jobIdByOrder = new Map(JOB_ORDERS.map(o => [String(o.ID), String(o.JOB_ID)]));

  // Nesting: pezzi per ordine
  const piecesByOrderId = new Map();
  for (const no of NESTINGS_ORDERS) {
    const oid = String(no.JOB_ORDER_ID);
    const pieces = toNum(no.PIECES || no.PIECE_COUNT || no.PIECE || no.PZ);
    piecesByOrderId.set(oid, (piecesByOrderId.get(oid) || 0) + pieces);
  }

  // Lines: tempo macchina per WORKING
  const machineSecondsByWorkingId = new Map();
  for (const line of PART_PROGRAM_WORKING_LINES) {
    const wid = String(line.PART_PROGRAM_WORKING_ID || line.PROGRAM_WORKING_ID || line.WORKING_ID || line.ID_WORKING || '');
    if (!wid) continue;
    const sec = toNum(line.TIME || line.MACHINE_TIME || line.DURATION || 0);
    machineSecondsByWorkingId.set(wid, (machineSecondsByWorkingId.get(wid) || 0) + sec);
  }

  // Allarmi per WORKING
  const alarmsByWorkingId = new Map();
  for (const a of ALARMS) {
    const wid = String(a.PROGRAM_WORKING_ID || a.WORKING_ID || a.PART_PROGRAM_WORKING_ID || '');
    if (!wid) continue;
    alarmsByWorkingId.set(wid, (alarmsByWorkingId.get(wid) || 0) + 1);
  }

  // Raggruppo workings per programma
  const workingsByProgram = new Map();
  for (const w of PART_PROGRAM_WORKINGS) {
    const pid = String(w.PART_PROGRAM_ID);
    if (!workingsByProgram.has(pid)) workingsByProgram.set(pid, []);
    workingsByProgram.get(pid).push(w);
  }

  // Costruisco output
  const programs = PART_PROGRAMS.map(pp => {
    const pid   = String(pp.ID);
    const code  = pp.CODE || '';
    const desc  = pp.DESCRIPTION || pp.NAME || '';
    const path  = pp.PATH || '';

    const workings = workingsByProgram.get(pid) || [];
    const numWorkings = workings.length;

    // operatori/macchine
    const operatorIds = new Set();
    const cfgIds      = new Set();
    const orderIds    = new Set();

    let minStart = null, maxEnd = null;
    let anyEnded = false, anyCompleted = false, anyStarted = false, anyLoaded = false;

    // aggregazioni per workings
    let machineSeconds = 0;
    let alarmsCount = 0;

    for (const w of workings) {
      if (w.USER_ID) operatorIds.add(String(w.USER_ID));
      if (w.WORK_CONFIGURATION_ID) cfgIds.add(String(w.WORK_CONFIGURATION_ID));
      if (w.JOB_ORDER_ID) orderIds.add(String(w.JOB_ORDER_ID));

      const dLoaded    = parseTs(w.DATE_LOADED || w.LOADED_DATE);
      const dStarted   = parseTs(w.DATE_STARTED || w.START_DATE);
      const dCompleted = parseTs(w.DATE_COMPLETED || w.END_DATE || w.COMPLETED_DATE);
      const dLast      = parseTs(w.LAST_DATE);

      if (dLoaded)   anyLoaded = true;
      if (truthy(w.STARTED) || dStarted)   anyStarted = true;
      if (truthy(w.COMPLETED) || dCompleted) anyCompleted = true;
      if (truthy(w.ENDED)) anyEnded = true;

      if (dStarted) {
        if (!minStart || dStarted < minStart) minStart = dStarted;
      } else if (dLoaded) {
        if (!minStart || dLoaded < minStart) minStart = dLoaded;
      }

      const endCand = dCompleted || dLast || null;
      if (endCand) {
        if (!maxEnd || endCand > maxEnd) maxEnd = endCand;
      }

      const wid = String(w.ID || w.PART_PROGRAM_WORKING_ID || '');
      if (wid) {
        machineSeconds += machineSecondsByWorkingId.get(wid) || 0;
        alarmsCount    += alarmsByWorkingId.get(wid) || 0;
      }
    }

    // stato “derivato”
    let latestState = '';
    if (anyEnded) latestState = 'ENDED';
    else if (anyCompleted) latestState = 'FINISHED';
    else if (anyStarted) latestState = 'RUNNING';
    else if (anyLoaded) latestState = 'QUEUED';
    else latestState = '';

    // cliente: via primo ordine -> job -> customer
    let customer = '';
    const firstOrderId = orderIds.values().next().value;
    if (firstOrderId) {
      const jobId = jobIdByOrder.get(String(firstOrderId));
      const job   = jobId ? jobById.get(String(jobId)) : null;
      if (job) {
        // prova sia stringa “CUSTOMER” sia CUSTOMERS.ID
        customer = (job.CUSTOMER || '').trim();
        if (!customer && (job.CUSTOMER_ID || job.CUSTOMERCODE || job.CUSTOMER_CODE)) {
          const cid = String(job.CUSTOMER_ID || job.CUSTOMERCODE || job.CUSTOMER_CODE);
          customer = custNameById.get(cid) || '';
        }
      }
    }

    // qty ordinate + pezzi nesting su tutti gli ordini collegati
    let ordersCount = orderIds.size;
    let qtyOrdered  = 0;
    let piecesFromNestings = 0;
    for (const oid of orderIds) {
      const o = orderById.get(String(oid));
      if (o) qtyOrdered += toNum(o.QTY);
      piecesFromNestings += toNum(piecesByOrderId.get(String(oid)));
    }

    const creationDate = parseTs(pp.CREATION_DATE || pp.creation_date);
    const startTime = (minStart || creationDate) ? (minStart || creationDate).toISOString() : '';
    const endTime   = maxEnd ? maxEnd.toISOString() : '';

    // durata “visuale” come fallback se non abbiamo machineSeconds
    let durationSeconds = 0;
    if (machineSeconds > 0) {
      durationSeconds = Math.floor(machineSeconds);
    } else if (minStart && maxEnd) {
      durationSeconds = Math.max(0, Math.floor((maxEnd - minStart) / 1000));
    }

    const operators = [...operatorIds].map(id => userNameById.get(id) || id).filter(Boolean).join(', ');
    const machines  = [...cfgIds].map(id => cfgNameById.get(id) || id).filter(Boolean).join(', ');

    return {
      id: pid,
      code,
      description: desc,
      path,

      customer,
      latestState,

      startTime,
      endTime,
      durationSeconds,      // sec
      machineSeconds,       // sec (da working_lines se presente)

      numWorkings,
      operators,
      machines,

      ordersCount,
      qtyOrdered,
      piecesFromNestings,

      alarmsCount
    };
  });

  res.json({ programs, meta: { monitorPath, generatedAt: new Date().toISOString() } });
});

// ───────────────────────────────────────────────────────────────────────────────
// WebSocket
// ───────────────────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('🟢 WebSocket CONNESSO!');
  startMonitoring();

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'auth') {
        if (!data.email || typeof data.email !== 'string' || data.email.trim() === '') return;
        ws.email = data.email;
        if (!activeUsers.find(u => u && typeof u.email === 'string' && u.email.toLowerCase() === data.email.toLowerCase())) {
          activeUsers.push({ email: data.email, lastPing: Date.now() }); notifyActiveUsers();
        }
      }
    } catch (err) {
      console.error('Errore nel parsing del messaggio WebSocket:', err);
    }
  });

  ws.on('close', () => {
    if (ws.email) {
      activeUsers = activeUsers.filter(u => u.email.toLowerCase() !== ws.email.toLowerCase());
      notifyActiveUsers();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Avvio
// ───────────────────────────────────────────────────────────────────────────────
checkAllReportFiles();

app.get('/api/loggedUsers', (req, res) => { res.json(activeUsers); });

server.listen(3001, '0.0.0.0', () => {
  console.log('🚀 Server in ascolto su http://192.168.1.250:3001');
});
startMultiPrinterScheduler();    