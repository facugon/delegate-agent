#!/usr/bin/env node
// delegate.mjs — Orquestador local de agentes en sandbox Docker.
// MVP: Gemini-only, clone-aislado, branch local sin remote, traceability completa.
//
// Este binario es genérico: NO sabe nada del proyecto que lo usa. Toda la
// configuración (repos, imagen Docker, env sandbox) vive en un
// `delegate.config.json` ubicado en la raíz del proyecto target. El binario lo
// descubre subiendo desde el CWD.

import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync,
  existsSync, createWriteStream, statSync, rmSync,
} from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import readline from 'node:readline/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Raíz del propio tool (delegate-agent), para ubicar docker/ y templates/.
const TOOL_ROOT = resolve(__dirname, '..');
const TEMPLATES_DIR = join(TOOL_ROOT, 'templates');
const TOOL_DOCKER_DIR = join(TOOL_ROOT, 'docker');

const CONFIG_FILENAME = 'delegate.config.json';

// Defaults para campos opcionales del config.
const CONFIG_DEFAULTS = {
  dockerImage: 'delegate-agent:latest',
  containerPrefix: 'delegate',
  gitIdentityDomain: 'delegate.local',
  sandboxEnv: '.delegate/sandbox.env',
  jobsDir: '.delegate/jobs',
  repos: { workspace: '.' },
};

const GEMINI_AUTH_FILES = [
  'oauth_creds.json',
  'google_accounts.json',
  'projects.json',
  'settings.json',
  'installation_id',
];

// ---------- config ----------

// Sube desde `start` buscando delegate.config.json. Devuelve el dir que lo contiene.
function findProjectRoot(start = process.cwd()) {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, CONFIG_FILENAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Carga y resuelve la config. Sale con error claro si no la encuentra.
// Devuelve un objeto con todo ya resuelto a paths absolutos.
function loadConfig() {
  const root = findProjectRoot();
  if (!root) {
    console.error(`No encontré ${CONFIG_FILENAME} en este directorio ni en sus padres.`);
    console.error(`Corré "delegate init" en la raíz del proyecto para crearlo.`);
    process.exit(1);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(root, CONFIG_FILENAME), 'utf8'));
  } catch (e) {
    console.error(`No pude parsear ${join(root, CONFIG_FILENAME)}: ${e.message}`);
    process.exit(1);
  }
  const c = { ...CONFIG_DEFAULTS, ...raw };
  const reposRaw = raw.repos || CONFIG_DEFAULTS.repos;
  const repos = {};
  for (const [key, rel] of Object.entries(reposRaw)) {
    repos[key] = resolve(root, rel);
  }
  return {
    projectRoot: root,
    dockerImage: c.dockerImage,
    containerPrefix: c.containerPrefix,
    gitIdentityDomain: c.gitIdentityDomain,
    sandboxEnv: resolve(root, c.sandboxEnv),
    jobsDir: resolve(root, c.jobsDir),
    repos,
  };
}

// ---------- utils ----------

function readMeta(jobDir) {
  return JSON.parse(readFileSync(join(jobDir, 'meta.json'), 'utf8'));
}

function writeMeta(jobDir, meta) {
  writeFileSync(join(jobDir, 'meta.json'), JSON.stringify(meta, null, 2));
}

function listJobIds(jobsDir) {
  if (!existsSync(jobsDir)) return [];
  return readdirSync(jobsDir).filter((d) => {
    try { return statSync(join(jobsDir, d)).isDirectory(); }
    catch { return false; }
  }).sort();
}

function findJobDir(jobsDir, idOrPrefix) {
  const ids = listJobIds(jobsDir);
  const exact = ids.find((id) => id === idOrPrefix);
  if (exact) return join(jobsDir, exact);
  const matches = ids.filter((id) => id.startsWith(idOrPrefix));
  if (matches.length === 1) return join(jobsDir, matches[0]);
  if (matches.length === 0) {
    console.error(`No job matches "${idOrPrefix}".`);
    process.exit(1);
  }
  console.error(`Ambiguous prefix "${idOrPrefix}" matches: ${matches.join(', ')}`);
  process.exit(1);
}

function slug(text, max = 30) {
  return text
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'task';
}

function ymd(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

function hms(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

function generateJobId(prompt) {
  return `${ymd()}-${hms()}-gemini-${slug(prompt)}`;
}

function parseFlags(args) {
  // Devuelve { positional: [...], flags: {...} }
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function fmtDuration(seconds) {
  if (seconds == null) return '-';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m${rs}s`;
}

function fmtTokens(t) {
  if (!t || (!t.input && !t.output)) return '-';
  return `${t.input || 0}↓ ${t.output || 0}↑`;
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

// ---------- init ----------

async function cmdInit(args) {
  const { flags } = parseFlags(args);
  const dest = resolve(flags.dir || process.cwd());

  const configDst = join(dest, CONFIG_FILENAME);
  const sandboxDst = join(dest, '.delegate', 'sandbox.env');

  if (existsSync(configDst) && !flags.force) {
    console.error(`Ya existe ${configDst}. Usá --force para sobrescribir.`);
    process.exit(1);
  }

  mkdirSync(join(dest, '.delegate'), { recursive: true });
  copyFileSync(join(TEMPLATES_DIR, 'delegate.config.json.example'), configDst);
  if (!existsSync(sandboxDst) || flags.force) {
    copyFileSync(join(TEMPLATES_DIR, 'sandbox.env.example'), sandboxDst);
  }

  console.log(`✔ Creado ${CONFIG_FILENAME} y .delegate/sandbox.env en ${dest}`);
  console.log(``);
  console.log(`Próximos pasos:`);
  console.log(`  1) Editá ${CONFIG_FILENAME} — ajustá "repos" y "dockerImage".`);
  console.log(`  2) Editá .delegate/sandbox.env — poné valores FAKE para todo lo que tu código lea.`);
  console.log(`  3) Buildeá la imagen:  delegate build`);
  console.log(`  4) Agregá a tu .gitignore:`);
  console.log(`        .delegate/jobs/`);
  console.log(`        .delegate/sandbox.env`);
  console.log(`  5) Probá:  delegate run gemini "decime hola" --timeout 2`);
}

// ---------- build ----------

async function cmdBuild(args) {
  const { flags } = parseFlags(args);
  // El config es opcional para build: si existe usamos su dockerImage, si no, default.
  let image = CONFIG_DEFAULTS.dockerImage;
  const root = findProjectRoot();
  if (root) {
    try {
      const raw = JSON.parse(readFileSync(join(root, CONFIG_FILENAME), 'utf8'));
      if (raw.dockerImage) image = raw.dockerImage;
    } catch {}
  }
  if (flags.image) image = flags.image;

  console.log(`Building ${image} desde ${TOOL_DOCKER_DIR} ...`);
  const r = spawnSync('docker', ['build', '-t', image, TOOL_DOCKER_DIR],
    { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('Build falló.');
    process.exit(1);
  }
  console.log(`✔ Imagen ${image} lista.`);
}

// ---------- run ----------

async function cmdRun(args) {
  const cfg = loadConfig();
  const jobsDir = cfg.jobsDir;
  const { positional, flags } = parseFlags(args);
  const agent = positional[0];
  if (agent !== 'gemini') {
    console.error(`MVP solo soporta "gemini" (recibido: ${agent}).`);
    process.exit(1);
  }

  let prompt = positional.slice(1).join(' ').trim();
  if (flags['prompt-file']) {
    prompt = readFileSync(flags['prompt-file'], 'utf8').trim();
  }
  if (!prompt) {
    console.error('Prompt requerido (positional o --prompt-file).');
    process.exit(1);
  }

  const repo = flags.repo || 'workspace';
  if (!cfg.repos[repo]) {
    console.error(`Repo inválido: "${repo}". Opciones: ${Object.keys(cfg.repos).join(', ')}`);
    process.exit(1);
  }
  const sourceRepo = cfg.repos[repo];
  if (!existsSync(join(sourceRepo, '.git'))) {
    console.error(`No es un git repo: ${sourceRepo}`);
    process.exit(1);
  }

  if (!existsSync(cfg.sandboxEnv)) {
    console.error(`No existe el env sandbox: ${cfg.sandboxEnv}`);
    console.error(`Crealo (ej: copiando templates/sandbox.env.example) antes de lanzar jobs.`);
    process.exit(1);
  }

  const timeoutMin = parseInt(flags.timeout || '30', 10);
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) {
    console.error('--timeout debe ser un número de minutos > 0');
    process.exit(1);
  }

  const id = generateJobId(prompt);
  const jobDir = join(jobsDir, id);
  mkdirSync(jobDir, { recursive: true });

  // 1) Prompt
  writeFileSync(join(jobDir, 'prompt.md'), prompt + '\n');

  // 2) Clone aislado, sin remote, sin creds heredadas
  const wd = join(jobDir, 'workspace');
  console.log(`[${id}]`);
  console.log(`  Cloning ${repo} (--local --no-hardlinks)...`);
  const cloneRes = spawnSync('git',
    ['clone', '--local', '--no-hardlinks', '--quiet', sourceRepo, wd],
    { stdio: ['ignore', 'inherit', 'inherit'] });
  if (cloneRes.status !== 0) {
    console.error('Clone falló.');
    process.exit(1);
  }

  spawnSync('git', ['-C', wd, 'remote', 'remove', 'origin'], { stdio: 'ignore' });
  spawnSync('git', ['-C', wd, 'config', '--local', 'user.email', `agent-${id}@${cfg.gitIdentityDomain}`]);
  spawnSync('git', ['-C', wd, 'config', '--local', 'user.name', `Agent ${id}`]);
  // No firmar commits (evita pedir gpg dentro del container)
  spawnSync('git', ['-C', wd, 'config', '--local', 'commit.gpgsign', 'false']);

  // Capturar SHA y nombre de la branch base ANTES de crear la del agente,
  // para tener referencia exacta del diff sin depender de master/main
  const baseShaRes = spawnSync('git', ['-C', wd, 'rev-parse', 'HEAD'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const baseSha = baseShaRes.stdout.toString().trim();
  const baseBranchRes = spawnSync('git', ['-C', wd, 'rev-parse', '--abbrev-ref', 'HEAD'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const baseBranch = baseBranchRes.stdout.toString().trim();

  spawnSync('git', ['-C', wd, 'checkout', '-b', `agent/${id}`]);

  // 3) Copiar auth Gemini (no montar el ~/.gemini original)
  const authDir = join(jobDir, '.gemini-auth');
  mkdirSync(authDir, { recursive: true });
  for (const f of GEMINI_AUTH_FILES) {
    const src = join(homedir(), '.gemini', f);
    if (existsSync(src)) copyFileSync(src, join(authDir, f));
  }

  // 4) Meta inicial
  const meta = {
    id,
    agent: 'gemini',
    repo,
    source_repo_path: sourceRepo,
    branch: `agent/${id}`,
    base_branch: baseBranch,
    base_commit: baseSha,
    status: 'pending',
    created_at: new Date().toISOString(),
    started_at: null,
    ended_at: null,
    last_activity_at: null,
    duration_seconds: null,
    timeout_min: timeoutMin,
    monitor_pid: null,
    docker_container: null,
    docker_image: cfg.dockerImage,
    sandbox_env: cfg.sandboxEnv,
    session_id: null,
    model: null,
    exit_code: null,
    tokens: { input: 0, output: 0, cached: 0, total: 0 },
    events: { tool_calls: 0, errors: 0, messages: 0 },
    summary: null,
    prompt_preview: prompt.slice(0, 300),
    has_changes: null,
  };
  writeMeta(jobDir, meta);

  // 5) Spawn monitor detached. Stdout/stderr del monitor a un log para debug.
  const monitorLog = join(jobDir, 'monitor.log');
  const monitorOut = createWriteStream(monitorLog, { flags: 'a' });
  const monitor = spawn(process.execPath, [__filename, '_monitor', id], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: cfg.projectRoot,
  });
  monitor.stdout.pipe(monitorOut);
  monitor.stderr.pipe(monitorOut);
  monitor.unref();

  meta.monitor_pid = monitor.pid;
  writeMeta(jobDir, meta);

  console.log(`  Workspace: ${join(jobDir, 'workspace')}`);
  console.log(`  Branch:    agent/${id} (sin remote, no se va a pushear solo)`);
  console.log(`  Monitor:   PID ${monitor.pid}`);
  console.log(`  Timeout:   ${timeoutMin}m`);
  console.log(``);
  console.log(`Job ${id} lanzado.`);
  console.log(`  delegate list                 # status global`);
  console.log(`  delegate show ${id}    # progreso`);
  console.log(`  delegate review ${id}  # cuando termine`);
}

// ---------- _monitor (interno, detached) ----------

async function cmdMonitor(args) {
  const cfg = loadConfig();
  const id = args[0];
  const jobDir = join(cfg.jobsDir, id);
  if (!existsSync(jobDir)) {
    console.error(`Job dir no existe: ${jobDir}`);
    process.exit(1);
  }

  const meta = readMeta(jobDir);
  meta.status = 'running';
  meta.started_at = new Date().toISOString();
  meta.last_activity_at = meta.started_at;
  writeMeta(jobDir, meta);

  const transcriptPath = join(jobDir, 'transcript.jsonl');
  const transcript = createWriteStream(transcriptPath, { flags: 'a' });
  const stderrLog = createWriteStream(join(jobDir, 'gemini-stderr.log'), { flags: 'a' });

  const wd = join(jobDir, 'workspace');
  const authDir = join(jobDir, '.gemini-auth');
  const containerName = `${cfg.containerPrefix}-${id}`;
  const promptText = readFileSync(join(jobDir, 'prompt.md'), 'utf8');

  const dockerArgs = [
    'run', '--rm',
    '--name', containerName,
    '--network=bridge',
    '--memory=2g',
    '--cpus=2',
    '-v', `${wd}:/workspace`,
    '-v', `${authDir}:/home/node/.gemini`,
    '--env-file', cfg.sandboxEnv,
    '-e', 'GEMINI_CLI_TRUST_WORKSPACE=true',
    '-w', '/workspace',
    '-u', 'node',
    cfg.dockerImage,
    'gemini',
    '--skip-trust',
    '--yolo',
    '--output-format', 'stream-json',
    '-p', promptText,
  ];

  meta.docker_container = containerName;
  writeMeta(jobDir, meta);

  const child = spawn('docker', dockerArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Hard timeout
  const hardTimer = setTimeout(() => {
    console.error(`[${id}] Timeout ${meta.timeout_min}m alcanzado, killing container.`);
    spawnSync('docker', ['kill', containerName], { stdio: 'ignore' });
  }, meta.timeout_min * 60 * 1000);

  // Stderr a su log
  child.stderr.on('data', (chunk) => stderrLog.write(chunk));

  // Stdout: parsear stream-json line by line
  let buffer = '';
  let assistantText = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      transcript.write(line + '\n');
      handleEvent(line);
    }
  });

  function handleEvent(line) {
    let evt;
    try { evt = JSON.parse(line); }
    catch { return; }
    const m = readMeta(jobDir);
    m.last_activity_at = new Date().toISOString();

    if (evt.type === 'init') {
      m.session_id = evt.session_id || null;
      m.model = evt.model || null;
    } else if (evt.type === 'message') {
      m.events.messages = (m.events.messages || 0) + 1;
      if (evt.role === 'assistant' && typeof evt.content === 'string') {
        assistantText += evt.content;
      }
    } else if (evt.type === 'tool_call' || evt.type === 'tool_use') {
      m.events.tool_calls = (m.events.tool_calls || 0) + 1;
    } else if (evt.type === 'error') {
      m.events.errors = (m.events.errors || 0) + 1;
    } else if (evt.type === 'result') {
      const s = evt.stats || {};
      m.tokens = {
        input: s.input_tokens ?? s.input ?? 0,
        output: s.output_tokens ?? 0,
        cached: s.cached ?? 0,
        total: s.total_tokens ?? 0,
      };
      if (typeof s.tool_calls === 'number') m.events.tool_calls = s.tool_calls;
      m.result_status = evt.status || null;
    }
    writeMeta(jobDir, m);
  }

  child.on('exit', (code, signal) => {
    clearTimeout(hardTimer);
    transcript.end();
    stderrLog.end();

    const m = readMeta(jobDir);
    m.ended_at = new Date().toISOString();
    m.exit_code = code;
    m.duration_seconds = (new Date(m.ended_at) - new Date(m.started_at)) / 1000;

    // Output final = lo último que escribió el assistant
    if (assistantText.trim()) {
      writeFileSync(join(jobDir, 'output.md'), assistantText.trim() + '\n');
      m.summary = assistantText.trim().slice(0, 200).replace(/\s+/g, ' ');
    }

    // Detectar si hubo cambios usando el SHA capturado al clone
    // (más robusto que asumir master/main, soporta repos con cualquier branch base)
    const base = m.base_commit || 'HEAD~0';
    const diffRes = spawnSync('git', ['-C', wd, 'rev-list', '--count', `${base}..HEAD`],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const commitsAhead = parseInt(diffRes.stdout.toString().trim() || '0', 10);
    m.commits_ahead = commitsAhead;
    m.has_changes = commitsAhead > 0;

    // Detectar archivos untracked (multimedia, dumps, lo que sea que el agente
    // dejó sin committear). Importante: Gemini puede generar imágenes/audio.
    const untrackedRes = spawnSync('git', ['-C', wd, 'ls-files', '--others', '--exclude-standard'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const untrackedPaths = untrackedRes.stdout.toString().split('\n').filter(Boolean);
    m.untracked_files = untrackedPaths.slice(0, 100).map((rel) => {
      try {
        const st = statSync(join(wd, rel));
        return { path: rel, size: st.size };
      } catch {
        return { path: rel, size: 0 };
      }
    });
    m.untracked_count = untrackedPaths.length;

    if (signal === 'SIGKILL' || signal === 'SIGTERM') {
      m.status = 'killed';
    } else if (code === 0) {
      m.status = 'ok';
    } else {
      m.status = 'failed';
    }

    // Si falló o no llegó result event, capturar último contexto de stderr
    if (m.status !== 'ok') {
      try {
        const stderrPath = join(jobDir, 'gemini-stderr.log');
        if (existsSync(stderrPath)) {
          const stderrText = readFileSync(stderrPath, 'utf8');
          const lines = stderrText.split('\n').filter((l) => l.trim());
          m.stderr_tail = lines.slice(-5);

          // Detectar causas conocidas
          const all = stderrText.toLowerCase();
          if (all.includes('exhausted your capacity') || all.includes('quota') || all.includes('rate limit')) {
            m.failure_reason = 'quota_or_rate_limit';
          } else if (all.includes('network') || all.includes('timeout') || all.includes('connect')) {
            m.failure_reason = 'network';
          } else if (all.includes('auth') || all.includes('credential') || all.includes('unauthorized')) {
            m.failure_reason = 'auth';
          } else {
            m.failure_reason = 'unknown';
          }
        }
      } catch {}
    }
    writeMeta(jobDir, m);

    // Notificación desktop (best-effort, Linux)
    try {
      spawnSync('notify-send', [
        `Delegate ${m.status}: ${id}`,
        `${m.tokens.total || 0} tokens · ${commitsAhead} commits · ${fmtDuration(m.duration_seconds)}`,
      ], { stdio: 'ignore' });
    } catch {}

    process.exit(0);
  });
}

function detectBaseBranch(wd) {
  // Devuelve "master" o "main" según lo que exista en el clone
  for (const b of ['master', 'main']) {
    const r = spawnSync('git', ['-C', wd, 'rev-parse', '--verify', b],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status === 0) return b;
  }
  return 'master';
}

// ---------- list ----------

async function cmdList(args) {
  const cfg = loadConfig();
  const jobsDir = cfg.jobsDir;
  const { flags } = parseFlags(args);
  const ids = listJobIds(jobsDir);
  if (ids.length === 0) {
    console.log('No hay jobs.');
    return;
  }

  const rows = ids.map((id) => {
    try { return readMeta(join(jobsDir, id)); }
    catch { return { id, status: '?', repo: '?', tokens: {}, events: {} }; }
  });

  const filtered = flags.status ? rows.filter((r) => r.status === flags.status) : rows;
  if (filtered.length === 0) {
    console.log(`No hay jobs con status="${flags.status}".`);
    return;
  }

  // Detectar monitores muertos en jobs running
  for (const r of filtered) {
    if (r.status === 'running' && r.monitor_pid && !isProcessAlive(r.monitor_pid)) {
      r._stale = true;
    }
  }

  const colors = {
    pending: '\x1b[90m', running: '\x1b[33m', ok: '\x1b[32m',
    failed: '\x1b[31m', killed: '\x1b[31m', stalled: '\x1b[35m',
  };
  const reset = '\x1b[0m';

  const header = ['ID', 'STATUS', 'REPO', 'TOKENS', 'TOOLS', 'COMMITS', 'DURATION'];
  const data = filtered.map((r) => [
    r.id,
    (colors[r.status] || '') + r.status + (r._stale ? '*' : '') + reset,
    r.repo || '-',
    fmtTokens(r.tokens),
    String(r.events?.tool_calls ?? 0),
    String(r.commits_ahead ?? '-'),
    fmtDuration(r.duration_seconds),
  ]);

  // simple column print
  const widths = header.map((h, i) => Math.max(
    stripAnsi(h).length,
    ...data.map((row) => stripAnsi(row[i]).length)
  ));
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - stripAnsi(s).length));
  console.log(header.map((h, i) => pad(h, widths[i])).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of data) {
    console.log(row.map((c, i) => pad(c, widths[i])).join('  '));
  }

  if (filtered.some((r) => r._stale)) {
    console.log('\n* monitor murió pero status=running. Probable crash. Revisá monitor.log del job.');
  }
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------- show ----------

async function cmdShow(args) {
  const cfg = loadConfig();
  const { positional } = parseFlags(args);
  if (!positional[0]) { console.error('Falta <id>.'); process.exit(1); }
  const jobDir = findJobDir(cfg.jobsDir, positional[0]);
  const meta = readMeta(jobDir);

  console.log(`=== ${meta.id} ===`);
  console.log(`status:       ${meta.status}`);
  console.log(`agent/model:  ${meta.agent} / ${meta.model || '?'}`);
  console.log(`repo:         ${meta.repo} (${meta.source_repo_path})`);
  console.log(`branch:       ${meta.branch}`);
  console.log(`session_id:   ${meta.session_id || '-'}`);
  console.log(`created:      ${meta.created_at}`);
  console.log(`duration:     ${fmtDuration(meta.duration_seconds)}`);
  console.log(`tokens:       in=${meta.tokens?.input || 0} out=${meta.tokens?.output || 0} cached=${meta.tokens?.cached || 0} total=${meta.tokens?.total || 0}`);
  console.log(`tool_calls:   ${meta.events?.tool_calls ?? 0}`);
  console.log(`errors:       ${meta.events?.errors ?? 0}`);
  console.log(`commits ahead: ${meta.commits_ahead ?? '-'}`);
  if (meta.failure_reason) {
    console.log(`failure:      ${meta.failure_reason}`);
    if (meta.stderr_tail?.length) {
      console.log(`stderr tail:`);
      for (const l of meta.stderr_tail) console.log(`              ${l}`);
    }
  }
  console.log(``);
  console.log(`-- prompt --`);
  console.log(readFileSync(join(jobDir, 'prompt.md'), 'utf8').trim());
  console.log(``);

  const outPath = join(jobDir, 'output.md');
  if (existsSync(outPath)) {
    console.log(`-- output --`);
    console.log(readFileSync(outPath, 'utf8').trim());
    console.log(``);
  }

  if (meta.has_changes) {
    const wd = join(jobDir, 'workspace');
    const base = meta.base_commit || detectBaseBranch(wd);
    console.log(`-- git log ${base}..HEAD --`);
    spawnSync('git', ['-C', wd, 'log', '--oneline', `${base}..HEAD`],
      { stdio: 'inherit' });
    console.log(``);
  }

  if (meta.untracked_count > 0) {
    console.log(`-- archivos untracked (no committeados, ${meta.untracked_count} total) --`);
    for (const f of meta.untracked_files || []) {
      console.log(`  ${formatBytes(f.size).padStart(10)}  ${f.path}`);
    }
    if (meta.untracked_count > (meta.untracked_files || []).length) {
      console.log(`  ... (${meta.untracked_count - meta.untracked_files.length} más)`);
    }
    console.log(``);
    console.log(`Para sacarlos del clone: delegate review ${meta.id} --export <dir-destino>`);
    console.log(``);
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}G`;
}

// ---------- review ----------

async function cmdReview(args) {
  const cfg = loadConfig();
  const { positional, flags } = parseFlags(args);
  if (!positional[0]) { console.error('Falta <id>.'); process.exit(1); }
  const jobDir = findJobDir(cfg.jobsDir, positional[0]);
  const meta = readMeta(jobDir);

  if (meta.status === 'running') {
    console.error(`Job aún en running. Esperá a que termine antes de review.`);
    process.exit(1);
  }

  const wd = join(jobDir, 'workspace');
  const base = meta.base_commit || detectBaseBranch(wd);

  console.log(`=== Review ${meta.id} ===`);
  console.log(`status: ${meta.status} · tokens: ${meta.tokens?.total || 0} · duration: ${fmtDuration(meta.duration_seconds)}`);
  console.log(`branch: ${meta.branch} (en clone aislado)`);
  console.log(``);

  if (existsSync(join(jobDir, 'output.md'))) {
    console.log(`-- output.md --`);
    console.log(readFileSync(join(jobDir, 'output.md'), 'utf8').trim());
    console.log(``);
  }

  if (meta.untracked_count > 0) {
    console.log(`-- archivos untracked (multimedia/dumps, ${meta.untracked_count} total) --`);
    for (const f of meta.untracked_files || []) {
      console.log(`  ${formatBytes(f.size).padStart(10)}  ${f.path}`);
    }
    if (meta.untracked_count > (meta.untracked_files || []).length) {
      console.log(`  ... (${meta.untracked_count - meta.untracked_files.length} más)`);
    }
    console.log(``);
  }

  // Acciones no-interactivas tienen prioridad sobre cualquier early-return
  if (flags.export) {
    exportUntracked(meta, jobDir, flags.export);
  }
  if (flags.discard) {
    discardJob(meta, jobDir);
    return;
  }

  if (!meta.has_changes) {
    console.log(`Sin commits en agent/${meta.id}. No hay branch para mergear.`);
    if (meta.untracked_count > 0 && !flags.export) {
      console.log(`Hay ${meta.untracked_count} archivos untracked — usá --export <dir> para sacarlos.`);
    }
    console.log(`Cleanup cuando quieras: delegate review ${meta.id} --discard`);
    return;
  }

  if (flags.export) return;

  console.log(`-- git log ${base}..HEAD --`);
  spawnSync('git', ['-C', wd, 'log', '--oneline', `${base}..HEAD`], { stdio: 'inherit' });
  console.log(``);
  console.log(`-- git diff --stat ${base}..HEAD --`);
  spawnSync('git', ['-C', wd, 'diff', '--stat', `${base}..HEAD`], { stdio: 'inherit' });
  console.log(``);

  if (flags['show-diff']) {
    console.log(`-- git diff ${base}..HEAD --`);
    spawnSync('git', ['-C', wd, 'diff', `${base}..HEAD`], { stdio: 'inherit' });
    console.log(``);
  } else {
    console.log(`(usá --show-diff para ver el diff completo)`);
    console.log(``);
  }

  if (flags.fetch) {
    fetchIntoSource(meta, jobDir, wd);
    return;
  }

  if (flags.discard) {
    discardJob(meta, jobDir);
    return;
  }

  // Interactivo
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question('Acción [f]etch a source repo · [d]iscard · [s]kip: ')).trim().toLowerCase();
  rl.close();
  if (ans === 'f') fetchIntoSource(meta, jobDir, wd);
  else if (ans === 'd') discardJob(meta, jobDir);
  else console.log('Skip. El job queda en disco para revisar después.');
}

function fetchIntoSource(meta, jobDir, wd) {
  const sourceRepo = meta.source_repo_path;
  const branch = meta.branch;
  console.log(``);
  console.log(`Importando ${branch} a ${sourceRepo}...`);
  const r = spawnSync('git', ['-C', sourceRepo, 'fetch', wd, `${branch}:${branch}`],
    { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`Fetch falló. Branch en clone sigue intacto.`);
    process.exit(1);
  }
  console.log(``);
  console.log(`✔ Branch ${branch} ahora vive en ${sourceRepo}.`);
  console.log(``);
  console.log(`Próximos pasos (manuales, vos decidís):`);
  console.log(`  cd ${sourceRepo}`);
  console.log(`  git checkout ${branch}        # inspeccionar`);
  console.log(`  git push origin ${branch}     # cuando estés convencido`);
  console.log(`  gh pr create                  # PR para review formal`);
  console.log(``);
  console.log(`Cleanup del clone (cuando quieras):`);
  console.log(`  delegate review ${meta.id} --discard`);
}

function discardJob(meta, jobDir) {
  console.log(`Borrando job ${meta.id} (clone, auth copy, transcripts)...`);
  rmSync(jobDir, { recursive: true, force: true });
  console.log(`✔ Borrado. Branch nunca tocó ningún repo real.`);
}

function exportUntracked(meta, jobDir, destDir) {
  if (!meta.untracked_files || meta.untracked_files.length === 0) {
    console.log(`No hay archivos untracked para exportar.`);
    return;
  }
  const wd = join(jobDir, 'workspace');
  const dest = resolve(destDir);
  mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const f of meta.untracked_files) {
    const src = join(wd, f.path);
    const target = join(dest, f.path);
    mkdirSync(dirname(target), { recursive: true });
    try {
      copyFileSync(src, target);
      copied++;
    } catch (e) {
      console.error(`  fallo: ${f.path} → ${e.message}`);
    }
  }
  console.log(`✔ ${copied}/${meta.untracked_files.length} archivos exportados a ${dest}`);
}

// ---------- kill ----------

async function cmdKill(args) {
  const cfg = loadConfig();
  const { positional } = parseFlags(args);
  if (!positional[0]) { console.error('Falta <id>.'); process.exit(1); }
  const jobDir = findJobDir(cfg.jobsDir, positional[0]);
  const meta = readMeta(jobDir);

  if (meta.status !== 'running' && meta.status !== 'pending') {
    console.error(`Job no está corriendo (status=${meta.status}).`);
    process.exit(1);
  }

  if (meta.docker_container) {
    spawnSync('docker', ['kill', meta.docker_container], { stdio: 'inherit' });
  }
  if (meta.monitor_pid && isProcessAlive(meta.monitor_pid)) {
    try { process.kill(meta.monitor_pid, 'SIGTERM'); } catch {}
  }
  console.log(`Kill enviado. Esperá unos segundos y revisá con "delegate show ${meta.id}".`);
}

// ---------- usage ----------

function usage() {
  console.error(`delegate.mjs — orquestador de agentes en sandbox Docker

Setup (en la raíz del proyecto target):
  delegate init                        Crea delegate.config.json + .delegate/sandbox.env
  delegate build                       Buildea la imagen Docker (lee dockerImage del config)

Comandos:
  delegate run gemini "<prompt>"       Lanza job. Devuelve id inmediatamente.
                  [--repo <key>]                   default: workspace (claves del config)
                  [--prompt-file <path>]           prompt desde archivo
                  [--timeout <minutos>]            default: 30
  delegate list  [--status running|ok|failed|killed]
  delegate show <id>                   meta + prompt + output + git log
  delegate review <id>                 diff + decisión interactiva (fetch/discard/skip)
                  [--show-diff]        imprime diff completo
                  [--fetch]            no-interactivo: importa branch a source repo
                  [--discard]          no-interactivo: borra todo el job
  delegate kill <id>                   matar job en running
`);
  process.exit(1);
}

// ---------- dispatch ----------

const argv = process.argv.slice(2);
const command = argv[0];
const handlers = {
  init: cmdInit,
  build: cmdBuild,
  run: cmdRun,
  list: cmdList,
  show: cmdShow,
  review: cmdReview,
  kill: cmdKill,
  _monitor: cmdMonitor,
};

if (!command || !handlers[command]) usage();
await handlers[command](argv.slice(1));
