#!/usr/bin/env node
/**
 * Teambition → MySQL sync (generic)
 *
 * Pulls the current tasks from a fixed Teambition view via a logged-in
 * Chrome CDP session and mirrors them into a MySQL demand-pool table.
 *
 * Config precedence:
 *   1. --config <path> CLI flag
 *   2. TB_SYNC_CONFIG env var
 *   3. ./config/tb_sync.config.json (relative to CWD)
 *   4. ~/.config/teambition-demand-sync/config.json
 *
 * See config/tb_sync.example.json for the full schema.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const mysql = require('mysql2/promise');
const WebSocket = require('ws');

/* -------------------------- config loading -------------------------- */

function parseCliArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' && argv[i + 1]) { out.config = argv[++i]; continue; }
    if (a.startsWith('--config=')) { out.config = a.slice('--config='.length); continue; }
    if (a === '--help' || a === '-h') { out.help = true; }
  }
  return out;
}

function resolveConfigPath(cli) {
  const candidates = [
    cli.config,
    process.env.TB_SYNC_CONFIG,
    path.resolve(process.cwd(), 'config/tb_sync.config.json'),
    path.resolve(process.cwd(), 'tb_sync.config.json'),
    path.join(os.homedir(), '.config/teambition-demand-sync/config.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadConfig() {
  const cli = parseCliArgs(process.argv);
  if (cli.help) {
    printHelp();
    process.exit(0);
  }
  const configPath = resolveConfigPath(cli);
  if (!configPath) {
    console.error('[tb-sync] no config file found; copy config/tb_sync.example.json and edit it, or set TB_SYNC_CONFIG');
    process.exit(2);
  }
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    console.error(`[tb-sync] failed to read config ${configPath}: ${e.message}`);
    process.exit(2);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    console.error(`[tb-sync] config JSON parse error at ${configPath}: ${e.message}`);
    process.exit(2);
  }
  validateConfig(cfg, configPath);
  cfg.__path = configPath;
  return cfg;
}

function validateConfig(cfg, sourcePath) {
  const errors = [];
  if (!cfg.teambition || typeof cfg.teambition !== 'object') errors.push('teambition {} missing');
  if (!cfg.database || typeof cfg.database !== 'object') errors.push('database {} missing');
  if (!cfg.cdp || typeof cfg.cdp !== 'object') errors.push('cdp {} missing');

  const tb = cfg.teambition || {};
  if (!tb.projectId) errors.push('teambition.projectId missing');
  if (!tb.viewId) errors.push('teambition.viewId missing');
  if (!tb.host) errors.push('teambition.host missing (e.g. tb.raycloud.com)');
  if (tb.filter && typeof tb.filter !== 'string') errors.push('teambition.filter must be a string');

  const cf = tb.customFields || {};
  if (typeof cf !== 'object') errors.push('teambition.customFields must be an object');

  const db = cfg.database || {};
  ['host', 'user', 'database'].forEach(k => {
    if (!db[k]) errors.push(`database.${k} missing`);
  });

  if (errors.length) {
    console.error(`[tb-sync] invalid config at ${sourcePath}:`);
    errors.forEach(e => console.error('  - ' + e));
    process.exit(2);
  }
}

function printHelp() {
  console.log(`Teambition → MySQL sync

Usage:
  node tb_sync.js [--config path]

Options:
  --config PATH    Path to config JSON. Default lookup order:
                     $TB_SYNC_CONFIG,
                     ./config/tb_sync.config.json,
                     ./tb_sync.config.json,
                     ~/.config/teambition-demand-sync/config.json

See config/tb_sync.example.json for the schema, and schema/demand.sql for the MySQL tables.`);
}

/* ----------------------------- logging ------------------------------ */

function makeLogger(cfg) {
  const tz = cfg.log?.timezone || 'Asia/Shanghai';
  return function log(msg) {
    const now = new Date().toLocaleString('zh-CN', { timeZone: tz });
    console.log(`[${now}] ${msg}`);
  };
}

/* ---------------------------- HTTP / CDP ---------------------------- */

function httpRequestJSON(url, options = {}) {
  const { timeout = 10000, method = 'GET' } = options;
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.substring(0, 200)}`)); }
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`HTTP timeout: ${url}`)));
    req.on('error', reject);
    req.end();
  });
}

const httpGetJSON = (url, timeout = 10000) => httpRequestJSON(url, { timeout });

async function cdpEval(wsUrl, expression, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP timeout')); }, timeout);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true }
      }));
    });
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === id) {
        clearTimeout(timer);
        ws.close();
        if (msg.result?.exceptionDetails) reject(new Error(`Eval error: ${JSON.stringify(msg.result.exceptionDetails)}`));
        else if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result.result.value);
      }
    });
    ws.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

/* ---------------------------- TB fetching --------------------------- */

function buildFetchExpression(cfg) {
  const tb = cfg.teambition;
  const cf = tb.customFields || {};
  const defaultFilter = `_projectId=${tb.projectId} AND (taskLayer IN (0) OR isTopInProject = true) AND ((updated >= startOf(d)) AND (updated <= endOf(d))) ORDER BY isDone ASC, updated DESC`;
  const filter = tb.filter || defaultFilter;
  const pageSize = Number(tb.pageSize) > 0 ? Number(tb.pageSize) : 200;

  const cfEntries = Object.entries(cf).filter(([, v]) => !!v);
  const cfCode = cfEntries.map(([key, id]) => `      ${JSON.stringify(key)}: pickCf(t, ${JSON.stringify(id)}),`).join('\n');

  return `(async function () {
    const filter = encodeURIComponent(${JSON.stringify(filter)});
    const r = await fetch('/api/v2/projects/${tb.projectId}/tasks?filter=' + filter + '&pageToken=&pageSize=${pageSize}', { headers: { 'Accept':'application/json, text/plain, */*' } });
    const text = await r.text();
    const data = JSON.parse(text);
    function pickCf(task, id) {
      const cf = (task.customfields || []).find(c => c._customfieldId === id);
      if (!cf) return '';
      return (cf.value?.[0]?.title || cf.values?.[0] || '');
    }
    return (data.result || []).map(t => ({
      tb_task_id: t._id,
      title: t.content || '',
      created_at: t.created || '',
      tb_last_updated_at: t.updated || '',
      task_status: t.taskflowstatus?.name || '',
${cfCode}
    }));
  })()`;
}

/* ---------------------- Chrome tab management ----------------------- */

async function ensureTbTab(cfg, log) {
  const port = cfg.cdp.port || 18800;
  const host = cfg.teambition.host;
  const projectUrl = `https://${host}/project/${cfg.teambition.projectId}/tasks/view/${cfg.teambition.viewId}`;

  let targets;
  try {
    targets = await httpGetJSON(`http://127.0.0.1:${port}/json`, 5000);
  } catch (e) {
    targets = [];
  }

  async function createBlankTarget() {
    try {
      return await httpRequestJSON(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', timeout: 5000 });
    } catch (putErr) {
      return await httpRequestJSON(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'GET', timeout: 5000 });
    }
  }

  let tbTarget = targets.find(t => t.type === 'page' && t.url && t.url.includes(host));
  if (tbTarget) return { target: tbTarget, port };

  let blankTarget = targets.find(t => t.type === 'page' && t.url === 'about:blank');
  if (!blankTarget) {
    try { blankTarget = await createBlankTarget(); } catch (_) { blankTarget = null; }
  }

  if (!blankTarget && cfg.cdp.autoLaunchChrome) {
    const { spawn } = require('child_process');
    const bin = cfg.cdp.chromeBinary || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const dataDir = cfg.cdp.userDataDir || path.join(os.homedir(), '.openclaw/browser/openclaw/user-data');
    const child = spawn(bin, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ], { stdio: 'ignore', detached: true });
    child.unref();

    await new Promise(r => setTimeout(r, 3000));
    targets = await httpGetJSON(`http://127.0.0.1:${port}/json`, 5000);
    blankTarget = targets.find(t => t.type === 'page' && t.url === 'about:blank');
    if (!blankTarget) blankTarget = await createBlankTarget();
  }

  if (!blankTarget) {
    throw new Error(`No usable Chrome CDP page target on port ${port}. Make sure Chrome is running with --remote-debugging-port=${port} and you are logged into ${host}.`);
  }

  await cdpEval(blankTarget.webSocketDebuggerUrl,
    `(async()=>{ location.href = ${JSON.stringify(projectUrl)}; return location.href; })()`);
  await new Promise(r => setTimeout(r, 5000));
  targets = await httpGetJSON(`http://127.0.0.1:${port}/json`, 5000);
  tbTarget = targets.find(t => t.type === 'page' && t.url && t.url.includes(host));
  if (!tbTarget) throw new Error(`Opened ${host} but could not obtain a usable tab; please check login state.`);
  return { target: tbTarget, port };
}

async function closeTab(port, wsUrl, log) {
  if (!wsUrl) return;
  try {
    const match = wsUrl.match(/\/devtools\/page\/([^/]+)$/);
    const targetId = match ? match[1] : null;
    if (!targetId) throw new Error('cannot parse targetId from wsUrl');
    await httpGetJSON(`http://127.0.0.1:${port}/json/close/${targetId}`);
  } catch (e) {
    log(`Close tab warning: ${e.message}`);
  }
}

/* ---------------------------- utilities ----------------------------- */

function toMySQLDate(isoString) {
  if (!isoString) return null;
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function countMerchants(contact, pattern) {
  if (!contact) return 0;
  if (!pattern) return 0;
  const re = new RegExp(pattern, 'g');
  const matches = Array.from(new Set(String(contact).match(re) || []));
  return matches.length;
}

/* ---------------------------- main sync ----------------------------- */

async function main() {
  const cfg = loadConfig();
  const log = makeLogger(cfg);
  const tables = Object.assign({
    demand: 'demand',
    demand_change_log: 'demand_change_log',
    demand_sync_log: 'demand_sync_log',
  }, cfg.database.tables || {});

  log(`Starting Teambition sync (config: ${cfg.__path})`);
  let fetchedCount = 0, insertedCount = 0, updatedCount = 0, errorCount = 0;
  let status = 'success', remark = '';
  let conn;
  let syncTab = null;
  let cdpPort;

  const contactField = cfg.teambition.contactField || 'customer_contact';
  const merchantPattern = cfg.teambition.merchantPhonePattern || '1\\d{10}';

  try {
    const tbSession = await ensureTbTab(cfg, log);
    syncTab = tbSession.target;
    cdpPort = tbSession.port;

    const expression = buildFetchExpression(cfg);
    const tasks = await cdpEval(syncTab.webSocketDebuggerUrl, expression);
    fetchedCount = tasks.length;
    log(`Fetched ${fetchedCount} tasks from target view`);

    conn = await mysql.createConnection({
      host: cfg.database.host,
      port: cfg.database.port,
      user: cfg.database.user,
      password: cfg.database.password,
      database: cfg.database.database,
      charset: cfg.database.charset || 'utf8mb4',
    });
    const now = toMySQLDate(new Date().toISOString());

    const cfKeys = Object.keys(cfg.teambition.customFields || {});
    // Columns tracked for merges/updates
    const trackedColumns = new Set(['task_status', ...cfKeys]);

    for (const t of tasks) {
      try {
        const [rows] = await conn.execute(
          `SELECT id FROM \`${tables.demand}\` WHERE tb_task_id = ?`,
          [t.tb_task_id]
        );

        async function logChange(demandId, tbTaskId, title, fieldName, oldValue, newValue) {
          if ((oldValue || '') === (newValue || '')) return;
          await conn.execute(
            `INSERT INTO \`${tables.demand_change_log}\` (demand_id, tb_task_id, title, field_name, old_value, new_value, source)
             VALUES (?, ?, ?, ?, ?, ?, 'tb_sync')`,
            [demandId, tbTaskId, title, fieldName, oldValue || null, newValue || null]
          );
        }

        const nextMerchantCount = countMerchants(t[contactField] || '', merchantPattern);

        if (rows.length === 0) {
          const cols = ['tb_task_id', 'title', 'created_at', contactField, 'merchant_count', 'task_status', ...cfKeys.filter(k => k !== contactField), 'tb_last_updated_at', 'last_synced_at'];
          const uniqueCols = Array.from(new Set(cols));
          const placeholders = uniqueCols.map(() => '?').join(', ');
          const values = uniqueCols.map(c => {
            if (c === 'tb_task_id') return t.tb_task_id;
            if (c === 'title') return t.title;
            if (c === 'created_at') return toMySQLDate(t.created_at);
            if (c === 'merchant_count') return nextMerchantCount;
            if (c === 'task_status') return t.task_status || null;
            if (c === 'tb_last_updated_at') return toMySQLDate(t.tb_last_updated_at);
            if (c === 'last_synced_at') return now;
            return (t[c] === '' || t[c] === undefined) ? null : t[c];
          });
          await conn.execute(
            `INSERT INTO \`${tables.demand}\` (${uniqueCols.map(c => '`' + c + '`').join(', ')}) VALUES (${placeholders})`,
            values
          );
          insertedCount++;
        } else {
          const selectCols = ['id', 'merchant_count', 'task_status', ...cfKeys];
          const uniqueSelect = Array.from(new Set(selectCols));
          const [detailRows] = await conn.execute(
            `SELECT ${uniqueSelect.map(c => '`' + c + '`').join(', ')} FROM \`${tables.demand}\` WHERE tb_task_id = ? LIMIT 1`,
            [t.tb_task_id]
          );
          const current = detailRows[0] || {};

          const changedFields = [];
          for (const col of trackedColumns) {
            const oldV = current[col] == null ? '' : String(current[col]);
            const newV = t[col] == null ? '' : String(t[col]);
            if (oldV !== newV) changedFields.push({ col, oldV, newV });
          }
          const merchantChanged = Number(nextMerchantCount || 0) !== Number(current.merchant_count || 0);

          if (changedFields.length || merchantChanged) {
            for (const { col, oldV, newV } of changedFields) {
              await logChange(current.id, t.tb_task_id, t.title, col, oldV, newV);
            }

            const setCols = [];
            const setVals = [];
            for (const col of trackedColumns) {
              setCols.push('`' + col + '` = ?');
              setVals.push((t[col] === '' || t[col] === undefined || t[col] === null) ? null : t[col]);
            }
            setCols.push('`merchant_count` = ?'); setVals.push(nextMerchantCount);
            setCols.push('`tb_last_updated_at` = ?'); setVals.push(toMySQLDate(t.tb_last_updated_at));
            setCols.push('`last_synced_at` = ?'); setVals.push(now);
            setVals.push(t.tb_task_id);

            await conn.execute(
              `UPDATE \`${tables.demand}\` SET ${setCols.join(', ')} WHERE tb_task_id = ?`,
              setVals
            );
            updatedCount++;
          } else {
            await conn.execute(
              `UPDATE \`${tables.demand}\` SET tb_last_updated_at = ?, last_synced_at = ? WHERE tb_task_id = ?`,
              [toMySQLDate(t.tb_last_updated_at), now, t.tb_task_id]
            );
          }
        }
      } catch (e) {
        errorCount++;
        log(`Task sync error: ${t.tb_task_id} | ${t.title} | ${e.message}`);
      }
    }
  } catch (e) {
    status = 'failed';
    remark = e.message;
    errorCount++;
    log(`ERROR: ${e.message}`);
  }

  try {
    if (!conn) conn = await mysql.createConnection({
      host: cfg.database.host, port: cfg.database.port,
      user: cfg.database.user, password: cfg.database.password,
      database: cfg.database.database, charset: cfg.database.charset || 'utf8mb4',
    });
    await conn.execute(
      `INSERT INTO \`${tables.demand_sync_log}\` (source_view_id, fetched_count, inserted_count, updated_count, error_count, status, remark)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [cfg.teambition.viewId, fetchedCount, insertedCount, updatedCount, errorCount, status, remark || null]
    );
    await conn.end();
  } catch (e) {
    log(`Log write error: ${e.message}`);
  }

  if (syncTab?.webSocketDebuggerUrl) {
    await closeTab(cdpPort, syncTab.webSocketDebuggerUrl, log);
  }

  log(`Done! fetched=${fetchedCount}, inserted=${insertedCount}, updated=${updatedCount}, errors=${errorCount}, status=${status}`);
  process.exitCode = status === 'success' ? 0 : 1;
}

main();
