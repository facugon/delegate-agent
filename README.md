# delegate — local agent sandbox orchestrator

Orquestador local para delegar tareas a agentes LLM (hoy: Gemini CLI) en background, con sandbox Docker, trazabilidad completa, y review humano antes de mergear nada.

**No es un servicio. No tiene API HTTP. No usa DB.** Es un script Node + Docker + filesystem. Pensado para uso individual (vos + tu agente principal trabajando juntos), no para multi-tenancy.

Es **agnóstico al proyecto**: toda la config específica (qué repos, qué imagen, qué env mock) vive en un `delegate.config.json` en la raíz de cada proyecto que lo use. El binario es el mismo para todos.

Este README es la fuente única: arquitectura, uso, aislamiento, troubleshooting y limitaciones viven todos acá.

---

## Para qué sirve

Liberar tu atención de tareas paralelizables que no requieren foco continuo, mientras seguís trabajando en algo complejo. Casos típicos:

- Research que toma minutos (docs externas, benchmarks competitivos, cambios de APIs).
- Generación de copy / drafts / descripciones.
- Generación de imágenes / audio para muestrario, banners, redes.
- Resúmenes de docs largos del repo.
- Propuestas UI/UX, mockups en código.
- Cualquier exploración donde la latencia (30s–3min de spin-up) no molesta.

**No usar para** nada que toque sistemas productivos críticos de tu proyecto. La sandbox ni siquiera tiene credenciales reales para ejecutar contra esos sistemas — pero igual definí las zonas prohibidas en tu skill / reglas del proyecto.

### Por qué existe

Cuando trabajás con un agente principal en una sesión interactiva (Claude Code, Cursor, etc.) y necesitás delegarle algo a un agente paralelo, las opciones típicas son:

- **Subagent en la misma sesión** → contamina tu contexto, si crashea te lleva a vos.
- **Otra terminal con el CLI del otro agente** → se te olvida que está corriendo, no hay trazabilidad.
- **Servicio de orquestación con cola, DB, dashboards** → over-engineering para uso personal.

`delegate` es el punto medio: lanzás un job, te dice un id, sigue corriendo solo en su propio container, te notifica cuando termina, y queda todo persistido a disco para review.

---

## Requisitos

- **Docker** (cualquier versión moderna, sin daemon especial)
- **Node 18+**
- **Gemini CLI autenticado en host**: `npm install -g @google/gemini-cli` y correr `gemini` interactivo una vez para el OAuth login. Esto crea `~/.gemini/oauth_creds.json`, que se copia al container por job.
- **Git ≥ 2.30** (para `git clone --local --no-hardlinks`)

Opcional: `notify-send` (Linux) para notificación desktop al terminar un job.

---

## Instalación

### 1. Cloná este repo (una vez, en cualquier lado)

```bash
git clone <este-repo> ~/tools/delegate-agent
```

(Opcional) ponelo en el PATH para escribir `delegate` en vez del path completo:

```bash
ln -s ~/tools/delegate-agent/bin/delegate.mjs ~/.local/bin/delegate
chmod +x ~/tools/delegate-agent/bin/delegate.mjs
```

Si no, invocás siempre con `node ~/tools/delegate-agent/bin/delegate.mjs ...`.

### 2. Inicializá en tu proyecto

Desde la raíz del proyecto target:

```bash
delegate init
```

Esto crea `delegate.config.json` y `.delegate/sandbox.env` a partir de los templates. Después:

1. **Editá `delegate.config.json`** — ajustá `repos` (claves → paths relativos a la raíz) y `dockerImage`:
   ```json
   {
     "dockerImage": "delegate-agent:latest",
     "containerPrefix": "delegate",
     "gitIdentityDomain": "delegate.local",
     "sandboxEnv": ".delegate/sandbox.env",
     "jobsDir": ".delegate/jobs",
     "repos": {
       "workspace": ".",
       "backend": "backend",
       "frontend": "frontend"
     }
   }
   ```
2. **Editá `.delegate/sandbox.env`** — reemplazá los mocks por las variables que TU proyecto consume, todas con valores **fake** para que cualquier llamada real falle ruidoso.
3. **Agregá al `.gitignore` del proyecto**:
   ```
   .delegate/jobs/
   .delegate/sandbox.env
   ```
4. **Buildeá la imagen**:
   ```bash
   delegate build
   ```
5. Probá:
   ```bash
   delegate run gemini "decime hola" --timeout 2
   ```

### 3. (Opcional) Skill para Claude Code

Si usás Claude Code, copiá `templates/SKILL.md.example` a `.claude/skills/delegate/SKILL.md` de tu proyecto y ajustá las zonas prohibidas a tus reglas.

---

## Uso

```bash
# Lanzar
delegate run gemini "<prompt>" \
    [--repo <key>]              # default: workspace (claves del config)
    [--prompt-file <path>]      # prompt desde archivo (para prompts largos)
    [--timeout <minutos>]       # default: 30

# Inspeccionar
delegate list  [--status running|ok|failed|killed]
delegate show  <id-o-prefijo>

# Review (al terminar)
delegate review <id> [--show-diff]
                     [--export <dir>]
                     [--fetch]
                     [--discard]

# Matar job en running
delegate kill <id>
```

Acepta prefijo del id: `delegate show 2026-04-29-001` matchea si es único.

### Flow típico

1. `delegate run gemini "investigá X y dejá resumen en output/x.md"` → devuelve id.
2. Seguís trabajando en lo tuyo.
3. Notificación desktop cuando termina.
4. `delegate show <id>` → revisás meta + output.
5. `delegate review <id>` → diff interactivo, decidís fetch / discard / skip.
6. Si fetch: `cd <source-repo> && git push origin agent/<id>` cuando estés listo.

### Tips de prompting

- Sé explícito sobre el output esperado: "dejá un archivo en `output/X.md`" o "respondé en JSON con campos A, B, C".
- Para multimedia: "los assets guardalos en `/workspace/output/` y NO hagas `git add` de ellos" — los recuperás con `--export <dir>`.
- Pedí commits explícitos si querés branch con historia.
- **No le pidas que pushee** — no tiene cómo, falla ruidoso. La branch queda local hasta que vos pusheás.

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│ Tu sesión (vos + agente principal)                          │
│   delegate run / list / show / review                       │
└──────────────────┬───────────────────────────────────────────┘
                   │ (devuelve job-id en <1s)
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ Proceso monitor (Node, detached, 1 por job)                 │
│  - spawnea docker run                                        │
│  - parsea stream-json line-by-line                           │
│  - actualiza meta.json en cada evento                        │
│  - hard timeout (default 30 min)                             │
│  - notify-send al terminar                                   │
└──────────────────┬───────────────────────────────────────────┘
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ Container Docker (delegate-agent:latest)                    │
│ (node:22-slim + git + gemini-cli)                            │
│  Mounts:                                                     │
│   /workspace         ← clone aislado del repo (rw)           │
│   /home/node/.gemini ← copia descartable de OAuth (rw)       │
│  Env: sandbox.env (todos los secrets como mocks)             │
│  User: node (UID 1000, sin sudo)                             │
│  gemini --skip-trust --yolo --output-format stream-json -p   │
└──────────────────────────────────────────────────────────────┘
```

### Lifecycle de un job

1. **`delegate run gemini "<prompt>" --repo <key>`**
   - Genera `job-id` con timestamp y slug del prompt.
   - Crea `<jobsDir>/<id>/`, escribe `prompt.md`.
   - `git clone --local --no-hardlinks` del source repo a `workspace/` (sin compartir inodes).
   - Sobre el clone: `git remote remove origin`, set identity (`agent-<id>@<gitIdentityDomain>`), `git checkout -b agent/<id>`. Captura `base_commit` para diffs robustos.
   - Copia `~/.gemini/{oauth_creds,...}` a `.gemini-auth/` del job. El `~/.gemini` original **nunca se monta**.
   - Escribe `meta.json` (status=pending) y spawnea proceso monitor detached.
   - Devuelve job-id a stdout en <1s.

2. **Proceso monitor (detached)**
   - `docker run --rm` con el clone, la auth copy y `--env-file sandbox.env`.
   - Parsea cada línea de stdout como JSON-event (`init` / `message` / `tool_use` / `result`), escribe `transcript.jsonl` y actualiza `meta.json`.
   - Hard timeout → `docker kill` si excede `timeout_min`.
   - Al exit: detecta commits (`base_commit..HEAD`), cuenta untracked files, escribe `output.md`, captura `stderr_tail`, marca status, dispara `notify-send`.

3. **Review humano (`delegate review <id>`)**
   - Imprime status, tokens, duración, branch, log + diff, untracked files.
   - Interactivo: `[f]etch` / `[d]iscard` / `[s]kip`. No-interactivo: `--show-diff`, `--export`, `--fetch`, `--discard`.
   - `--fetch` corre `git -C <source-repo> fetch <clone> <branch>:<branch>` — la branch vive en el repo real, **sin pushear**. El push es siempre manual.

---

## Aislamiento

| Recurso | Adentro del container | Notas |
|---|---|---|
| Source code | ✅ Solo el clone aislado | Sin remote, branch `agent/<id>` |
| OAuth Gemini | ✅ Copia descartable | El original nunca se toca |
| `~/.gitconfig`, `~/.ssh`, `~/.gnupg`, `~/.config/gh`, `~/.aws` | ❌ | Sin credenciales heredadas |
| Env reales | ❌ (mocks en `sandbox.env`) | Cualquier request real → 401 / DNS no resuelve |
| Network | ✅ bridge default | API Gemini + HTTP genérico (research) |
| Disco fuera de mount | ❌ | tmpfs en `/`, sin volumes adicionales |
| sudo | ❌ | User `node` (UID 1000) sin escalación |

**Punto clave**: el agente puede hacer cualquier cosa adentro del clone montado. Lo que no puede es escapar del sandbox para tocar credenciales reales o pushear a un remote. La branch que produce queda *local* hasta que un humano la fetchee y la pushee a mano.

---

## Estructura en disco

```
delegate-agent/                  # este repo (el tool)
├── README.md
├── bin/delegate.mjs             # orquestador único, multi-comando
├── docker/Dockerfile            # node:22-slim + git + gemini-cli
└── templates/
    ├── delegate.config.json.example
    ├── sandbox.env.example
    └── SKILL.md.example

<proyecto>/                      # cualquier proyecto que use el tool
├── delegate.config.json         # config del proyecto
└── .delegate/                   # gitignored
    ├── sandbox.env              # mocks del proyecto
    └── jobs/<id>/
        ├── meta.json            # status, tokens, events, traceability
        ├── prompt.md
        ├── output.md
        ├── transcript.jsonl
        ├── monitor.log
        ├── gemini-stderr.log
        ├── .gemini-auth/        # copia descartable del oauth
        └── workspace/           # clone aislado, branch agent/<id>
```

---

## Modos de falla y troubleshooting

| `failure_reason` | Causa | Recovery |
|---|---|---|
| `quota_or_rate_limit` | Cuota Gemini per-min/day exhausta | Esperar minutos. Reintentar. Reducir paralelismo de tool calls. |
| `network` | Sin internet o API Gemini caída | Verificar conectividad. |
| `auth` | OAuth de `~/.gemini/` venció | Correr `gemini` interactivo en host para refrescar; el próximo job copia el oauth nuevo. |
| `unknown` con `tokens=0`, `exit=1` | Gemini-CLI murió sin emitir `result`. | Ver `meta.stderr_tail` y `transcript.jsonl`. |

### Otros problemas conocidos

- **`commits_ahead: 0` pero el agente trabajó** — verificar que `meta.base_commit` esté seteado y el clone tenga la branch base esperada.
- **container muere apenas usa `run_shell_command`** — si cambiaste la imagen base a Alpine, ese es el bug: gemini-cli es incompatible con musl/busybox. Usar Debian (`node:22-slim`).
- **permisos de filesystem raros en `workspace/`** — el user del container es UID 1000. Si tu user del host tiene otro UID, ajustá `USER` en el Dockerfile y el `-u` del docker run.
- **`Docker: no such image`** — corré `delegate build` (verificá que `dockerImage` en el config matchee el tag).
- **`No encontré delegate.config.json`** — corré `delegate init` en la raíz del proyecto.

---

## Diseño — qué NO hace y por qué

| | |
|---|---|
| Sin DB | Filesystem es la API. <1000 jobs es manejable. Si crece, SQLite (sigue siendo file). |
| Sin HTTP | Es local. No hay multi-tenancy. |
| Sin daemon persistente | Cada job es un proceso. Si se cuelga uno, no afecta a los demás. |
| Sin push automático | El agente no tiene credenciales de git remote. El push siempre lo hace el humano tras review. |

---

## Limitaciones actuales

1. **Solo Gemini.** La arquitectura es agent-agnóstica pero agregar otro agente requiere sumar el binario al Dockerfile y un handler de auth.
2. **Sin auto-cleanup.** Jobs viejos quedan en `<jobsDir>/`; cada clone puede pesar 10-100MB.
3. **Sin retry automático** en caso de cuota.
4. **No hay continuación de sesión** (`--resume`) expuesta todavía.
5. **No hay UI visual** para diff/review; todo es CLI.

---

## Cómo extender

### Agregar un nuevo repo target

En `delegate.config.json`, sumá una entrada a `repos` con `nombre: 'path/relativo'`.

### Agregar un nuevo agente (ej: Claude) — futuro

1. **Dockerfile**: agregar `RUN npm install -g @anthropic-ai/claude-code`.
2. **Handler de auth**: copiar `~/.claude/{credentials,settings,...}` a `.claude-auth/` del job.
3. **Args spawn**: cuando `agent === 'claude'`, invocar `claude -p "..."` con flags equivalentes.
4. **Stream parser**: si el formato difiere, agregar un mapper en el handler de eventos.
