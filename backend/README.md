# Multi-Cloud DB Manager — Backend

Express + TypeScript backend for executing SQL queries across multiple PostgreSQL instances and cloud providers simultaneously.

## Tech Stack

| Technology | Purpose |
|-----------|---------|
| Node.js 18+ | Runtime |
| TypeScript 5 | Type safety |
| Express 4 | HTTP framework |
| node-postgres (pg) | Database driver with connection pooling |
| Redis 6+ | Session storage + async execution state |
| Zod | Request validation |
| Winston | Structured logging with rotation |
| Helmet | Security headers |
| bcryptjs | Password hashing |

## Project Structure

```
backend/
├── config/
│   ├── databases.json              # Database connections (gitignored)
│   └── databases.example.json      # Template
├── migrations/
│   └── 001_prod_schema.sql         # Schema migrations
├── src/
│   ├── config/
│   │   ├── database.ts             # DatabasePools singleton, connection pooling
│   │   └── config-loader.ts        # JSON config loader with ${ENV_VAR} substitution
│   ├── controllers/
│   │   ├── auth.controller.ts      # Login, register, user management, search
│   │   ├── query.controller.ts     # Async query execution, cancellation, status
│   │   ├── history.controller.ts   # Query history retrieval with filters
│   │   └── schema.controller.ts    # Database configuration endpoint
│   ├── middleware/
│   │   ├── auth.middleware.ts      # isAuthenticated, requireMaster, validateQueryPermissions
│   │   ├── validation.middleware.ts # Zod request schemas
│   │   └── error.middleware.ts     # Global error handler, 404 handler
│   ├── routes/
│   │   ├── auth.routes.ts          # /api/auth/*
│   │   ├── query.routes.ts         # /api/query/*
│   │   ├── history.routes.ts       # /api/history/*
│   │   └── schema.routes.ts        # /api/schemas/*
│   ├── services/
│   │   ├── query/
│   │   │   ├── QueryExecutor.ts    # Multi-cloud parallel execution
│   │   │   └── QueryValidator.ts   # Dangerous query detection, blocked operations
│   │   └── history.service.ts      # Query logging and retrieval
│   ├── types/
│   │   └── index.ts                # TypeScript interfaces
│   ├── utils/
│   │   └── logger.ts               # Winston config (console + file transports)
│   └── server.ts                   # Entry point: Express app, Redis, middleware
├── Dockerfile                      # Multi-stage production build
├── CONFIG.md                       # Database configuration guide
├── .env                            # Environment variables (gitignored)
└── package.json
```

## Setup

### 1. Install

```bash
cd backend
npm install
```

### 2. Configure databases

```bash
cp config/databases.example.json config/databases.json
```

Edit `config/databases.json` with your database connections. Use `${ENV_VAR}` for secrets. See [CONFIG.md](CONFIG.md) for full reference.

### 3. Environment

Create `.env`:

```env
PORT=3000
NODE_ENV=development
REDIS_HOST=localhost
REDIS_PORT=6379
SESSION_SECRET=change-this-to-a-random-string
FRONTEND_URL=http://localhost:5173
RUN_MIGRATIONS=true

# Referenced by databases.json
DB_PASSWORD=your-password
```

### 4. Run

```bash
# Development (hot reload via nodemon + tsx)
npm run dev

# Production
npm run build && npm start
```

Server starts on **http://localhost:3000**

### 5. First admin user

Register via the frontend UI, then promote:

```sql
UPDATE dual_db_manager.users
SET role = 'MASTER', is_active = true
WHERE username = 'your-username';
```

## API Endpoints

### Health

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | — | `{ status: "ok", timestamp, uptime }` |

### Authentication (`/api/auth`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/register` | — | Register (inactive by default, needs MASTER activation) |
| `POST` | `/login` | — | Login, returns user + sets session cookie |
| `GET` | `/me` | User | Current authenticated user |
| `POST` | `/logout` | User | Destroy session |
| `GET` | `/users` | Master | List all users |
| `GET` | `/users/search?q=term&limit=10` | Master | Search by username, name, or email (ILIKE) |
| `POST` | `/activate` | Master | Activate users: `{ usernames: ["user1"] }` |
| `POST` | `/deactivate` | Master | Deactivate users: `{ usernames: ["user1"] }` |
| `POST` | `/change-role` | Master | `{ username, role: "MASTER"|"USER"|"READER" }` |
| `POST` | `/delete` | Master | Delete user: `{ username }` |

### Query Execution (`/api/query`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/execute` | User | Async execute — returns `{ executionId }` |
| `GET` | `/status/:id` | User | Poll status: running/completed/failed + results |
| `POST` | `/cancel/:id` | User | Cancel (own queries, or any as MASTER) |
| `GET` | `/active` | User | List active executions |
| `POST` | `/validate` | User | Syntax check without executing |

**Execute request body:**
```json
{
  "query": "SELECT * FROM users LIMIT 10",
  "database": "mydb",
  "mode": "both",
  "pgSchema": "public",
  "timeout": 30000,
  "continueOnError": false
}
```

### History (`/api/history`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/` | User | Paginated history. Params: `database`, `user_id`, `success`, `limit`, `offset` |
| `GET` | `/:id` | User | Single execution details |

### Schema (`/api/schemas`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/configuration` | User | Full database + cloud config for frontend |
| `GET` | `/:database?cloud=` | User | Schemas for a specific database |

## Role-Based Access Control

Permission checks happen in `auth.middleware.ts` → `validateQueryPermissions`:

| Operation | MASTER | USER | READER |
|-----------|:------:|:----:|:------:|
| SELECT | Yes | Yes | Yes |
| INSERT / UPDATE | Yes | Yes | — |
| CREATE TABLE / INDEX | Yes | Yes | — |
| ALTER TABLE ADD | Yes | Yes | — |
| DELETE | Yes (password) | — | — |
| DROP / TRUNCATE | Yes (password) | — | — |
| ALTER DROP | Yes (password) | — | — |

**Blocked for all roles:** DROP/CREATE DATABASE/SCHEMA, GRANT/REVOKE, ALTER/CREATE/DROP ROLE/USER

**Password verification:** MASTER must re-enter password for destructive operations (DELETE, DROP, TRUNCATE, ALTER DROP). Validated via bcrypt in `query.controller.ts`.

## Database Schema

Created by `migrations/001_prod_schema.sql` (runs when `RUN_MIGRATIONS=true`):

```sql
-- dual_db_manager.users
id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
username        VARCHAR(255) UNIQUE NOT NULL
password_hash   TEXT NOT NULL
email           VARCHAR(255) UNIQUE NOT NULL
name            VARCHAR(255) NOT NULL
role            VARCHAR(50) CHECK (role IN ('MASTER', 'USER', 'READER'))
is_active       BOOLEAN DEFAULT false
picture         TEXT
created_at      TIMESTAMP DEFAULT NOW()

-- dual_db_manager.query_history
id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
user_id         UUID REFERENCES users(id) ON DELETE CASCADE
query           TEXT NOT NULL
database_name   VARCHAR(50) NOT NULL
execution_mode  VARCHAR(50) NOT NULL
cloud_results   JSONB NOT NULL DEFAULT '{}'
created_at      TIMESTAMP DEFAULT NOW()
```

## Connection Pooling

Configured in `src/config/database.ts`:

| Setting | Value |
|---------|-------|
| Min connections | 2 per database |
| Max connections | 20 per database |
| Idle timeout | 30s |
| Connection timeout | 10s |
| Statement timeout | 300s (configurable) |

## Async Query Execution

Queries execute asynchronously via Redis-backed state:

1. `POST /execute` → stores execution in Redis, returns `executionId`
2. Backend runs query in background across selected clouds
3. Client polls `GET /status/:id` for progress and results
4. Results include per-cloud success/failure, duration, row data
5. Execution state expires after `REDIS_EXECUTION_TTL_SECONDS` (default 300s)

## Logging

Winston with two file transports + console (dev only):

- `logs/error.log` — error level only
- `logs/combined.log` — all levels
- Daily rotation, 14-day retention
- Structured JSON format with timestamps

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `NODE_ENV` | `development` | `development` or `production` |
| `REDIS_HOST` | `localhost` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | — | Redis password (optional) |
| `SESSION_SECRET` | — | **Required.** Session encryption key |
| `FRONTEND_URL` | `http://localhost:5173` | CORS allowed origin |
| `MAX_QUERY_TIMEOUT_MS` | `300000` | Max query timeout (5 min) |
| `STATEMENT_TIMEOUT_MS` | `300000` | Per-statement PostgreSQL timeout |
| `REDIS_EXECUTION_TTL_SECONDS` | `300` | Async execution state TTL in Redis |
| `RUN_MIGRATIONS` | `false` | Auto-create schema on startup |

## Docker

```bash
# Build (use --platform linux/amd64 for x86 servers from ARM machines)
docker build --platform linux/amd64 -t multi-cloud-db-backend .

# Run
docker run -p 3000:3000 --env-file .env multi-cloud-db-backend
```

Multi-stage build: compiles TypeScript in builder stage, runs `node dist/server.js` in production stage with only production dependencies.

Built-in health check: `GET /health` every 30s.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Development with hot reload (nodemon + tsx) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run production build |
| `npm run lint` | ESLint |
| `npm test` | Vitest |

## Security

- Parameterized queries (no SQL injection)
- bcrypt password hashing (10 salt rounds)
- HTTP-only secure session cookies (7-day expiry, SameSite: lax)
- Helmet security headers
- CORS whitelist
- Server-side query validation + dangerous operation detection
- Blocked system operations (DROP DATABASE, GRANT, etc.) for all roles
- Redis-backed sessions (no JWT tokens)
- Trust proxy enabled for load balancers

## License

MIT — see [LICENSE](../LICENSE)
