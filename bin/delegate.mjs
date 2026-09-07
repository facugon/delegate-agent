#!/usr/bin/env node
// delegate.mjs — Orquestador local de agentes en sandbox Docker.
//
// Multi-agente vía un registry de "adapters" (AGENTS): cada agente define cómo
// se invoca headless, cómo se prepara su auth, y cómo se parsea su stream-json.
// Hoy: gemini y claude (code). El core es agnóstico al proyecto: toda la config
// (repos, imagen, env sandbox, overrides de agente/auth) vive en
// `delegate.config.json` en la raíz del proyecto target, que el binario descubre
// subiendo desde el CWD.

import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync,
  existsSync, createWriteStream, statSync, rmSync, cpSync, appendFileSync,
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

const CONFIG_DEFAULTS = {
  dockerImage: 'delegate-agent:latest',
  containerPrefix: 'delegate',
  gitIdentityDomain: 'delegate.local',
  sandboxEnv: '.delegate/sandbox.env',
  jobsDir: '.delegate/jobs',
  defaultAgent: 'claude',
  repos: { workspace: '.' },
  agents: {},
};

// ---------- agent adapters ----------
//
// Cada adapter define:
//   label       nombre del binario (para mostrar)
//   defaultModel (string|null) modelo si no se pasa --model ni config
//   extraEnv    env vars extra para el container (['NAME=val'])
//   auth        descriptor de auth por defecto (overridable por config):
//                 mode 'oauth-dir': { dirs:[{ target, copies:[hostPath], synth:[{name,content}] }] }
//                   Se montan DIRECTORIOS (no archivos sueltos): los CLIs hacen
//                   escritura atómica (write-tmp + rename), que falla con EBUSY
//                   sobre un bind-mount de archivo. Montar el dir lo permite.
//                 mode 'api-key':   { env:'NAME', fromHostEnv:true }
//   buildCmd({promptText, model}) → argv del CLI (después del nombre de imagen)
//   handleEvent(evt, m, ctx) muta meta `m` y el contexto acumulador `ctx`
//   finalText(ctx) → texto final del agente (para output.md)

const AGENTS = {
  gemini: {
    label: 'gemini',
    defaultModel: null,
    extraEnv: ['GEMINI_CLI_TRUST_WORKSPACE=true'],
    auth: {
      mode: 'oauth-dir',
      dirs: [{
        target: '/home/node/.gemini',
        copies: [
          'oauth_creds.json', 'google_accounts.json', 'projects.json',
          'settings.json', 'installation_id',
        ].map((f) => `~/.gemini/${f}`),
        synth: [],
      }],
    },
    buildCmd({ promptText, model }) {
      return [
        'gemini', '--skip-trust', '--yolo',
        '--output-format', 'stream-json',
        ...(model ? ['-m', model] : []),
        '-p', promptText,
      ];
    },
    handleEvent(evt, m, ctx) {
      if (evt.type === 'init') {
        m.session_id = evt.session_id || null;
        m.model = evt.model || m.model || null;
      } else if (evt.type === 'message') {
        m.events.messages = (m.events.messages || 0) + 1;
        if (evt.role === 'assistant' && typeof evt.content === 'string') {
          ctx.assistantText += evt.content;
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
    },
    finalText(ctx) { return ctx.assistantText; },
  },

  claude: {
    label: 'claude',
    defaultModel: null,
    extraEnv: [],
    auth: {
      mode: 'oauth-dir',
      // Token OAuth de la subscripción. El resto (~/.claude/*) queda local al container.
      // ~/.claude.json (config mínima de onboarding) está horneado en la imagen.
      dirs: [{
        target: '/home/node/.claude',
        copies: ['~/.claude/.credentials.json'],
        synth: [],
      }],
    },
    buildCmd({ promptText, model }) {
      return [
        'claude', '-p', promptText,
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        '--strict-mcp-config', // no cargar MCP servers del host
        ...(model ? ['--model', model] : []),
      ];
    },
    handleEvent(evt, m, ctx) {
      if (evt.type === 'system' && evt.subtype === 'init') {
        m.session_id = evt.session_id || m.session_id || null;
        m.model = evt.model || m.model || null;
      } else if (evt.type === 'assistant') {
        m.events.messages = (m.events.messages || 0) + 1;
        const content = evt.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_use') m.events.tool_calls = (m.events.tool_calls || 0) + 1;
          }
        }
      } else if (evt.type === 'result') {
        const u = evt.usage || {};
        const input = u.input_tokens ?? 0;
        const output = u.output_tokens ?? 0;
        const cached = u.cache_read_input_tokens ?? 0;
        const cacheCreate = u.cache_creation_input_tokens ?? 0;
        m.tokens = { input, output, cached, total: input + output + cached + cacheCreate };
        m.result_status = evt.subtype || null;
        if (evt.is_error) m.events.errors = (m.events.errors || 0) + 1;
        if (typeof evt.session_id === 'string') m.session_id = evt.session_id;
        if (typeof evt.result === 'string') ctx.resultText = evt.result;
        if (typeof evt.total_cost_usd === 'number') m.cost_usd = evt.total_cost_usd;
      }
    },
    finalText(ctx) { return ctx.resultText || ctx.assistantText; },
  },

  // Antigravity CLI — reemplazo de gemini-cli (Google retira gemini-cli 2026-06-18).
  // Headless es delicado: `agy -p` DESCARTA stdout sin TTY (exit 0, vacío), y
  // `--output-format json` está reportado roto. Por eso lo envolvemos con
  // `unbuffer` (PTY, pasa argv nativo) y capturamos texto plano sanitizado.
  // El parseo de stream-json + métricas de tokens queda como refinamiento futuro
  // (requiere ver el schema real de eventos de agy con una API key).
  agy: {
    label: 'agy',
    defaultModel: null,
    sanitizeAnsi: true, // salida vía PTY → puede traer códigos ANSI
    extraEnv: [],
    // OAuth real (cuenta Plus), no api-key de AI Studio: esa key pega contra
    // el free tier público (generativelanguage.googleapis.com, cuota propia,
    // gemini-3.1-pro con limit:0 ahí) en vez de tu cuota de Antigravity.
    // El container no tiene keyring de SO, así que agy cae a file storage
    // para el token — login inicial una sola vez (interactivo, en tu terminal,
    // no por delegate), después queda cacheado y se refresca solo.
    auth: {
      mode: 'oauth-dir',
      dirs: [{
        target: '/home/node/.gemini/antigravity-cli',
        copies: ['~/.delegate/agy-oauth/antigravity-oauth-token'],
      }],
    },
    buildCmd({ promptText, model }) {
      return [
        'unbuffer', // aloca PTY (paquete `expect`); evita el drop de stdout non-TTY
        'agy', '-p', promptText,
        '--dangerously-skip-permissions', // auto-aprueba confirmaciones de tools
        ...(model ? ['--model', model] : []),
      ];
    },
    handleEvent() { /* texto plano: no hay eventos JSON que parsear (v1) */ },
    finalText(ctx) { return ctx.rawText; },
  },

  // Codex CLI (OpenAI). Auth = login ChatGPT (consume cuota del plan mensual,
  // no pay-per-token de API key) → ~/.codex/auth.json. `codex exec --json`
  // emite JSONL limpio a stdout (logs `tracing` van a stderr).
  codex: {
    label: 'codex',
    defaultModel: null,
    extraEnv: [],
    auth: {
      mode: 'oauth-dir',
      dirs: [{
        target: '/home/node/.codex',
        copies: ['~/.codex/auth.json', '~/.codex/config.toml'],
        synth: [],
      }],
    },
    buildCmd({ promptText, model }) {
      return [
        'codex', 'exec',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
        '-C', '/workspace',
        ...(model ? ['--model', model] : []),
        promptText,
      ];
    },
    handleEvent(evt, m, ctx) {
      if (evt.type === 'thread.started') {
        m.session_id = evt.thread_id || m.session_id || null;
      } else if (evt.type === 'item.completed') {
        const item = evt.item || {};
        m.events.messages = (m.events.messages || 0) + 1;
        if (item.type === 'agent_message') {
          const text = item.text ?? item.content;
          if (typeof text === 'string') ctx.assistantText += text;
        } else if (['command_execution', 'patch_apply', 'mcp_tool_call', 'file_change'].includes(item.type)) {
          m.events.tool_calls = (m.events.tool_calls || 0) + 1;
        } else if (item.type === 'error') {
          m.events.errors = (m.events.errors || 0) + 1;
        }
      } else if (evt.type === 'turn.completed') {
        const u = evt.usage || {};
        const input = u.input_tokens ?? 0;
        const output = u.output_tokens ?? 0;
        const cached = u.cached_input_tokens ?? 0;
        const cacheWrite = u.cache_write_input_tokens ?? 0;
        m.tokens = { input, output, cached, total: input + output + cached + cacheWrite };
        m.result_status = 'completed';
      } else if (evt.type === 'turn.failed') {
        m.events.errors = (m.events.errors || 0) + 1;
        m.result_status = 'failed';
      } else if (evt.type === 'error') {
        m.events.errors = (m.events.errors || 0) + 1;
      }
    },
    finalText(ctx) { return ctx.assistantText || ctx.rawText; },
  },
};

// ---------- config ----------

function findProjectRoot(start = process.cwd()) {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, CONFIG_FILENAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Config global de usuario (~/.delegate/config.json): defaults compartidos por
// todos los proyectos (agents/auth, dockerImage, defaultAgent, etc.) — evita
// tener que repetir delegate.config.json en cada carpeta. Un delegate.config.json
// de proyecto (encontrado subiendo desde cwd) sigue funcionando y pisa al global;
// si no hay ninguno, se usa el global solo, con cwd como raíz del "repo".
const GLOBAL_CONFIG_PATH = join(homedir(), '.delegate', 'config.json');

function loadGlobalConfig() {
  if (!existsSync(GLOBAL_CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error(`No pude parsear ${GLOBAL_CONFIG_PATH}: ${e.message}`);
    process.exit(1);
  }
}

function loadConfig() {
  const global = loadGlobalConfig();
  const root = findProjectRoot();
  let raw;
  if (root) {
    let projectRaw;
    try {
      projectRaw = JSON.parse(readFileSync(join(root, CONFIG_FILENAME), 'utf8'));
    } catch (e) {
      console.error(`No pude parsear ${join(root, CONFIG_FILENAME)}: ${e.message}`);
      process.exit(1);
    }
    raw = {
      ...global,
      ...projectRaw,
      agents: { ...(global.agents || {}), ...(projectRaw.agents || {}) },
    };
  } else if (Object.keys(global).length) {
    raw = global;
  } else {
    console.error(`No encontré ${CONFIG_FILENAME} en este directorio ni en sus padres, ni ${GLOBAL_CONFIG_PATH}.`);
    console.error(`Corré "delegate init" en la raíz del proyecto, o creá el config global.`);
    process.exit(1);
  }
  const effectiveRoot = root || process.cwd();
  const c = { ...CONFIG_DEFAULTS, ...raw };
  const reposRaw = raw.repos || CONFIG_DEFAULTS.repos;
  const repos = {};
  for (const [key, rel] of Object.entries(reposRaw)) {
    repos[key] = resolve(effectiveRoot, rel);
  }
  return {
    projectRoot: effectiveRoot,
    dockerImage: c.dockerImage,
    containerPrefix: c.containerPrefix,
    gitIdentityDomain: c.gitIdentityDomain,
    sandboxEnv: resolve(effectiveRoot, c.sandboxEnv),
    jobsDir: resolve(effectiveRoot, c.jobsDir),
    defaultAgent: c.defaultAgent,
    repos,
    agents: c.agents || {},
  };
}

// Resuelve el adapter + overrides de config para un agente dado.
function resolveAgent(cfg, name) {
  const adapter = AGENTS[name];
  if (!adapter) {
    console.error(`Agente no soportado: "${name}". Opciones: ${Object.keys(AGENTS).join(', ')}`);
    process.exit(1);
  }
  const override = cfg.agents[name] || {};
  const auth = override.auth || adapter.auth;
  const model = override.model ?? adapter.defaultModel;
  return { name, adapter, auth, model };
}

function expandHome(p) {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
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

function generateJobId(agent, prompt) {
  return `${ymd()}-${hms()}-${agent}-${slug(prompt)}`;
}

function parseFlags(args) {
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

// ---------- base context (skills/rules cross-agente) ----------

// Paths relativos a la raíz del proyecto (cfg.projectRoot) que forman la base
// de contexto común a cualquier agente: reglas + skills (.agents/) y los
// punteros de cada agente a esas reglas (AGENTS.md=Codex, CLAUDE.md=Claude,
// GEMINI.md=Antigravity). Si el repo target (sourceRepo) ya trae su propia
// copia de alguno, se respeta y no se pisa.
const BASE_CONTEXT_PATHS = ['.agents', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];

function injectBaseContext(cfg, sourceRepo, wd) {
  if (resolve(sourceRepo) === resolve(cfg.projectRoot)) return; // ya lo trae el propio clone
  const injected = [];
  for (const rel of BASE_CONTEXT_PATHS) {
    const src = join(cfg.projectRoot, rel);
    const dst = join(wd, rel);
    if (existsSync(src) && !existsSync(dst)) {
      cpSync(src, dst, { recursive: true });
      injected.push(rel);
    }
  }
  if (injected.length) {
    // No versionar esto en el repo target: es contexto inyectado, no parte
    // del código de ese repo. Exclude local (no toca .gitignore versionado).
    const excludePath = join(wd, '.git', 'info', 'exclude');
    const header = '\n# delegate: contexto base inyectado (no versionar en este repo)\n';
    appendFileSync(excludePath, header + injected.map((p) => `/${p}\n`).join(''));
  }
}

// ---------- auth ----------

// Prepara la auth del agente en el jobDir y devuelve los mounts/env para docker.
// - oauth-dir: copia archivos del host + escribe archivos sintéticos, y devuelve
//   un mount `-v` por cada uno (file-level). Los secretos quedan SOLO en disco
//   del job (gitignored), nunca en meta.json.
// - api-key: NO persiste el valor; devuelve el nombre de la env var para que el
//   monitor la resuelva en runtime (config explícita o host env).
function prepareAuth(authDesc, agentName, jobDir) {
  const result = { mounts: [], authEnvName: null, hadCreds: false };
  const d = authDesc || AGENTS[agentName].auth;
  if (!d || d.mode === 'oauth-dir') {
    const authDir = join(jobDir, `.${agentName}-auth`);
    mkdirSync(authDir, { recursive: true });
    let gi = 0;
    for (const grp of ((d && d.dirs) || [])) {
      const staging = join(authDir, `m${gi++}`);
      mkdirSync(staging, { recursive: true });
      for (const srcRaw of (grp.copies || [])) {
        const src = expandHome(srcRaw);
        if (!existsSync(src)) continue;
        copyFileSync(src, join(staging, basename(src)));
        result.hadCreds = true;
      }
      for (const s of (grp.synth || [])) {
        writeFileSync(join(staging, s.name), s.content);
        result.hadCreds = true;
      }
      // Mount a nivel directorio: permite escritura atómica (write-tmp + rename).
      result.mounts.push([staging, grp.target]);
    }
  } else if (d.mode === 'api-key') {
    result.authEnvName = d.env;
    result.authKeyFile = d.keyFile ? expandHome(d.keyFile) : null;
    if (d.settingsFile) {
      const authDir = join(jobDir, `.${agentName}-auth`);
      const staging = join(authDir, 's0');
      mkdirSync(staging, { recursive: true });
      writeFileSync(join(staging, basename(d.settingsFile.target)), d.settingsFile.content);
      result.mounts.push([staging, dirname(d.settingsFile.target)]);
    }
  }
  return result;
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
  console.log(`  1) Editá ${CONFIG_FILENAME} — ajustá "repos", "defaultAgent" y "dockerImage".`);
  console.log(`  2) Editá .delegate/sandbox.env — poné valores FAKE para todo lo que tu código lea.`);
  console.log(`  3) Buildeá la imagen:  delegate build`);
  console.log(`  4) Agregá a tu .gitignore:`);
  console.log(`        .delegate/jobs/`);
  console.log(`        .delegate/sandbox.env`);
  console.log(`  5) Probá:  delegate run claude "decime hola" --timeout 2`);
}

// ---------- build ----------

async function cmdBuild(args) {
  const { flags } = parseFlags(args);
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

  const agentName = positional[0];
  if (!agentName || !AGENTS[agentName]) {
    console.error(`Uso: delegate run <agente> "<prompt>". Agentes: ${Object.keys(AGENTS).join(', ')}`);
    process.exit(1);
  }
  const agent = resolveAgent(cfg, agentName);
  const model = flags.model || agent.model;

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

  const id = generateJobId(agentName, prompt);
  const jobDir = join(jobsDir, id);
  mkdirSync(jobDir, { recursive: true });

  // 1) Prompt
  writeFileSync(join(jobDir, 'prompt.md'), prompt + '\n');

  // 2) Clone aislado, sin remote, sin creds heredadas
  const wd = join(jobDir, 'workspace');
  console.log(`[${id}]`);
  console.log(`  Agent:     ${agentName}${model ? ` (${model})` : ''}`);
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
  spawnSync('git', ['-C', wd, 'config', '--local', 'commit.gpgsign', 'false']);

  const baseShaRes = spawnSync('git', ['-C', wd, 'rev-parse', 'HEAD'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const baseSha = baseShaRes.stdout.toString().trim();
  const baseBranchRes = spawnSync('git', ['-C', wd, 'rev-parse', '--abbrev-ref', 'HEAD'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const baseBranch = baseBranchRes.stdout.toString().trim();

  spawnSync('git', ['-C', wd, 'checkout', '-b', `agent/${id}`]);

  // 2.5) Inyectar contexto base del proyecto (rules + skills + punteros de
  // agente) si el repo target no lo tiene propio. `sourceRepo` puede ser
  // api-cms/site (repos hermanos sin .agents/ ni AGENTS.md/CLAUDE.md/GEMINI.md
  // propios) — sin esto, un agente delegado ahí queda ciego a las reglas del
  // proyecto. Se inyecta SIEMPRE (no solo para codex): el objetivo es una base
  // de skills/rules común a cualquier agente/modelo, no un parche puntual.
  injectBaseContext(cfg, sourceRepo, wd);

  // 3) Preparar auth del agente (copias + sintéticos, o api-key)
  const auth = prepareAuth(agent.auth, agentName, jobDir);
  const authMode = agent.auth?.mode || 'oauth-dir';
  if (authMode === 'oauth-dir' && !auth.hadCreds) {
    console.error(`⚠ No encontré credenciales de "${agentName}" en el host para copiar.`);
    console.error(`  Verificá que el CLI esté autenticado, o configurá auth api-key en ${CONFIG_FILENAME}.`);
  }

  // 4) Meta inicial (NO persiste secretos: solo paths de mount y nombre de env)
  const meta = {
    id,
    agent: agentName,
    agent_label: agent.adapter.label,
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
    auth_mode: agent.auth?.mode || 'oauth-dir',
    auth_mounts: auth.mounts,
    auth_env_name: auth.authEnvName,
    auth_key_file: auth.authKeyFile || null,
    model: model || null,
    session_id: null,
    exit_code: null,
    tokens: { input: 0, output: 0, cached: 0, total: 0 },
    events: { tool_calls: 0, errors: 0, messages: 0 },
    summary: null,
    prompt_preview: prompt.slice(0, 300),
    has_changes: null,
  };
  writeMeta(jobDir, meta);

  // 5) Spawn monitor detached
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

  const meta0 = readMeta(jobDir);
  const agentName = meta0.agent;
  const adapter = AGENTS[agentName];
  if (!adapter) {
    console.error(`Adapter desconocido en meta: ${agentName}`);
    process.exit(1);
  }

  const meta = meta0;
  meta.status = 'running';
  meta.started_at = new Date().toISOString();
  meta.last_activity_at = meta.started_at;
  writeMeta(jobDir, meta);

  const transcriptPath = join(jobDir, 'transcript.jsonl');
  const transcript = createWriteStream(transcriptPath, { flags: 'a' });
  const stderrLog = createWriteStream(join(jobDir, 'agent-stderr.log'), { flags: 'a' });

  const wd = join(jobDir, 'workspace');
  const containerName = `${cfg.containerPrefix}-${id}`;
  const promptText = readFileSync(join(jobDir, 'prompt.md'), 'utf8');

  // Mounts de auth
  const authMountArgs = [];
  for (const [hostPath, containerPath] of (meta.auth_mounts || [])) {
    authMountArgs.push('-v', `${hostPath}:${containerPath}`);
  }
  // Inyección de api-key (resuelta en runtime, sin persistir)
  const authEnvArgs = [];
  if (meta.auth_env_name) {
    const override = cfg.agents[agentName]?.auth || {};
    let value = override.value;
    if (!value && meta.auth_key_file && existsSync(meta.auth_key_file)) {
      value = readFileSync(meta.auth_key_file, 'utf8').trim();
    }
    if (!value) value = process.env[meta.auth_env_name];
    if (value) authEnvArgs.push('-e', `${meta.auth_env_name}=${value}`);
  }
  // Env extra del adapter
  const extraEnvArgs = [];
  for (const e of (adapter.extraEnv || [])) extraEnvArgs.push('-e', e);

  const dockerArgs = [
    'run', '--rm',
    '--name', containerName,
    '--network=bridge',
    '--memory=2g',
    '--cpus=2',
    '-v', `${wd}:/workspace`,
    ...authMountArgs,
    '--env-file', cfg.sandboxEnv,
    ...authEnvArgs,
    ...extraEnvArgs,
    '-w', '/workspace',
    '-u', 'node',
    cfg.dockerImage,
    ...adapter.buildCmd({ promptText, model: meta.model }),
  ];

  meta.docker_container = containerName;
  writeMeta(jobDir, meta);

  const child = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  const hardTimer = setTimeout(() => {
    console.error(`[${id}] Timeout ${meta.timeout_min}m alcanzado, killing container.`);
    spawnSync('docker', ['kill', containerName], { stdio: 'ignore' });
  }, meta.timeout_min * 60 * 1000);

  child.stderr.on('data', (chunk) => stderrLog.write(chunk));

  // Acumulador de contexto entre eventos (texto final del agente)
  const ctx = { assistantText: '', resultText: '', rawText: '' };

  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      transcript.write(raw + '\n');
      const line = adapter.sanitizeAnsi ? stripAnsi(raw).replace(/\r/g, '') : raw;
      if (!line.trim()) continue;
      // Fallback de texto plano (agentes que no emiten JSON parseable, ej agy)
      ctx.rawText += line + '\n';
      let evt;
      try { evt = JSON.parse(line); }
      catch { continue; }
      const m = readMeta(jobDir);
      m.last_activity_at = new Date().toISOString();
      adapter.handleEvent(evt, m, ctx);
      writeMeta(jobDir, m);
    }
  });

  child.on('exit', (code, signal) => {
    clearTimeout(hardTimer);
    transcript.end();
    stderrLog.end();

    const m = readMeta(jobDir);
    m.ended_at = new Date().toISOString();
    m.exit_code = code;
    m.duration_seconds = (new Date(m.ended_at) - new Date(m.started_at)) / 1000;

    const finalText = adapter.finalText(ctx);
    if (finalText && finalText.trim()) {
      writeFileSync(join(jobDir, 'output.md'), finalText.trim() + '\n');
      m.summary = finalText.trim().slice(0, 200).replace(/\s+/g, ' ');
    }

    const base = m.base_commit || 'HEAD~0';
    const diffRes = spawnSync('git', ['-C', wd, 'rev-list', '--count', `${base}..HEAD`],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const commitsAhead = parseInt(diffRes.stdout.toString().trim() || '0', 10);
    m.commits_ahead = commitsAhead;
    m.has_changes = commitsAhead > 0;

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

    if (m.status !== 'ok') {
      try {
        const stderrPath = join(jobDir, 'agent-stderr.log');
        if (existsSync(stderrPath)) {
          const stderrText = readFileSync(stderrPath, 'utf8');
          const lines = stderrText.split('\n').filter((l) => l.trim());
          m.stderr_tail = lines.slice(-5);
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
    catch { return { id, status: '?', repo: '?', agent: '?', tokens: {}, events: {} }; }
  });

  const filtered = flags.status ? rows.filter((r) => r.status === flags.status) : rows;
  if (filtered.length === 0) {
    console.log(`No hay jobs con status="${flags.status}".`);
    return;
  }

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

  const header = ['ID', 'AGENT', 'STATUS', 'REPO', 'TOKENS', 'TOOLS', 'COMMITS', 'DURATION'];
  const data = filtered.map((r) => [
    r.id,
    r.agent || '-',
    (colors[r.status] || '') + r.status + (r._stale ? '*' : '') + reset,
    r.repo || '-',
    fmtTokens(r.tokens),
    String(r.events?.tool_calls ?? 0),
    String(r.commits_ahead ?? '-'),
    fmtDuration(r.duration_seconds),
  ]);

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
  if (meta.cost_usd != null) console.log(`cost:         $${meta.cost_usd}`);
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
    spawnSync('git', ['-C', wd, 'log', '--oneline', `${base}..HEAD`], { stdio: 'inherit' });
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
  delegate run <agente> "<prompt>"     Lanza job. Agentes: ${Object.keys(AGENTS).join(', ')}
                  [--repo <key>]                   default: workspace (claves del config)
                  [--model <id>]                   override del modelo del agente
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
