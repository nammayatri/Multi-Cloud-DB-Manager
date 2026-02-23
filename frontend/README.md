# Multi-Cloud DB Manager — Frontend

React + TypeScript web interface for querying PostgreSQL across multiple cloud providers simultaneously.

## Tech Stack

| Technology | Purpose |
|-----------|---------|
| React 18 | UI framework |
| TypeScript 5 | Type safety |
| Vite 5 | Build tool with HMR |
| Material-UI (MUI) v5 | Component library (dark theme) |
| Monaco Editor | SQL editor (VS Code engine) |
| Zustand | Lightweight state management |
| Axios | HTTP client with session cookies |
| React Router v6 | Client-side routing |
| sql-formatter | SQL formatting (PostgreSQL dialect) |
| date-fns | Date formatting |
| React Hot Toast | Notifications |

## Project Structure

```
frontend/
├── src/
│   ├── components/
│   │   ├── Dialog/
│   │   │   └── QueryWarningDialog.tsx    # Dangerous query confirmation + password prompt
│   │   ├── Editor/
│   │   │   └── SQLEditor.tsx             # Monaco editor with formatting + auto-save
│   │   ├── History/
│   │   │   └── QueryHistory.tsx          # Query history sidebar with filters
│   │   ├── Results/
│   │   │   └── ResultsPanel.tsx          # Multi-cloud results: table, JSON, CSV export
│   │   └── Selector/
│   │       └── DatabaseSelector.tsx      # Database + schema + execution mode dropdowns
│   ├── hooks/
│   │   └── useAutoSave.ts               # Debounced auto-save to localStorage
│   ├── pages/
│   │   ├── LoginPage.tsx                 # Login + registration
│   │   ├── ConsolePage.tsx               # Main query console
│   │   └── UsersPage.tsx                 # User management (MASTER only)
│   ├── services/
│   │   ├── api.ts                        # Axios client: auth, query, history, schema APIs
│   │   └── queryValidation.service.ts    # Client-side dangerous query detection
│   ├── store/
│   │   └── appStore.ts                   # Zustand global state
│   ├── types/
│   │   └── index.ts                      # TypeScript interfaces
│   ├── App.tsx                           # Routes + dark theme
│   └── main.tsx                          # Entry point
├── public/
│   └── config.js                         # Runtime backend URL (for Docker)
├── nginx.conf                            # Production Nginx config
├── Dockerfile                            # Multi-stage: build + Nginx
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Pages

### Login (`/login`)
- Username/password login form
- Registration form (username, email, name, password)
- New accounts require MASTER activation before first login
- Auto-redirects to console on successful login

### Console (`/`)
- **Top bar**: Database selector, schema selector, execution mode, users button (MASTER), history toggle, profile menu
- **Left panel**: Monaco SQL editor
- **Right panel**: Multi-cloud results (expandable per cloud)
- **Sidebar**: Query history (toggleable)
- Protected route — redirects to `/login` if unauthenticated

### Users (`/users`) — MASTER only
- User table: username, email, name, role, active status, created date
- Actions: activate, deactivate, change role (MASTER/USER/READER), delete
- Cannot delete MASTER users or yourself

## Features

### SQL Editor
- Monaco Editor with PostgreSQL syntax highlighting
- Dark theme (`vs-dark`)
- **Format SQL**: One-click formatting (PostgreSQL dialect, uppercase keywords)
- **Auto-save**: Drafts saved every 5 seconds to localStorage, restored on page load
- **Draft indicator**: Shows "Draft saved X ago" or "Saving..."
- **Clear draft**: Manual clear button
- **Keyboard shortcut**: `Cmd/Ctrl+Enter` to execute

Editor options: line numbers, word wrap, font size 14, tab size 2, minimap disabled, keyword + snippet suggestions.

### Database Selector
Three synchronized dropdowns dynamically populated from backend config:

1. **Database**: Shows configured databases by label (e.g., "Driver (BPP)")
2. **Schema**: PostgreSQL schemas for selected database, sets `search_path`
3. **Execution Mode**: "Both (AWS + GCP + ...)" or individual cloud

Configuration cached in localStorage (1-hour TTL). Click "Refresh" in top bar to clear cache.

### Results Panel
- **Color-coded cloud sections**: Each cloud gets a distinct color, expandable/collapsible
- **Success/error indicators**: Per-cloud with duration in ms
- **Table view**: Formatted HTML table with headers
- **JSON view**: Raw JSON toggle
- **CSV export**: Download results as CSV per cloud
- **JSON export**: Download as formatted JSON
- **Multi-statement**: Shows "Statement 1 of N" with individual results per statement
- **Auto-scroll**: Scrolls to results after execution

### Query History
- Paginated list of past executions
- **Filters**: Database dropdown, success/failure status
- **User filter** (MASTER only): Autocomplete dropdown with:
  - Users from current page (derived from loaded history — no extra API call)
  - Server-side search when typing (debounced 300ms via `/api/auth/users/search`)
- Click any query to load it into the editor
- Copy to clipboard button
- Shows: query text, database, execution mode, timestamp, duration per cloud, user info

### Dangerous Query Detection
Client-side validation in `queryValidation.service.ts` warns before executing:

| Detection | Severity | MASTER | USER/READER |
|-----------|----------|--------|-------------|
| DROP TABLE/INDEX/VIEW | Danger | Password required | Blocked |
| TRUNCATE | Danger | Password required | Blocked |
| ALTER (non-ADD) | Danger | Password required | Blocked |
| DELETE without WHERE | Danger | Password required | Blocked |
| UPDATE without WHERE | Warning | Confirmation | Confirmation |

Confirmation dialog shows affected statements and requires password for MASTER-only operations.

## API Integration

All API calls in `src/services/api.ts`:

```typescript
// Authentication
authAPI.login(username, password)
authAPI.register(username, password, email, name)
authAPI.getCurrentUser()
authAPI.logout()
authAPI.listUsers()                    // MASTER
authAPI.searchUsers(q)                 // MASTER — ILIKE search
authAPI.activateUser(username)         // MASTER
authAPI.deactivateUser(username)       // MASTER
authAPI.changeRole(username, role)     // MASTER
authAPI.deleteUser(username)           // MASTER

// Query execution (async)
queryAPI.execute(request)              // Returns { executionId }
queryAPI.getStatus(executionId)        // Poll for results
queryAPI.cancel(executionId)
queryAPI.validate(query)

// Schema & config
schemaAPI.getConfiguration()           // Cached 1 hour
schemaAPI.getSchemas(database, cloud)  // Cached 1 hour
schemaAPI.clearCache()

// History
historyAPI.getHistory(filter?)
historyAPI.getExecutionById(id)
```

**Axios config**: `withCredentials: true` for session cookies, 401 → redirect to `/login`, errors → toast notifications.

## State Management

Zustand store in `src/store/appStore.ts`:

| Slice | State |
|-------|-------|
| User | `user`, `setUser` |
| Query | `currentQuery`, `selectedDatabase`, `selectedPgSchema`, `selectedMode` |
| Execution | `isExecuting`, `currentExecutionId`, `continueOnError` |
| History | `queryHistory`, `setQueryHistory` |
| UI | `showHistory`, `editorInstance` |

## Setup

### Prerequisites
- Node.js 18+
- Backend running on http://localhost:3000

### Install & run

```bash
cd frontend
npm install

# Create .env
echo "VITE_API_URL=http://localhost:3000" > .env

# Development
npm run dev     # http://localhost:5173

# Production build
npm run build   # Outputs to dist/
npm run preview # Preview locally
```

## Docker

```bash
# Build (use --platform linux/amd64 for x86 servers)
docker build --platform linux/amd64 -t multi-cloud-db-frontend .

# Run — BACKEND_URL injected at runtime, no rebuild needed per environment
docker run -p 80:80 -e BACKEND_URL=https://your-api.com multi-cloud-db-frontend
```

**How runtime config works**: Docker entrypoint script writes `BACKEND_URL` into `/usr/share/nginx/html/config.js` which sets `window.__APP_CONFIG__.BACKEND_URL`. The app reads this at startup, falling back to `VITE_API_URL`.

**Nginx config**: Gzip compression, security headers (X-Frame-Options, X-Content-Type-Options, X-XSS-Protection), 1-year cache for static assets, SPA routing via `try_files`.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server with HMR (port 5173) |
| `npm run build` | TypeScript check + production build |
| `npm run preview` | Preview production build locally |
| `npm run lint` | ESLint |

## Theme

Dark mode Material-UI theme:

| Color | Hex | Usage |
|-------|-----|-------|
| Primary | `#2196f3` | Buttons, links, selected items |
| Secondary | `#f50057` | Accents |
| Success | `#4caf50` | Successful query results |
| Error | default | Failed queries, validation errors |
| Warning | default | Dangerous query warnings |

## Browser Support

Chrome, Edge, Firefox, Safari — latest 2 versions. Requires ES2020+, localStorage, Fetch API.

## License

MIT — see [LICENSE](../LICENSE)
