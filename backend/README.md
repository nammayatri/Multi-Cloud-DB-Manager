# Dual Database Manager - Backend

High-performance Node.js backend service for executing SQL queries across unlimited PostgreSQL database instances and cloud providers simultaneously with complete audit trails.

## Features

### Core Capabilities
- **Dynamic Multi-Cloud Execution**: Execute queries across unlimited cloud providers (AWS, GCP, Azure, etc.)
- **JSON-Based Configuration**: Zero-hardcoded databases/clouds, everything configured in `config/databases.json`
- **Connection Pooling**: Optimized PostgreSQL connection pools per database with automatic retry
- **Multi-Statement Support**: Execute multiple SQL statements with transaction handling
- **Query Timeout Protection**: Configurable timeouts prevent runaway queries
- **Query Validation**: Pre-execution syntax validation with detailed error reporting
- **Complete Audit Trail**: All write queries logged to database with full metadata

### User Management
- **Role-Based Access Control (RBAC)**:
  - `MASTER`: Full access including user management and dangerous operations
  - `USER`: Execute write queries (INSERT, UPDATE, DELETE)
  - `READER`: Read-only access (SELECT only)
- **Session Management**: Redis-backed secure sessions with HTTP-only cookies
- **User Activation**: Enable/disable user accounts without deletion
- **Password Security**: bcrypt hashing with salt rounds

### Safety & Reliability
- **Dangerous Query Detection**: Warns on DROP, TRUNCATE, ALTER operations
- **Transaction Management**: Automatic BEGIN/COMMIT/ROLLBACK for multi-statement queries
- **Error Recovery**: Graceful error handling with detailed error messages
- **Graceful Shutdown**: Proper cleanup of database pools and Redis connections
- **Structured Logging**: Winston logger with rotating log files

## Tech Stack

- **Runtime**: Node.js 18+ (LTS)
- **Language**: TypeScript 5
- **Framework**: Express.js 4
- **Database Driver**: node-postgres (pg) with native bindings
- **Session Store**: Redis 6+ via connect-redis
- **Validation**: Zod for request/response validation
- **Logging**: Winston with file rotation
- **Security**: Helmet, CORS, bcrypt
- **Development**: Nodemon with TypeScript compilation

## Architecture

### Service Layer

```
┌─────────────────────────────────────────┐
│         Express Application             │
│  (Routes, Middleware, Controllers)      │
└──────────────┬──────────────────────────┘
               │
    ┌──────────┴──────────┬───────────────┐
    │                     │               │
┌───▼─────┐      ┌────────▼────┐   ┌─────▼────────┐
│  Query  │      │   History   │   │     Auth     │
│ Service │      │   Service   │   │   Service    │
└───┬─────┘      └─────────────┘   └──────────────┘
    │
┌───▼──────────┐
│ DatabasePools│ (Singleton)
│  - Cloud1 DB1│
│  - Cloud1 DB2│
│  - Cloud2 DB1│
│  - Cloud2 DB2│
│  - ...       │
│  - History   │
└──────────────┘
```

### Configuration Flow

```
1. Startup → Load config/databases.json
2. Substitute ${ENV_VARS} with values from .env
3. Parse JSON and validate structure
4. Create connection pools for each database
5. Initialize history schema (if RUN_MIGRATIONS=true)
6. Start Express server
```

## Project Structure

```
backend/
├── src/
│   ├── config/
│   │   ├── database.ts              # DatabasePools singleton
│   │   └── config-loader.ts         # JSON config loader with env substitution
│   ├── controllers/
│   │   ├── auth.controller.ts       # Authentication endpoints
│   │   ├── query.controller.ts      # Query execution endpoints
│   │   ├── history.controller.ts    # Query history endpoints
│   │   └── schema.controller.ts     # Database configuration endpoints
│   ├── services/
│   │   ├── query.service.ts         # Multi-cloud query execution logic
│   │   ├── history.service.ts       # Query history logging and retrieval
│   │   └── validation.service.ts    # Query syntax validation
│   ├── middleware/
│   │   ├── auth.middleware.ts       # Authentication and authorization
│   │   ├── validation.middleware.ts # Zod request validation
│   │   ├── role.middleware.ts       # Role-based access control
│   │   └── error.middleware.ts      # Global error handling
│   ├── routes/
│   │   ├── auth.routes.ts           # /api/auth/* routes
│   │   ├── query.routes.ts          # /api/query/* routes
│   │   ├── history.routes.ts        # /api/history/* routes
│   │   └── schema.routes.ts         # /api/schemas/* routes
│   ├── types/
│   │   └── index.ts                 # TypeScript type definitions
│   ├── utils/
│   │   └── logger.ts                # Winston logger configuration
│   ├── migrations/
│   │   └── init-schema.sql          # Initial database schema
│   └── server.ts                    # Express app entry point
├── config/
│   ├── databases.json               # Main configuration (not in git)
│   └── databases.example.json       # Configuration template
├── logs/
│   ├── error.log                    # Error-level logs
│   └── combined.log                 # All logs
├── .env                             # Environment variables (not in git)
├── .env.example                     # Environment template
├── tsconfig.json                    # TypeScript configuration
├── package.json                     # Dependencies
├── Dockerfile                       # Multi-stage production build
└── README.md
```

## Setup

### Prerequisites

- **Node.js 18+** and npm
- **PostgreSQL 12+** - At least one database to manage
- **Redis 6+** - For session storage

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Configure Databases

Create `config/databases.json` from the example:

```bash
cp config/databases.example.json config/databases.json
```

Edit `config/databases.json` with your database configurations. See [CONFIG.md](CONFIG.md) for detailed configuration options.

**Example Configuration**:
```json
{
  "primary": {
    "cloudName": "aws",
    "db_configs": [
      {
        "name": "db1",
        "label": "Production Database",
        "host": "${AWS_DB_HOST}",
        "port": 5432,
        "user": "${AWS_DB_USER}",
        "password": "${AWS_DB_PASSWORD}",
        "database": "myapp",
        "schemas": ["public", "app_schema"],
        "defaultSchema": "public"
      }
    ]
  },
  "secondary": [
    {
      "cloudName": "gcp",
      "db_configs": [
        {
          "name": "db1",
          "label": "Replica Database",
          "host": "${GCP_DB_HOST}",
          "port": 5432,
          "user": "${GCP_DB_USER}",
          "password": "${GCP_DB_PASSWORD}",
          "database": "myapp",
          "schemas": ["public"],
          "defaultSchema": "public"
        }
      ]
    }
  ],
  "history": {
    "host": "${AWS_DB_HOST}",
    "port": 5432,
    "user": "${AWS_DB_USER}",
    "password": "${AWS_DB_PASSWORD}",
    "database": "myapp"
  }
}
```

### 3. Configure Environment

Create `.env` file:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
# Server
PORT=3000
NODE_ENV=development

# Redis (Session Storage)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Session Secret (CHANGE THIS!)
SESSION_SECRET=your-secret-key-change-this-in-production

# Frontend URL (for CORS)
FRONTEND_URL=http://localhost:5173

# Query Settings
MAX_QUERY_TIMEOUT_MS=300000

# Database Migrations
RUN_MIGRATIONS=true

# Database Credentials (referenced in databases.json)
AWS_DB_HOST=localhost
AWS_DB_USER=postgres
AWS_DB_PASSWORD=postgres
AWS_DB_NAME=myapp

GCP_DB_HOST=localhost
GCP_DB_USER=postgres
GCP_DB_PASSWORD=postgres
GCP_DB_NAME=myapp
```

### 4. Initialize Database Schema

Run migrations to create the `dual_db_manager` schema:

```bash
npm run migrate
```

This creates:
- `dual_db_manager.users` - User accounts
- `dual_db_manager.query_history` - Query execution history

### 5. Create Admin User

Connect to your history database and create an admin user:

```sql
-- Generate password hash (use bcrypt with 10 rounds)
-- Example: bcryptjs.hashSync('your-password', 10)

INSERT INTO dual_db_manager.users (
  username, email, name, password_hash, role, is_active
) VALUES (
  'admin',
  'admin@example.com',
  'Administrator',
  '$2a$10$YourBcryptHashHere',  -- Replace with actual hash
  'MASTER',
  true
);
```

**Generate Password Hash**:
```bash
node -e "console.log(require('bcryptjs').hashSync('your-password', 10))"
```

### 6. Start Development Server

```bash
npm run dev
```

Backend will run on **http://localhost:3000**

### 7. Verify Setup

```bash
# Health check
curl http://localhost:3000/health

# Configuration endpoint
curl http://localhost:3000/api/schemas/configuration

# Login (replace with your credentials)
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your-password"}'
```

## API Documentation

### Health Check

```
GET /health
```

**Response**:
```json
{
  "status": "ok",
  "timestamp": "2024-01-30T12:00:00.000Z",
  "uptime": 3600
}
```

### Authentication

#### Login
```
POST /api/auth/login
```

**Request Body**:
```json
{
  "username": "admin",
  "password": "password"
}
```

**Response**:
```json
{
  "message": "Login successful",
  "user": {
    "id": 1,
    "username": "admin",
    "email": "admin@example.com",
    "name": "Administrator",
    "role": "MASTER",
    "is_active": true
  }
}
```

#### Get Current User
```
GET /api/auth/me
```

**Response**:
```json
{
  "user": {
    "id": 1,
    "username": "admin",
    "role": "MASTER",
    ...
  }
}
```

#### Logout
```
POST /api/auth/logout
```

#### List Users (MASTER only)
```
GET /api/auth/users
```

**Response**:
```json
{
  "users": [
    {
      "id": 1,
      "username": "admin",
      "email": "admin@example.com",
      "role": "MASTER",
      "is_active": true,
      "created_at": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

#### Activate User (MASTER only)
```
POST /api/auth/activate
```

**Request Body**:
```json
{
  "usernames": ["user1", "user2"]
}
```

#### Deactivate User (MASTER only)
```
POST /api/auth/deactivate
```

**Request Body**:
```json
{
  "usernames": ["user1"]
}
```

#### Change Role (MASTER only)
```
POST /api/auth/change-role
```

**Request Body**:
```json
{
  "username": "user1",
  "role": "USER"
}
```

**Roles**: `MASTER`, `USER`, `READER`

### Query Execution

#### Execute Query
```
POST /api/query/execute
```

**Request Body**:
```json
{
  "query": "SELECT * FROM users LIMIT 10;",
  "database": "db1",
  "mode": "both",
  "pgSchema": "public",
  "timeout": 30000
}
```

**Parameters**:
- `query` (string, required): SQL query to execute
- `database` (string, required): Database name from configuration (e.g., "db1", "db2")
- `mode` (string, required): Execution mode - "both" for all clouds, or specific cloud name (e.g., "aws", "gcp")
- `pgSchema` (string, optional): PostgreSQL schema (default: from database config)
- `timeout` (number, optional): Query timeout in milliseconds (default: 30000, max: 300000)

**Response** (Success):
```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "success": true,
  "aws": {
    "success": true,
    "result": {
      "rows": [
        {"id": 1, "name": "John"},
        {"id": 2, "name": "Jane"}
      ],
      "rowCount": 2,
      "command": "SELECT",
      "fields": [
        {"name": "id", "dataTypeID": 23},
        {"name": "name", "dataTypeID": 1043}
      ]
    },
    "duration_ms": 45,
    "statementCount": 1
  },
  "gcp": {
    "success": true,
    "result": {
      "rows": [
        {"id": 1, "name": "John"},
        {"id": 2, "name": "Jane"}
      ],
      "rowCount": 2,
      "command": "SELECT",
      "fields": [
        {"name": "id", "dataTypeID": 23},
        {"name": "name", "dataTypeID": 1043}
      ]
    },
    "duration_ms": 52,
    "statementCount": 1
  }
}
```

**Response** (Partial Failure):
```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "success": false,
  "aws": {
    "success": true,
    "result": {...},
    "duration_ms": 45
  },
  "gcp": {
    "success": false,
    "error": "relation \"users\" does not exist",
    "duration_ms": 12
  }
}
```

**Multi-Statement Response**:
```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "success": true,
  "aws": {
    "success": true,
    "results": [
      {
        "rows": [...],
        "rowCount": 1,
        "command": "UPDATE"
      },
      {
        "rows": [...],
        "rowCount": 5,
        "command": "SELECT"
      }
    ],
    "duration_ms": 78,
    "statementCount": 2
  }
}
```

#### Validate Query
```
POST /api/query/validate
```

**Request Body**:
```json
{
  "query": "SELECT * FROM users WHERE id = $1"
}
```

**Response**:
```json
{
  "valid": true
}
```

Or if invalid:
```json
{
  "valid": false,
  "error": "syntax error at or near \"SELEC\""
}
```

### Configuration

#### Get Database Configuration
```
GET /api/schemas/configuration
```

**Response**:
```json
{
  "primary": {
    "cloudName": "aws",
    "databases": [
      {
        "name": "db1",
        "label": "Production Database",
        "cloudType": "aws",
        "schemas": ["public", "app_schema"],
        "defaultSchema": "public"
      },
      {
        "name": "db2",
        "label": "Analytics Database",
        "cloudType": "aws",
        "schemas": ["public", "analytics"],
        "defaultSchema": "analytics"
      }
    ]
  },
  "secondary": [
    {
      "cloudName": "gcp",
      "databases": [
        {
          "name": "db1",
          "label": "Replica Database",
          "cloudType": "gcp",
          "schemas": ["public"],
          "defaultSchema": "public"
        }
      ]
    }
  ]
}
```

#### Get Schemas for Database (Legacy)
```
GET /api/schemas/:database?cloud=cloudname
```

**Example**: `GET /api/schemas/db1?cloud=aws`

**Response**:
```json
{
  "schemas": ["public", "app_schema"],
  "default": "public"
}
```

### Query History

#### Get History
```
GET /api/history?database=db1&success=true&limit=50&offset=0
```

**Query Parameters**:
- `database` (string, optional): Filter by database name
- `success` (boolean, optional): Filter by success status
- `limit` (number, optional): Max results (default: 50, max: 100)
- `offset` (number, optional): Pagination offset
- `start_date` (string, optional): ISO 8601 start date
- `end_date` (string, optional): ISO 8601 end date

**Response**:
```json
{
  "data": [
    {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "user_id": 1,
      "query": "UPDATE users SET active = true WHERE id = 1;",
      "database_name": "db1",
      "execution_mode": "both",
      "cloud_results": {
        "aws": {
          "success": true,
          "result": {...},
          "duration_ms": 45
        },
        "gcp": {
          "success": true,
          "result": {...},
          "duration_ms": 52
        }
      },
      "overall_success": true,
      "created_at": "2024-01-30T12:00:00.000Z",
      "user": {
        "username": "admin",
        "name": "Administrator"
      }
    }
  ],
  "total": 150,
  "limit": 50,
  "offset": 0
}
```

#### Get Single Execution
```
GET /api/history/:id
```

**Response**: Same structure as single history item above.

## Database Schema

### Users Table

```sql
CREATE SCHEMA IF NOT EXISTS dual_db_manager;

CREATE TABLE dual_db_manager.users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(10) NOT NULL DEFAULT 'USER',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  last_login TIMESTAMP,
  CONSTRAINT check_role CHECK (role IN ('MASTER', 'USER', 'READER'))
);

CREATE INDEX idx_users_username ON dual_db_manager.users(username);
CREATE INDEX idx_users_email ON dual_db_manager.users(email);
CREATE INDEX idx_users_is_active ON dual_db_manager.users(is_active);
```

### Query History Table

```sql
CREATE TABLE dual_db_manager.query_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER REFERENCES dual_db_manager.users(id),
  query TEXT NOT NULL,
  database_name VARCHAR(100) NOT NULL,
  execution_mode VARCHAR(50) NOT NULL,
  cloud_results JSONB NOT NULL,
  overall_success BOOLEAN NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_query_history_user_id ON dual_db_manager.query_history(user_id);
CREATE INDEX idx_query_history_database ON dual_db_manager.query_history(database_name);
CREATE INDEX idx_query_history_success ON dual_db_manager.query_history(overall_success);
CREATE INDEX idx_query_history_created_at ON dual_db_manager.query_history(created_at DESC);
CREATE INDEX idx_query_history_cloud_results ON dual_db_manager.query_history USING gin(cloud_results);
```

**cloud_results JSONB Structure**:
```json
{
  "aws": {
    "success": true,
    "result": {...},
    "duration_ms": 45
  },
  "gcp": {
    "success": false,
    "error": "connection timeout",
    "duration_ms": 5000
  }
}
```

## Configuration

See [CONFIG.md](CONFIG.md) for comprehensive configuration documentation including:
- JSON configuration structure
- Environment variable substitution
- Adding/removing clouds
- Schema configuration
- Security best practices
- Troubleshooting

## Services

### Query Service (`src/services/query.service.ts`)

Handles multi-cloud query execution:

**Key Methods**:
- `executeDual(request)`: Execute query on selected clouds
- `executeOnDatabase(cloud, database, query, timeout, schema)`: Execute on single database
- `executeStatements(client, statements, timeout)`: Execute multiple SQL statements
- `splitQuery(query)`: Split multi-statement query into individual statements

**Features**:
- Automatic transaction handling for multiple statements
- Per-cloud error handling
- Query timeout enforcement
- Connection pool management
- Duration tracking

### History Service (`src/services/history.service.ts`)

Manages query history logging and retrieval:

**Key Methods**:
- `logExecution(userId, query, database, mode, cloudResults, success)`: Log query execution
- `getHistory(filter)`: Get paginated history with filters
- `getExecutionById(id)`: Get single execution
- `initializeSchema()`: Create database schema on startup

**Features**:
- JSONB storage for flexible cloud results
- User join for username/name display
- Efficient indexing for fast queries
- Pagination support

### Validation Service (`src/services/validation.service.ts`)

Validates SQL query syntax:

**Key Methods**:
- `validateQuery(query)`: Check query syntax without execution

**Features**:
- PostgreSQL-specific validation
- Error message extraction
- No side effects (doesn't execute query)

## Middleware

### Authentication Middleware (`src/middleware/auth.middleware.ts`)

**`isAuthenticated`**: Ensures user is logged in
- Checks session for user_id
- Loads user from database
- Attaches user to `req.user`
- Returns 401 if not authenticated

**`requireAuth`**: Alias for isAuthenticated

### Role Middleware (`src/middleware/role.middleware.ts`)

**`requireRole(role)`**: Ensures user has specific role or higher
- Role hierarchy: MASTER > USER > READER
- MASTER can do everything
- USER can execute write queries
- READER can only execute SELECT queries

### Validation Middleware (`src/middleware/validation.middleware.ts`)

**Zod Schemas**:
- `queryExecutionSchema`: Validates query execution requests
- `validateRequest(schema)`: Generic validation middleware

**Features**:
- Automatic type coercion
- Detailed error messages
- 400 Bad Request on validation failure

### Error Middleware (`src/middleware/error.middleware.ts`)

**`errorHandler`**: Global error handler
- Catches all errors
- Logs to Winston logger
- Returns appropriate HTTP status codes
- Sanitizes error messages in production

**`notFoundHandler`**: 404 handler for undefined routes

## Logging

### Winston Configuration (`src/utils/logger.ts`)

**Log Levels**:
- `error`: Error conditions
- `warn`: Warning conditions
- `info`: Informational messages
- `http`: HTTP request logs
- `debug`: Debug information

**Transports**:
- **File (error.log)**: Error-level logs only
- **File (combined.log)**: All logs
- **Console**: Development only, colored output

**Log Format**:
```
2024-01-30 12:00:00 [info]: Server started on port 3000
2024-01-30 12:00:05 [error]: Database connection failed: connection timeout
```

**Log Rotation**: Logs are rotated daily, kept for 14 days.

## Security

### SQL Injection Prevention
- Parameterized queries throughout
- No string concatenation for SQL
- Query validation before execution

### Password Security
- bcrypt hashing with 10 salt rounds
- Passwords never logged or returned in responses
- Session-based authentication (no JWTs to leak)

### Session Security
- HTTP-only cookies prevent XSS
- Secure flag in production (HTTPS only)
- SameSite attribute prevents CSRF
- Session expiry: 7 days
- Redis-backed session storage

### CORS Configuration
- Whitelist allowed origins
- Credentials allowed for session cookies
- Specific HTTP methods only

### Rate Limiting
- TODO: Implement rate limiting per user/IP
- Recommended: 100 requests/minute

### Helmet Security Headers
- Content Security Policy
- X-Frame-Options
- X-Content-Type-Options
- Referrer-Policy

## Error Handling

### Database Errors
```json
{
  "error": "relation \"users\" does not exist",
  "details": "Query failed on aws: relation \"users\" does not exist"
}
```

### Authentication Errors
```json
{
  "error": "Invalid credentials"
}
```

### Validation Errors
```json
{
  "error": "Validation failed",
  "details": [
    {
      "field": "query",
      "message": "Query cannot be empty"
    }
  ]
}
```

### Authorization Errors
```json
{
  "error": "Insufficient permissions"
}
```

## Development

### Available Scripts

```bash
# Install dependencies
npm install

# Start development server (hot reload)
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Run migrations
npm run migrate

# Lint TypeScript
npm run lint

# Type check
npx tsc --noEmit
```

### Development Workflow

1. Make changes to TypeScript files in `src/`
2. Nodemon automatically recompiles and restarts server
3. Check logs in console for errors
4. Test API endpoints with curl or Postman
5. Commit changes when tests pass

### Adding a New Cloud

1. Update `config/databases.json`:
   ```json
   {
     "secondary": [
       ...,
       {
         "cloudName": "azure",
         "db_configs": [...]
       }
     ]
   }
   ```

2. Add environment variables to `.env`:
   ```env
   AZURE_DB_HOST=azure-host
   AZURE_DB_USER=user
   AZURE_DB_PASSWORD=password
   ```

3. Restart backend: `npm run dev`
4. Verify configuration: `curl http://localhost:3000/api/schemas/configuration`

### Adding a New Database

1. Update `config/databases.json`:
   ```json
   {
     "primary": {
       "db_configs": [
         ...,
         {
           "name": "new_db",
           "label": "New Database",
           ...
         }
       ]
     }
   }
   ```

2. Restart backend
3. New database appears in frontend dropdown automatically

## Production Deployment

### Environment Variables

**Critical Production Settings**:
```env
NODE_ENV=production
SESSION_SECRET=<strong-random-string>
FRONTEND_URL=https://your-frontend-domain.com
REDIS_PASSWORD=<strong-password>
```

### Docker Deployment

**Build Image**:
```bash
cd backend
docker build -t dual-db-manager-backend .
```

**Run Container**:
```bash
docker run -d \
  --name backend \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e REDIS_HOST=redis \
  -e SESSION_SECRET=your-secret \
  --link redis:redis \
  dual-db-manager-backend
```

### Kubernetes Deployment

See `../k8s/backend.yaml` for Kubernetes manifests.

**Key Resources**:
- Deployment: backend pods with health checks
- Service: Internal ClusterIP service
- ConfigMap: databases.json configuration
- Secret: Environment variables with credentials

**Health Checks**:
```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 30
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 5
```

### Database Migrations

**Automatic** (on startup):
```env
RUN_MIGRATIONS=true
```

**Manual**:
```bash
npm run migrate
```

**Rollback**: Manually execute SQL to drop schema:
```sql
DROP SCHEMA IF EXISTS dual_db_manager CASCADE;
```

## Monitoring

### Health Check

```bash
curl http://localhost:3000/health
```

**Response**:
```json
{
  "status": "ok",
  "timestamp": "2024-01-30T12:00:00.000Z",
  "uptime": 3600
}
```

### Metrics to Monitor

1. **Database Connection Pool**:
   - Idle connections
   - Active connections
   - Waiting clients

2. **Query Performance**:
   - Average query duration
   - Query timeout rate
   - Error rate per cloud

3. **Session Storage**:
   - Redis memory usage
   - Session count
   - Session expiry rate

4. **API Performance**:
   - Request rate
   - Response time
   - Error rate

### Log Monitoring

**Log Locations**:
- `logs/error.log` - Error-level logs
- `logs/combined.log` - All logs
- Console (development)

**Log Aggregation**:
- Recommended: ELK Stack (Elasticsearch, Logstash, Kibana)
- Or: Datadog, New Relic, CloudWatch

## Troubleshooting

### Issue: "Pool not found: cloud_db"

**Cause**: Database configuration doesn't match request

**Solution**:
1. Check `config/databases.json` has correct cloud and database names
2. Verify frontend is sending correct database name
3. Restart backend: `npm run dev`

### Issue: "Redis connection failed"

**Cause**: Redis not running or wrong host/port

**Solution**:
1. Start Redis: `redis-server`
2. Check Redis is running: `redis-cli ping` (should return "PONG")
3. Verify `REDIS_HOST` and `REDIS_PORT` in `.env`

### Issue: "relation \"dual_db_manager.users\" does not exist"

**Cause**: Database schema not initialized

**Solution**:
1. Run migrations: `npm run migrate`
2. Or set `RUN_MIGRATIONS=true` in `.env` and restart

### Issue: Query timeout

**Cause**: Query taking too long or database unreachable

**Solution**:
1. Check query is optimized (add indexes, limit results)
2. Increase timeout: `MAX_QUERY_TIMEOUT_MS=600000` (10 minutes)
3. Verify database is reachable: `psql -h host -U user -d database`

### Issue: "Insufficient permissions"

**Cause**: User role doesn't allow operation

**Solution**:
1. Check user role in database: `SELECT role FROM dual_db_manager.users WHERE username = 'user'`
2. Change role if needed (MASTER only):
   ```sql
   UPDATE dual_db_manager.users SET role = 'USER' WHERE username = 'user';
   ```

## Performance Optimization

### Connection Pooling

**Current Settings** (`src/config/database.ts`):
```typescript
{
  min: 2,          // Minimum idle connections
  max: 20,         // Maximum connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 300000  // 5 minutes
}
```

**Tuning**:
- Increase `max` if you have many concurrent users
- Decrease `statement_timeout` to prevent long-running queries
- Monitor pool stats to find optimal settings

### Query Caching

**Current**: No query caching (always fresh data)

**Future**: Implement Redis caching for:
- READ queries (SELECT)
- Configuration API responses
- Schema information

### Database Indexes

Ensure target databases have proper indexes:
```sql
-- Example: Index for common WHERE clauses
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_created_at ON users(created_at DESC);
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes with proper TypeScript types
4. Add tests if applicable
5. Run linter: `npm run lint`
6. Test all API endpoints manually
7. Commit changes: `git commit -m 'Add feature'`
8. Push to branch: `git push origin feature/my-feature`
9. Open Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](../LICENSE) file for details.

---

Built with ❤️ using Node.js, TypeScript, and PostgreSQL for database administrators managing multi-cloud deployments.
