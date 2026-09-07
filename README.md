# delegate — local agent sandbox orchestrator

Orquestador local para delegar tareas a agentes LLM (**Claude Code** y **Gemini CLI**) en background, con sandbox Docker, trazabilidad completa, y review humano antes de mergear nada.

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
- **Git ≥ 2.30** (para `git clone --local --no-hardlinks`)
- **Auth del agente que vayas a usar** (una de dos opciones por agente):
  - **OAuth en host** (modo `oauth-dir`, default): el agente autenticado en tu host. Para Claude Code, `claude` logueado (token en `~/.claude/.credentials.json`); para Gemini, `gemini` logueado (`~/.gemini/oauth_creds.json`). El tool copia esas creds al container por job — el original nunca se monta.
  - **API key** (modo `api-key`): seteás una env var (`ANTHROPIC_API_KEY` / `GEMINI_API_KEY`) y delegate la inyecta al container. Arranque inmediato, sin OAuth interactivo. La key **no se persiste** en disco.

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
   delegate run claude "decime hola" --timeout 2
   ```

### 2.5. (Opcional) Config global de usuario

`~/.delegate/config.json` guarda defaults compartidos entre todos tus proyectos (`agents`, `dockerImage`, `defaultAgent`, etc.), así no repetís `delegate.config.json` en cada carpeta. Si el CWD no tiene `delegate.config.json` en ningún padre, delegate usa el global solo (con el CWD como raíz del repo). Si ambos existen, el de proyecto pisa al global — el merge es **shallow por agente completo**: si un proyecto define `agents.agy`, reemplaza entero al `agents.agy` global (no mergea `auth` campo a campo). Mismo formato que `delegate.config.json`:
```json
{
  "dockerImage": "delegate-agent:latest",
  "defaultAgent": "agy",
  "agents": {
    "agy": { "comment": "Auth = OAuth de cuenta Plus, cacheado en ~/.delegate/agy-oauth/." }
  }
}
```

### 3. (Opcional) Skill para Claude Code

Si usás Claude Code, copiá `templates/SKILL.md.example` a `.claude/skills/delegate/SKILL.md` de tu proyecto y ajustá las zonas prohibidas a tus reglas.

---

## Agentes

Idea: cada agente rinde en lo suyo. **Claude** para código; **Gemini/Antigravity** para creativo, research, imagen, música, marketing y modelos generales de Google. Querés ambos operativos y delegás a cada uno según la tarea.

| Agente | Comando | Rol | Estado | Auth por defecto |
|---|---|---|---|---|
| **Claude Code** | `delegate run claude "..."` | código | ✅ estable | OAuth `~/.claude/.credentials.json` o `ANTHROPIC_API_KEY` |
| **Antigravity CLI** (`agy`) | `delegate run agy "..."` | creativo/research | ✅ estable | OAuth cuenta Plus, cacheado en `~/.delegate/agy-oauth/` |
| **Gemini CLI** | `delegate run gemini "..."` | legacy | ⛔ Google lo **retira 2026-06-18** | OAuth `~/.gemini` |

El default está en `defaultAgent` del config. Pineá modelo con `--model` o en `config.agents.<agente>.model`.

**Nota sobre `agy` (headless):** su modo `-p` descarta stdout cuando no hay TTY, así que el adapter lo envuelve con `unbuffer` (PTY) y captura texto plano sanitizado de ANSI. El binario `agy` se instala en la imagen vía el instalador oficial de Google (ver Dockerfile).

**Auth de `agy` — por qué es OAuth y no API key:** `agy` guarda su sesión en el keyring del SO (D-Bus/Secret Service), que el container sandbox no tiene. Sin keyring, `agy` cae solo a **file storage** para el token — por eso alcanza con montarle ese archivo (`oauth-dir`, igual patrón que Claude/Codex), sin exponer ninguna key.

**No uses `GEMINI_API_KEY` (AI Studio) para esto**: ese camino pega contra el Gemini Developer API público (`generativelanguage.googleapis.com`), con cuota free-tier **propia y separada** de tu cuenta de Antigravity — ahí `gemini-3.1-pro` tiene `limit: 0` (no es "se agotó", nunca tuvo cupo en el free tier). El OAuth de cuenta Plus, en cambio, pega contra el backend propio de Antigravity (`daily-cloudcode-pa.googleapis.com`) y usa la cuota que ves en el CLI interactivo.

**Login inicial de `agy` (una sola vez, interactivo, en tu propia terminal — no por delegate):**
```bash
mkdir -p ~/.delegate/agy-oauth
docker run --rm -it \
  -v ~/.delegate/agy-oauth:/home/node/.gemini/antigravity-cli \
  -u node delegate-agent:latest \
  agy -p "ok" --dangerously-skip-permissions
```
Te tira una URL de Google, la abrís, logueás con tu cuenta Plus, pegás el código que te devuelve **en esa misma terminal** (la ventana de esa auth es de ~60s — por eso tiene que ser tu terminal directa, no un relay). Si sale bien, queda `~/.delegate/agy-oauth/antigravity-oauth-token` — el adapter lo monta en cada job de ahí en más. El token se refresca solo; si vence, repetís este paso.

## Uso

```bash
# Lanzar
delegate run <agente> "<prompt>" \         # agente: claude | gemini
    [--repo <key>]              # default: workspace (claves del config)
    [--model <id>]              # override del modelo del agente
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

### `agy` pide login OAuth interactivo dentro del job (timeoutea)

Significa que `~/.delegate/agy-oauth/antigravity-oauth-token` no existe o venció. Repetí el login inicial (ver sección de Agentes más arriba) — tiene que ser en tu terminal, un relay (otro proceso pegando el código por vos) pierde contra la ventana de ~60s que da el CLI.

### `agy` responde `429 RESOURCE_EXHAUSTED` / `limit: 0`

Estás pegándole al Gemini Developer API público con una `GEMINI_API_KEY` de AI Studio, no a tu cuenta Plus. Revisá que `agents.agy.auth` no tenga un override `mode: api-key` en ningún `delegate.config.json` (proyecto) ni en `~/.delegate/config.json` (global) — el default del adapter ya es `oauth-dir`, un override en cualquiera de los dos configs lo pisa entero (ver Config global de usuario).

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

1. **Dos agentes (claude, gemini).** Sumar otro = una entrada en el registry `AGENTS` (binario, args headless, auth, parser de stream-json) + instalar el CLI en el Dockerfile. Antigravity CLI está pendiente de confirmar sus flags reales.
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
