<p align="center">
  <h1 align="center">Multi-Cloud DB Manager</h1>
  <p align="center">
    A web-based PostgreSQL management tool for querying multiple database instances across cloud providers simultaneously.
    <br /><br />
    <a href="#quick-start">Quick Start</a> &middot; <a href="#features">Features</a> &middot; <a href="backend/CONFIG.md">Configuration Guide</a> &middot; <a href="#api-reference">API Reference</a>
  </p>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-green.svg" alt="Node">
  <img src="https://img.shields.io/badge/PostgreSQL-12%2B-336791.svg" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6.svg" alt="TypeScript">
  <img src="https://img.shields.io/badge/React-18-61DAFB.svg" alt="React">
</p>

---

## Why Multi-Cloud DB Manager?

Managing PostgreSQL across AWS, GCP, or any cloud means juggling connections, credentials, and comparing results manually. This tool gives you **one UI to query them all** — run the same SQL on every cloud at once, compare results side-by-side, and maintain a full audit trail with role-based access control.

**Use cases:**
- Compare data across cloud replicas after migration
- Run simultaneous health checks on all database instances
- Execute schema changes across environments in one shot
- Audit query history across your team with role-based permissions

---

## Features

### Core

| Feature | Description |
|---------|-------------|
| **Multi-cloud execution** | Query all clouds simultaneously or target a specific one |
| **Dynamic configuration** | Add clouds and databases via JSON config — zero code changes |
| **Async query engine** | Non-blocking execution with progress tracking (`Statement 2 of 5`) and cancellation |
| **Multi-statement support** | Execute batches separated by `;` with per-statement results and auto-rollback |
| **Role-based access** | Three roles (MASTER / USER / READER) with granular SQL operation control |
| **Password-protected ops** | DROP, TRUNCATE, DELETE, ALTER require MASTER password verification |
| **Query history & audit** | Full execution log with filtering by user, database, status, and pagination |
| **Environment variable substitution** | Use `${VAR_NAME}` in database config for secure credential management |

### SQL Editor

| Feature | Description |
|---------|-------------|
| **Monaco Editor** | VS Code's editor engine with PostgreSQL syntax highlighting |
| **SQL formatting** | One-click format with PostgreSQL dialect, uppercase keywords |
| **Auto-save** | Drafts saved every 5 seconds to localStorage with restore on reload |
| **Keyboard shortcuts** | `Cmd/Ctrl+Enter` to execute |
| **Dark theme** | Full dark mode UI |

### Results

| Feature | Description |
|---------|-------------|
| **Side-by-side cloud results** | Color-coded expandable sections per cloud |
| **Table and JSON views** | Toggle between formatted table and raw JSON |
| **CSV / JSON export** | Download results per cloud |
| **Per-statement breakdown** | Individual results for each statement in a batch |
| **Execution timing** | Duration in milliseconds per cloud |

### User Management (MASTER only)

| Feature | Description |
|---------|-------------|
| **User registration** | Self-service signup, requires MASTER activation |
| **Activate / deactivate** | Enable or disable user accounts |
| **Role assignment** | Promote or demote users between MASTER / USER / READER |
| **User search** | Search users by username, name, or email |
| **User deletion** | Remove accounts (cannot delete MASTER users) |

---

### Role Permissions

| Operation | MASTER | USER | READER |
|-----------|:------:|:----:|:------:|
| SELECT | Yes | Yes | Yes |
| INSERT / UPDATE | Yes | Yes | - |
| CREATE TABLE / INDEX | Yes | Yes | - |
| ALTER TABLE (ADD) | Yes | Yes | - |
| DELETE | Yes (pwd) | - | - |
| DROP / TRUNCATE | Yes (pwd) | - | - |
| ALTER DROP | Yes (pwd) | - | - |
| User management | Yes | - | - |
| Cancel any user's query | Yes | - | - |

**Blocked for all roles:** DROP/CREATE DATABASE, DROP/CREATE SCHEMA, GRANT, REVOKE, ALTER/CREATE/DROP ROLE/USER

---

## Architecture

```
┌──────────────────────┐
│      Frontend        │  React 18 + TypeScript + Material-UI
│   Nginx (port 80)    │  Monaco Editor + Zustand state
└──────────┬───────────┘
           │ REST API
┌──────────▼───────────┐
│      Backend         │  Express + TypeScript
│    Node (port 3000)  │  Winston logging + Zod validation
└───┬──────┬───────────┘
    │      │
┌───▼──┐  ┌▼──────────────────────────────┐
│ Redis │  │     PostgreSQL Instances       │
│      │  │  Cloud 1 ── DB1, DB2, ...     │
│      │  │  Cloud 2 ── DB1, DB2, ...     │
│      │  │  Cloud N ── ...               │
└──────┘  └────────────────────────────────┘
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18, TypeScript, Material-UI, Monaco Editor, Zustand, Axios, Vite |
| **Backend** | Node.js, Express, TypeScript, node-postgres (pg), Zod, Winston, Helmet |
| **Data** | PostgreSQL 12+, Redis 6+ (sessions + execution state) |
| **Deployment** | Docker (multi-stage), Kubernetes, Nginx |

### Key Design Decisions

- **Redis** stores user sessions (shared across backend replicas) and async query execution state
- **Backend is stateless** — horizontally scalable behind a load balancer
- **Frontend** is a Nginx-served SPA with runtime backend URL injection (no rebuild needed per environment)
- **Connection pooling**: 2-20 connections per database, 30s idle timeout, 10s connect timeout
- **Session**: HTTP-only secure cookies, 7-day expiry, Redis-backed

---

## Quick Start

### Prerequisites

- **Node.js** 18+
- **PostgreSQL** 12+ (at least one instance to manage)
- **Redis** 6+

### 1. Clone and install

```bash
git clone https://github.com/vijaygupta18/Multi-Cloud-DB-Manager.git
cd Multi-Cloud-DB-Manager

# Backend
cd backend && npm install

# Frontend
cd ../frontend && npm install
```

### 2. Configure databases

Create `backend/config/databases.json`:

```jsonc
{
  "primary": {
    "cloudName": "cloud1",
    "db_configs": [
      {
        "name": "mydb",
        "label": "My Database",
        "host": "localhost",
        "port": 5432,
        "user": "postgres",
        "password": "password",
        "database": "mydb",
        "schemas": ["public"],
        "defaultSchema": "public"
      }
    ]
  },
  "secondary": [
    {
      "cloudName": "cloud2",
      "db_configs": [
        {
          "name": "mydb",
          "label": "My Database",
          "host": "remote-host",
          "port": 5432,
          "user": "postgres",
          "password": "${CLOUD2_DB_PASSWORD}",
          "database": "mydb",
          "schemas": ["public"],
          "defaultSchema": "public"
        }
      ]
    }
  ],
  "history": {
    "host": "localhost",
    "port": 5432,
    "user": "postgres",
    "password": "password",
    "database": "mydb"
  }
}
```

- **primary**: Your main cloud. Must have exactly one entry.
- **secondary**: Array of additional clouds. Add as many as you need, or leave as `[]`.
- **history**: Database where users and query audit trail are stored (can reuse an existing database).
- Use `${ENV_VAR}` syntax for secrets — values are substituted from `.env` at startup.

> See [backend/CONFIG.md](backend/CONFIG.md) for the full configuration reference.

### 3. Set environment variables

Create `backend/.env`:

```env
PORT=3000
NODE_ENV=development
REDIS_HOST=localhost
REDIS_PORT=6379
SESSION_SECRET=change-this-to-a-long-random-string
FRONTEND_URL=http://localhost:5173
RUN_MIGRATIONS=true

# Database credential variables referenced in databases.json
CLOUD2_DB_PASSWORD=your-secure-password
```

Create `frontend/.env`:

```env
VITE_API_URL=http://localhost:3000
```

### 4. Start services

```bash
# Terminal 1: Redis
redis-server

# Terminal 2: Backend
cd backend && npm run dev

# Terminal 3: Frontend
cd frontend && npm run dev
```

Open **http://localhost:5173**

### 5. Create your first admin

1. Register a new account via the login page
2. Promote yourself to MASTER:

```sql
UPDATE dual_db_manager.users
SET role = 'MASTER', is_active = true
WHERE username = 'your-username';
```

3. Log out and log back in. You now have full access.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Backend server port |
| `NODE_ENV` | `development` | `development` or `production` |
| `REDIS_HOST` | `localhost` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | — | Redis password (optional) |
| `SESSION_SECRET` | — | **Required.** Random string for session encryption |
| `FRONTEND_URL` | `http://localhost:5173` | CORS allowed origin |
| `MAX_QUERY_TIMEOUT_MS` | `300000` | Overall query timeout (5 min) |
| `STATEMENT_TIMEOUT_MS` | `300000` | Per-statement PostgreSQL timeout (5 min) |
| `REDIS_EXECUTION_TTL_SECONDS` | `300` | Async execution state TTL in Redis (5 min) |
| `RUN_MIGRATIONS` | `false` | Auto-create `dual_db_manager` schema on startup |

---

## Database Schema

Migrations auto-create (when `RUN_MIGRATIONS=true`) or run manually with `npm run migrate`:

### `dual_db_manager.users`

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| username | VARCHAR(255) | Unique login name |
| password_hash | TEXT | bcrypt hash |
| email | VARCHAR(255) | Unique email |
| name | VARCHAR(255) | Display name |
| role | VARCHAR(50) | `MASTER`, `USER`, or `READER` |
| is_active | BOOLEAN | Account enabled (default: false) |
| created_at | TIMESTAMP | Registration time |

### `dual_db_manager.query_history`

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| user_id | UUID | Foreign key to users |
| query | TEXT | Executed SQL |
| database_name | VARCHAR(50) | Target database |
| execution_mode | VARCHAR(50) | `both` or specific cloud name |
| cloud_results | JSONB | Per-cloud results with success, duration, rows |
| created_at | TIMESTAMP | Execution time |

---

## Docker

Both services use multi-stage builds for minimal image size.

```bash
# Build (use --platform linux/amd64 if deploying to x86 servers from ARM machines)
docker build --platform linux/amd64 -t multi-cloud-db-backend ./backend
docker build --platform linux/amd64 -t multi-cloud-db-frontend ./frontend

# Run backend
docker run -p 3000:3000 \
  --env-file backend/.env \
  multi-cloud-db-backend

# Run frontend (BACKEND_URL injected at runtime — no rebuild needed per environment)
docker run -p 80:80 \
  -e BACKEND_URL=http://your-backend:3000 \
  multi-cloud-db-frontend
```

**Health checks are built in:**
- Backend: `GET /health` (HTTP on port 3000)
- Frontend: `GET /` (HTTP on port 80)

---

## Kubernetes

Manifests in `k8s/`:

| File | Description |
|------|-------------|
| `backend.yaml` | Backend Deployment (2 replicas) + Service + liveness/readiness probes |
| `frontend.yaml` | Frontend Deployment (2 replicas) + Nginx ConfigMap + Service |
| `secrets.yaml.example` | Template for secrets (copy to `secrets.yaml` and fill in) |

```bash
cp k8s/secrets.yaml.example k8s/secrets.yaml
# Edit secrets.yaml with base64-encoded values
kubectl apply -f k8s/
```

**Deployment defaults:**
- Rolling updates (25% maxSurge, 25% maxUnavailable)
- Backend: 200m CPU / 256Mi memory request, 500m / 512Mi limits
- Frontend: 50m CPU / 64Mi memory request, 100m / 128Mi limits
- Session affinity (ClientIP) for consistent session routing

---

## API Reference

### Authentication (`/api/auth`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/auth/register` | — | Register new user (inactive by default) |
| `POST` | `/api/auth/login` | — | Login with username + password |
| `GET` | `/api/auth/me` | User | Get current authenticated user |
| `POST` | `/api/auth/logout` | User | Logout and destroy session |
| `GET` | `/api/auth/users` | Master | List all users |
| `GET` | `/api/auth/users/search?q=term` | Master | Search users by username, name, or email |
| `POST` | `/api/auth/activate` | Master | Activate user accounts |
| `POST` | `/api/auth/deactivate` | Master | Deactivate user accounts |
| `POST` | `/api/auth/change-role` | Master | Change user role (MASTER/USER/READER) |
| `POST` | `/api/auth/delete` | Master | Delete a user account |

### Query Execution (`/api/query`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/query/execute` | User | Execute query (async) — returns `executionId` |
| `GET` | `/api/query/status/:id` | User | Poll execution status and results |
| `POST` | `/api/query/cancel/:id` | User | Cancel a running query (own queries, or any as MASTER) |
| `GET` | `/api/query/active` | User | List active executions |
| `POST` | `/api/query/validate` | User | Validate SQL syntax without executing |

### History (`/api/history`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/history` | User | Query history with filters (`database`, `user_id`, `success`, `limit`, `offset`) |
| `GET` | `/api/history/:id` | User | Get specific execution details |

### Schema (`/api/schemas`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/schemas/configuration` | User | Full database + cloud configuration |
| `GET` | `/api/schemas/:database?cloud=` | User | Schemas for a specific database |

### Health

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | — | Returns `{ status: "ok", timestamp, uptime }` |

---

## Security

| Layer | Implementation |
|-------|---------------|
| **SQL injection** | Parameterized queries throughout — no string concatenation |
| **Authentication** | Session-based with HTTP-only secure cookies (no JWT tokens to leak) |
| **Password storage** | bcrypt with 10 salt rounds |
| **Authorization** | Role-based middleware on every route |
| **Dangerous queries** | Server-side validation + client-side warnings + password verification |
| **Session storage** | Redis-backed, 7-day expiry, SameSite cookies |
| **HTTP headers** | Helmet (X-Frame-Options, X-Content-Type-Options, X-XSS-Protection) |
| **CORS** | Whitelist configured origins only |
| **Query timeouts** | Configurable per-statement and overall timeouts |
| **Blocked operations** | DROP/CREATE DATABASE/SCHEMA, GRANT/REVOKE, ALTER/CREATE/DROP ROLE/USER — blocked for all roles |

---

## Development

### Available Scripts

**Backend** (`cd backend`):

| Command | Description |
|---------|-------------|
| `npm run dev` | Start with hot reload (nodemon + tsx, port 3000) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run production build |
| `npm run lint` | Lint with ESLint |
| `npm test` | Run tests with Vitest |

**Frontend** (`cd frontend`):

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server (port 5173) |
| `npm run build` | Type-check + production build |
| `npm run preview` | Preview production build locally |
| `npm run lint` | Lint with ESLint |

### Project Structure

```
dual-db-manager/
├── backend/
│   ├── config/
│   │   └── databases.json          # Database connection config
│   ├── migrations/
│   │   └── 001_prod_schema.sql     # Schema migrations
│   ├── src/
│   │   ├── config/
│   │   │   └── database.ts         # Connection pool management
│   │   ├── controllers/            # Route handlers
│   │   ├── middleware/              # Auth, validation, error handling
│   │   ├── routes/                 # Express routes
│   │   ├── services/               # Query execution, history, validation
│   │   ├── types/                  # TypeScript interfaces
│   │   ├── utils/                  # Logger
│   │   └── server.ts               # Entry point
│   ├── Dockerfile
│   └── CONFIG.md                   # Configuration reference
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Dialog/             # Warning/confirmation dialogs
│   │   │   ├── Editor/             # Monaco SQL editor
│   │   │   ├── History/            # Query history sidebar
│   │   │   ├── Results/            # Multi-cloud results panel
│   │   │   └── Selector/           # Database/schema/mode selector
│   │   ├── hooks/                  # Auto-save hook
│   │   ├── pages/                  # Login, Console, Users
│   │   ├── services/               # API client, query validation
│   │   ├── store/                  # Zustand state management
│   │   └── types/                  # TypeScript interfaces
│   ├── nginx.conf                  # Production Nginx config
│   └── Dockerfile
├── k8s/                            # Kubernetes manifests
│   ├── backend.yaml
│   ├── frontend.yaml
│   └── secrets.yaml.example
├── LICENSE
└── README.md
```

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run linting: `cd backend && npm run lint` and `cd frontend && npm run lint`
5. Commit: `git commit -m 'Add my feature'`
6. Push: `git push origin feature/my-feature`
7. Open a Pull Request

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

Built for teams managing PostgreSQL across multiple clouds.
