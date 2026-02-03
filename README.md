# Dual Database Manager

A powerful web-based PostgreSQL database management tool that enables seamless querying across multiple database instances and cloud providers simultaneously.

## 🌟 Features

### Multi-Cloud Support
- **Dynamic Cloud Configuration**: Support for unlimited cloud providers (AWS, GCP, Azure, etc.)
- **Simultaneous Query Execution**: Execute queries across all configured clouds at once
- **Individual Cloud Execution**: Target specific clouds for queries
- **Automatic Result Aggregation**: View results from all clouds in a unified interface

### Dynamic Configuration
- **JSON-Based Setup**: All database and cloud configurations in a single `databases.json` file
- **Zero Hardcoding**: Add/remove clouds and databases without code changes
- **Environment Variable Support**: Secure credential management with `${VAR_NAME}` substitution
- **Runtime Configuration**: Changes reflected immediately without redeployment

### Query Management
- **Monaco SQL Editor**: Professional code editor with syntax highlighting
- **Multi-Statement Support**: Execute multiple SQL statements with automatic transaction handling
- **Query Validation**: Real-time syntax checking before execution
- **SQL Formatting**: One-click SQL formatting with PostgreSQL dialect support
- **Auto-Save**: Automatic draft saving every 5 seconds

### User Management
- **Role-Based Access Control**:
  - `MASTER`: Full access including user management
  - `USER`: Execute write queries (INSERT, UPDATE, DELETE)
  - `READER`: Read-only access (SELECT only)
- **Session Management**: Secure session handling with Redis
- **User Activation**: Enable/disable user accounts

### Query History
- **Persistent History**: All write queries logged to database
- **Metadata Tracking**: User, timestamp, execution mode, success/failure
- **Result Storage**: Full query results saved for audit
- **Filtering**: Filter by database, success status, date range

### Safety Features
- **Dangerous Query Detection**: Warnings for DROP, TRUNCATE, ALTER operations
- **Confirmation Dialogs**: Require explicit confirmation for destructive queries
- **Read-Only Mode**: READER role cannot execute write queries
- **Query Timeout Protection**: Configurable timeouts (default: 5 minutes)

## 🏗️ Architecture

### Technology Stack

**Backend:**
- Node.js with Express.js
- TypeScript for type safety
- PostgreSQL with node-postgres (pg)
- Redis for session storage
- Zod for request validation
- Winston for logging

**Frontend:**
- React 18 with TypeScript
- Vite for fast development
- Material-UI (MUI) for components
- Monaco Editor for SQL editing
- Zustand for state management
- Axios for API calls

### System Design

```
┌─────────────────┐
│   Frontend      │
│   (React + TS)  │
│   Port: 5173    │
└────────┬────────┘
         │ HTTP/REST
         │
┌────────▼────────┐
│   Backend       │
│ (Express + TS)  │
│   Port: 3000    │
└────────┬────────┘
         │
    ┌────┴─────┬──────────┬──────────┐
    │          │          │          │
┌───▼────┐ ┌──▼─────┐ ┌──▼─────┐ ┌──▼─────┐
│ Cloud1 │ │ Cloud2 │ │ Cloud3 │ │  ...   │
│  DBs   │ │  DBs   │ │  DBs   │ │  DBs   │
└────────┘ └────────┘ └────────┘ └────────┘
```

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ and npm
- PostgreSQL 12+
- Redis 6+
- At least one PostgreSQL database to manage

### 1. Clone and Install

```bash
git clone <repository-url>
cd dual-db-manager

# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

### 2. Configure Databases

Create `backend/config/databases.json`:

```json
{
  "primary": {
    "cloudName": "cloud1",
    "db_configs": [
      {
        "name": "db1",
        "label": "Database 1",
        "host": "localhost",
        "port": 5432,
        "user": "postgres",
        "password": "password",
        "database": "mydb1",
        "schemas": ["public", "app_schema"],
        "defaultSchema": "public"
      }
    ]
  },
  "secondary": [
    {
      "cloudName": "cloud2",
      "db_configs": [
        {
          "name": "db1",
          "label": "Database 1",
          "host": "remote-host",
          "port": 5432,
          "user": "postgres",
          "password": "${DB_PASSWORD}",
          "database": "mydb1",
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
    "database": "mydb1"
  }
}
```

See [CONFIG.md](backend/CONFIG.md) for detailed configuration options.

### 3. Configure Environment

Create `backend/.env`:

```env
# Server
PORT=3000
NODE_ENV=development

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Session
SESSION_SECRET=your-secret-key-change-this

# Frontend
FRONTEND_URL=http://localhost:5173

# Query Settings
MAX_QUERY_TIMEOUT_MS=300000

# Migrations
RUN_MIGRATIONS=true

# Environment variables for databases.json
DB_PASSWORD=your-secure-password
```

Create `frontend/.env`:

```env
VITE_API_URL=http://localhost:3000
```

### 4. Initialize Database

Run the schema migration to create the `dual_db_manager` schema:

```bash
cd backend
npm run migrate
```

This creates:
- `dual_db_manager.users` - User accounts
- `dual_db_manager.query_history` - Query execution history

### 5. Create Admin User

```sql
-- Connect to your database
INSERT INTO dual_db_manager.users (username, email, name, password_hash, role, is_active)
VALUES (
  'admin',
  'admin@example.com',
  'Administrator',
  '$2a$10$YourBcryptHashHere',  -- Use bcrypt to hash your password
  'MASTER',
  true
);
```

### 6. Start Services

```bash
# Terminal 1: Start Redis
redis-server

# Terminal 2: Start Backend
cd backend
npm run dev

# Terminal 3: Start Frontend
cd frontend
npm run dev
```

Access the application at `http://localhost:5173`

## 📖 Usage

### Basic Workflow

1. **Login**: Use your credentials to log in
2. **Select Database**: Choose which database to query (e.g., "Database 1")
3. **Select Schema**: Choose PostgreSQL schema (e.g., "public")
4. **Select Execution Mode**:
   - `Both (CLOUD1 + CLOUD2 + ...)` - Execute on all clouds
   - `CLOUD1 Only` - Execute on primary cloud only
   - `CLOUD2 Only` - Execute on secondary cloud only
5. **Write Query**: Use the SQL editor to write your query
6. **Execute**: Click "Execute" or press `Cmd+Enter` (Mac) / `Ctrl+Enter` (Windows/Linux)
7. **View Results**: See results for each cloud in expandable sections

### Query Editor Features

- **Syntax Highlighting**: PostgreSQL SQL syntax
- **Multi-Statement Support**: Separate statements with semicolons
- **Auto-Format**: Click "Format SQL" for clean formatting
- **Keyboard Shortcuts**:
  - `Cmd/Ctrl + Enter`: Execute query
  - `Cmd/Ctrl + S`: Save (auto-saves every 5 seconds)
- **Auto-Save**: Drafts saved automatically every 5 seconds

### Execution Modes

**Execute on All Clouds (`Both` mode):**
```sql
SELECT count(*) FROM users;
```
Returns results from all configured clouds simultaneously.

**Execute on Specific Cloud:**
Select specific cloud from dropdown (e.g., "CLOUD1 Only") to target that cloud.

### Multi-Statement Queries

```sql
BEGIN;
UPDATE users SET active = false WHERE id = 1;
SELECT * FROM users WHERE id = 1;
COMMIT;
```

Each statement executed sequentially. If any statement fails in a transaction, automatic rollback occurs.

### Query History

View history of all executed write queries:
- Filter by database, success status
- View full query text and results
- See execution time and user

## 🔧 Configuration

See [backend/CONFIG.md](backend/CONFIG.md) for comprehensive configuration documentation including:

- Database configuration structure
- Environment variable substitution
- Adding/removing clouds and databases
- Schema configuration
- Security best practices

## 🏢 Production Deployment

### Docker Deployment

The project includes Dockerfiles for both frontend and backend:

```bash
# Build backend
cd backend
docker build -t dual-db-manager-backend .

# Build frontend
cd frontend
docker build -t dual-db-manager-frontend --build-arg BACKEND_URL=https://your-api.com .
```

### Kubernetes Deployment

See `k8s/` directory for Kubernetes manifests:

- `backend.yaml` - Backend deployment and service
- `frontend.yaml` - Frontend deployment and service
- `secrets.yaml.example` - Secrets template

Update secrets and apply:

```bash
cp k8s/secrets.yaml.example k8s/secrets.yaml
# Edit secrets.yaml with your values (base64 encoded)
kubectl apply -f k8s/
```

### Environment Considerations

**Production Settings:**

1. Change `NODE_ENV=production` in backend
2. Use strong `SESSION_SECRET`
3. Configure CORS properly for your domain
4. Enable Redis password protection
5. Use SSL/TLS for database connections
6. Set up proper logging and monitoring

## 🛡️ Security

- **SQL Injection Protection**: Parameterized queries throughout
- **Session Security**: Secure session cookies, HTTP-only, SameSite
- **Role-Based Access**: Granular permission control
- **Password Hashing**: bcrypt with salt rounds
- **Query Validation**: Server-side validation before execution
- **Timeout Protection**: Query timeouts prevent long-running queries
- **CORS Configuration**: Whitelist allowed origins

## 📊 API Documentation

### Authentication

```
POST   /api/auth/login          - User login
GET    /api/auth/me             - Get current user
POST   /api/auth/logout         - Logout
POST   /api/auth/activate       - Activate user (MASTER only)
POST   /api/auth/deactivate     - Deactivate user (MASTER only)
POST   /api/auth/change-role    - Change user role (MASTER only)
GET    /api/auth/users          - List all users (MASTER only)
```

### Query Execution

```
POST   /api/query/execute       - Execute query
POST   /api/query/validate      - Validate query syntax
```

### Configuration

```
GET    /api/schemas/configuration  - Get database configuration
GET    /api/schemas/:database      - Get schemas for database (legacy)
```

### History

```
GET    /api/history             - Get query history (with filters)
GET    /api/history/:id         - Get specific execution
```

## 🧪 Development

### Running Tests

```bash
# Backend tests
cd backend
npm test

# Frontend tests
cd frontend
npm test
```

### Code Quality

```bash
# Lint
npm run lint

# Type check
npm run type-check

# Format
npm run format
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

For issues and questions:
- Open an issue on GitHub
- Check existing documentation in `backend/CONFIG.md`

## 🗺️ Roadmap

- [ ] Query templates and saved queries
- [ ] Export results to CSV/Excel
- [ ] Schema visualization
- [ ] Query performance analytics
- [ ] Database schema comparison across clouds
- [ ] Scheduled query execution
- [ ] Real-time collaboration
- [ ] Advanced autocomplete with table/column suggestions

---

Built with ❤️ for database administrators and developers managing multi-cloud PostgreSQL deployments.
