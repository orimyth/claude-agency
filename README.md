# Claude Agency

An autonomous AI company powered by [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agents. You act as the investor — give high-level direction, and a team of named AI agents (CEO, developers, designers, architects, researchers) work together autonomously to build whatever you need.

Agents communicate through a real Slack workspace, take breaks when rate-limited (just like real employees), and can even hire new team members through HR when the workload demands it.

## How It Works

```
You (Investor)
  │  Slack DM / Dashboard
  ▼
┌──────────────────────────────────────┐
│          Alice (CEO)                  │
│  Evaluates ideas, delegates work      │
└──────┬───────────────┬───────────────┘
       │               │
  ┌────▼────┐    ┌─────▼──────┐
  │ Charlie │    │   Diana    │
  │Architect│    │  PM / TL   │
  └────┬────┘    └─────┬──────┘
       │          ┌────┼─────┐
       │          ▼    ▼     ▼
       │        Eve  Frank  Grace
       │        Dev  Design Research
       │
  ┌────▼────┐
  │   Bob   │
  │   HR    │ ← Can hire new agents on demand
  └─────────┘
```

**You say:** "Build me a recipe sharing app"

**What happens:**
1. Alice (CEO) receives your idea and evaluates complexity
2. For complex projects, she consults Charlie (Architect) who designs the tech plan
3. Alice sends the plan to you for approval via Slack and the dashboard
4. Once approved, Diana (PM) breaks it into sprint tasks
5. Eve (Developer), Frank (Designer), and Grace (Researcher) execute autonomously
6. When Claude rate limits are hit, agents go on break and auto-resume
7. Alice reports progress back to you

No hand-holding required. You check in when you want, approve plans when asked, and watch the work happen.

## Features

- **7 Named Agents** — CEO (Alice), HR (Bob), Architect (Charlie), PM (Diana), Developer (Eve), Designer (Frank), Researcher (Grace). Each with a distinct personality and communication style.
- **Real Slack Integration** — Agents talk in Slack channels like real coworkers. Short, human-like messages. No AI walls of text. You can interact from your phone.
- **Autonomous Work Loop** — Agents pick up tasks, complete them, and grab the next one. They only stop when there's nothing to do or they need your approval.
- **Rate Limit = Coffee Break** — When Claude limits are hit, agents "take a break" and automatically resume. The CEO tracks break frequency as a KPI.
- **HR Can Hire** — Need a frontend specialist? The CEO tells Bob (HR) to hire one. Bob forks an existing blueprint, customizes it, and onboards a new agent.
- **Permission System** — Global blacklist + role-based rules + temporary overrides. Designers can't touch backend code. Researchers can't push to git. You control what's allowed.
- **Real-Time Dashboard** — Next.js dashboard with KPIs, agent status, task board, approval queue, and activity feed. Drill down from project overview to individual agent logs.
- **Dual Memory** — Per-project memory (context, decisions, patterns) + shared company knowledge base that persists across projects.
- **Deployable Anywhere** — Runs locally on macOS or on a remote Ubuntu server via Docker Compose.

## Architecture

```
┌──────────────────────────────────────────────┐
│              Dashboard (Next.js)              │
│  KPIs · Agent Status · Approvals · Settings   │
└────────────────────┬─────────────────────────┘
                     │ WebSocket + REST API
┌────────────────────▼─────────────────────────┐
│            Orchestrator (Core)                │
│  Agent Manager · Scheduler · Permission Engine│
│  Workflow Engine · Task Board · Memory Manager│
│  Slack Bridge · State Store · API Server      │
└────────────────────┬─────────────────────────┘
                     │
        ┌────────────┼────────────────┐
        ▼            ▼                ▼
   Claude Code   MySQL (State)   Slack (Comms)
   SDK Agents    Tasks/KPIs      Channels/DMs
```

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Orchestrator | TypeScript, Node.js |
| Agent Runtime | `@anthropic-ai/claude-code` SDK |
| State Store | MySQL |
| Dashboard | Next.js 14, Tailwind CSS |
| Real-time | WebSocket |
| Communication | Slack (via `@slack/bolt`) |
| Package Manager | pnpm (monorepo) |

## Setup

### Prerequisites

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- MySQL 8+
- A Claude Code account ([claude.ai](https://claude.ai))
- (Optional) A Slack workspace

### 1. Clone and Install

```bash
git clone https://github.com/orimyth/claude-agency.git
cd claude-agency
pnpm install
```

### 2. Run Setup Wizard

```bash
pnpm setup
```

This walks you through:
- Claude Code authentication
- MySQL connection (host, port, user, password, database)
- Workspace directory for project files
- Concurrency settings

It creates your `.env` file and initializes the database tables.

### 3. Create the MySQL Database

If you haven't already:

```sql
CREATE DATABASE claude_agency;
CREATE USER 'claude_agency'@'localhost' IDENTIFIED BY 'your_password';
GRANT ALL PRIVILEGES ON claude_agency.* TO 'claude_agency'@'localhost';
FLUSH PRIVILEGES;
```

### 4. (Optional) Setup Slack

```bash
pnpm setup:slack
```

This wizard guides you through creating a Slack app:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App
2. Enable **Socket Mode** and create an app-level token (`xapp-...`)
3. Add **Bot Token Scopes**: `chat:write`, `chat:write.customize`, `channels:manage`, `channels:read`, `channels:history`, `channels:join`, `groups:read`, `groups:history`, `users:read`, `reactions:write`, `metadata.message:read`
4. Subscribe to **Events**: `message.channels`, `message.groups`
5. Enable **Interactivity**
6. Install to your workspace
7. Enter the Bot Token (`xoxb-...`), Signing Secret, and App Token when prompted

The wizard auto-creates these channels:
- `#agency-general` — Company announcements
- `#agency-ceo-investor` — Your DM channel with Alice (CEO)
- `#agency-leadership` — CEO + managers
- `#agency-approvals` — Plans awaiting your sign-off
- `#agency-hr-hiring` — New agent roles

### 5. Start the Agency

```bash
# Terminal 1: Start the orchestrator
pnpm dev

# Terminal 2: Start the dashboard
cd packages/dashboard
pnpm dev
```

### 6. Submit Your First Idea

**Via CLI:**
```bash
pnpm submit "Build a todo app with React and Express"
```

**Via Dashboard:**
Open `http://localhost:3000` and use the "Submit an Idea" form.

**Via Slack:**
Message in `#agency-ceo-investor`:
> build me a recipe sharing app with user accounts and a nice UI

## Project Structure

```
claude-agency/
├── packages/
│   ├── orchestrator/          # Core engine
│   │   └── src/
│   │       ├── index.ts               # Main entry, wires everything
│   │       ├── agent-manager.ts       # Spawns/manages Claude Code agents
│   │       ├── scheduler.ts           # Autonomous loop, break recovery
│   │       ├── workflow-engine.ts      # CEO→Architect→Approval flows
│   │       ├── task-board.ts          # Task state machine
│   │       ├── task-router.ts         # Routes ideas to CEO
│   │       ├── hr-manager.ts          # Dynamic agent creation
│   │       ├── permission-engine.ts   # Blacklist + role rules
│   │       ├── state-store.ts         # MySQL operations
│   │       ├── memory-manager.ts      # Dual-layer memory
│   │       ├── api-server.ts          # REST API for dashboard
│   │       ├── ws-server.ts           # WebSocket for real-time
│   │       ├── types.ts              # Shared type definitions
│   │       └── config/
│   │           ├── agency.config.ts   # Env-based configuration
│   │           ├── blacklist.ts       # Permission rules
│   │           └── blueprints/        # Agent role definitions
│   │               ├── ceo.ts         # Alice
│   │               ├── hr.ts          # Bob
│   │               ├── architect.ts   # Charlie
│   │               ├── pm.ts          # Diana
│   │               ├── developer.ts   # Eve
│   │               ├── designer.ts    # Frank
│   │               └── researcher.ts  # Grace
│   ├── slack-bridge/          # Slack integration
│   │   └── src/
│   │       ├── bot.ts                 # Slack bot + event handling
│   │       ├── channels.ts           # Channel management
│   │       ├── message-formatter.ts   # Agent message styling
│   │       └── setup.ts              # Slack setup wizard
│   └── dashboard/             # Next.js web UI
│       └── src/
│           ├── app/
│           │   ├── page.tsx           # KPI overview + submit ideas
│           │   ├── agents/            # Agent roster + detail view
│           │   ├── projects/          # Project board + progress
│           │   ├── approvals/         # Approval queue
│           │   └── settings/          # Blacklist + config editor
│           ├── components/            # Reusable UI components
│           └── lib/                   # WebSocket client, API helpers
├── data/
│   ├── blueprints/            # HR-created custom agent blueprints
│   └── knowledge-base/        # Shared company knowledge (markdown)
├── workspace/                 # Project working directories
├── docker-compose.yml         # For server deployment
├── Dockerfile
└── .env.example
```

## Agent Blueprints

Each agent is defined by a blueprint — a TypeScript/JSON file specifying their role, system prompt, permissions, KPIs, and communication style.

### Default Team

| Agent | Role | Personality |
|-------|------|-------------|
| **Alice** | CEO | Decisive, direct. Evaluates ideas, delegates work, tracks KPIs. Reports to you. |
| **Bob** | HR Manager | Friendly, organized. Creates new agent roles, manages the roster. |
| **Charlie** | Software Architect | Opinionated, practical. Designs systems, chooses tech stacks, reviews architecture. |
| **Diana** | Tech Lead / PM | Organized, action-oriented. Breaks plans into sprints, assigns tasks, reviews work. |
| **Eve** | Senior Developer | Casual, competent. Implements features, fixes bugs, writes tests. |
| **Frank** | UI/UX Designer | Creative, concise. Designs components, layouts, and user flows. |
| **Grace** | Researcher | Smart, practical. Researches technologies, writes docs, makes recommendations. |

### Creating New Agents

The CEO can ask Bob (HR) to hire new agents. HR forks an existing blueprint and customizes it:

```
You → Alice: "we need a DevOps person for deployments"
Alice → Bob: "hire a DevOps engineer, fork from the developer blueprint"
Bob creates the blueprint, onboards the new agent
Bob → #agency-hr-hiring: "hired Dave as DevOps Engineer. he's ready to go"
```

Custom blueprints are saved to `data/blueprints/` and persist across restarts.

## Permission System

Three layers of control:

### Global Blacklist
Commands no agent can run, regardless of role:
- `rm -rf /`, `DROP DATABASE`, `git push --force origin main`, `shutdown`, etc.

### Role-Based Rules
Different roles have different restrictions:
- **Designer** can't touch backend/API code
- **Researcher** can't push to git
- **HR** can only access blueprint files

### Temporary Overrides
Managers can grant one-time permission overrides for specific tasks, with expiry.

Edit rules via the dashboard Settings page or directly in `config/blacklist.ts`.

## Dashboard

The dashboard at `http://localhost:3000` provides layered drill-down:

**Investor level (default):**
- KPI cards: active agents, breaks, tasks completed, pending approvals
- Team grid with real-time status
- Activity feed
- Submit ideas directly

**Drill-down:**
- Click an agent → see their current task, logs, channels, KPIs
- Click a project → task board with progress bar, status breakdown
- Approvals page → approve/reject plans with one click
- Settings → edit blacklist, concurrency, connection info

## Deployment

### Local (macOS/Linux)
Just run `pnpm dev` as described above.

### Server (Docker Compose)

```bash
# Copy and edit your env file
cp .env.example .env
# Edit .env with your MySQL password, Slack tokens, etc.

# Start everything
docker compose up -d

# The dashboard is at http://your-server:3000
# Interact via Slack from anywhere
```

## Configuration

All configuration is via environment variables (`.env` file):

| Variable | Default | Description |
|----------|---------|-------------|
| `MYSQL_HOST` | `localhost` | MySQL host |
| `MYSQL_PORT` | `3306` | MySQL port |
| `MYSQL_USER` | `claude_agency` | MySQL user |
| `MYSQL_PASSWORD` | — | MySQL password |
| `MYSQL_DATABASE` | `claude_agency` | MySQL database name |
| `SLACK_BOT_TOKEN` | — | Slack bot token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | — | Slack signing secret |
| `SLACK_APP_TOKEN` | — | Slack app token (`xapp-...`) |
| `WORKSPACE_DIR` | `./workspace` | Where project files are created |
| `MAX_CONCURRENCY` | `5` | Max agents working simultaneously |
| `DASHBOARD_PORT` | `3000` | Dashboard web UI port |
| `WS_PORT` | `3001` | WebSocket port (API is WS_PORT + 1) |

## How Agents Communicate

All agents write like real coworkers on Slack — short, casual, human:

> **Alice (CEO):** got it, let me break this down and get the team on it
>
> **Charlie (Architect):** I'd go with next.js + postgres for this. simple and solid
>
> **Eve (Developer):** done with the auth module. pushing now
>
> **Diana (PM):** sprint looks good. eve is on the backend, frank is doing the UI
>
> **Bob (HR):** hired a new frontend dev — Hank. he's in the project channel

This isn't just for aesthetics — it drastically reduces token usage compared to typical verbose AI output.

## Contributing

This is an early-stage project. Contributions welcome in these areas:

- **More agent blueprints** — QA engineer, data analyst, security auditor, etc.
- **Dashboard improvements** — Real-time task board, agent log viewer, KPI charts
- **Memory system** — Better context injection, semantic search over knowledge base
- **Multi-model support** — Mix Claude models (Haiku for simple tasks, Opus for complex)
- **Git integration** — Auto-create branches, PRs, code reviews between agents
- **Cost tracking** — Track token usage per agent, per project

## License

MIT

## Credits

Built with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) by Anthropic.
