# Dual Database Manager - Frontend

Professional React-based web interface for executing SQL queries across unlimited PostgreSQL database instances and cloud providers simultaneously.

## Features

### Core Capabilities
- **Monaco SQL Editor**: Professional code editor (VS Code) with PostgreSQL syntax highlighting
- **Dynamic Multi-Cloud Support**: Support for unlimited cloud providers (AWS, GCP, Azure, etc.)
- **Dynamic Database Selection**: Choose from any configured database across all clouds
- **Dynamic Execution Modes**: Execute on all clouds simultaneously or target specific clouds
- **Multi-Cloud Results**: View results from all clouds in a unified interface with color-coded sections
- **Query History**: Complete audit trail with filtering and replay capabilities
- **Auto-Save**: Automatic draft saving every 5 seconds
- **SQL Formatting**: One-click SQL formatting with PostgreSQL dialect support
- **Role-Based UI**: Adaptive interface based on user role (MASTER, USER, READER)
- **Dark Theme**: Professional Material-UI design optimized for database work

### User Management (MASTER only)
- **User Administration**: View, activate, deactivate users
- **Role Management**: Change user roles (MASTER, USER, READER)
- **User Registration**: Create new user accounts

### Query Safety
- **Dangerous Query Detection**: Warnings for DROP, TRUNCATE, ALTER operations
- **Confirmation Dialogs**: Explicit confirmation required for destructive queries
- **Query Validation**: Real-time syntax checking before execution
- **Read-Only Mode**: READER role cannot execute write queries

## Tech Stack

- **Framework**: React 18 with TypeScript 5
- **Build Tool**: Vite 4 (fast HMR, optimized builds)
- **UI Library**: Material-UI (MUI) v5
- **SQL Editor**: Monaco Editor (VS Code engine)
- **State Management**: Zustand (lightweight, performant)
- **HTTP Client**: Axios with interceptors
- **Routing**: React Router v6
- **Notifications**: React Hot Toast
- **Date Formatting**: date-fns
- **SQL Formatting**: sql-formatter

## Project Structure

```
frontend/
├── src/
│   ├── components/
│   │   ├── Editor/
│   │   │   └── SQLEditor.tsx              # Monaco editor with formatting
│   │   ├── Selector/
│   │   │   └── DatabaseSelector.tsx       # Dynamic DB/schema/mode selector
│   │   ├── Results/
│   │   │   └── ResultsPanel.tsx           # Multi-cloud results display
│   │   ├── History/
│   │   │   └── QueryHistory.tsx           # Query history with filters
│   │   └── Users/
│   │       └── UserManagement.tsx         # User admin (MASTER only)
│   ├── pages/
│   │   ├── LoginPage.tsx                  # Session-based login
│   │   └── ConsolePage.tsx                # Main query console
│   ├── services/
│   │   └── api.ts                         # API client with auth/query/history
│   ├── store/
│   │   └── appStore.ts                    # Zustand global state
│   ├── types/
│   │   └── index.ts                       # TypeScript type definitions
│   ├── hooks/
│   │   └── useAutoSave.ts                 # Auto-save hook (5 second debounce)
│   ├── App.tsx                            # Main app with routing
│   └── main.tsx                           # Entry point
├── public/
│   ├── config.js                          # Runtime config (Docker)
│   └── index.html
├── Dockerfile                             # Multi-stage production build
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

## Setup

### Prerequisites

- Node.js 18+ and npm
- Backend server running on http://localhost:3000 (or configured URL)

### 1. Install Dependencies

```bash
cd frontend
npm install
```

### 2. Configure Environment

Create `.env` file:

```env
# Backend API URL
VITE_API_URL=http://localhost:3000
```

For production, the backend URL can also be configured at runtime via `/config.js` (useful for Docker deployments).

### 3. Start Development Server

```bash
npm run dev
```

Frontend will run on **http://localhost:5173**

### 4. Build for Production

```bash
# Build optimized production bundle
npm run build

# Preview production build locally
npm run preview
```

Build output: `dist/` directory

## Components

### SQLEditor (`src/components/Editor/SQLEditor.tsx`)

Monaco-based SQL editor component with:
- **PostgreSQL Syntax Highlighting**: Full SQL syntax support
- **Dark Theme**: Optimized for long coding sessions
- **Format SQL Button**: One-click formatting with sql-formatter
- **Keyboard Shortcuts**:
  - `Cmd/Ctrl + Enter`: Execute query
  - `Cmd/Ctrl + S`: Save (auto-save also runs every 5 seconds)
- **Auto-Save Status**: Shows "Saving..." or "Draft saved X ago"
- **Clear Draft**: Remove saved draft manually
- **Multi-Line Support**: Execute multiple SQL statements separated by semicolons
- **Word Wrap**: Enabled for better readability
- **Monaco Options**:
  - Line numbers
  - Auto-layout
  - Keyword suggestions
  - Snippet suggestions
  - Scrollbar customization

**Implementation Notes**:
- Uses `@monaco-editor/react` wrapper
- Stores editor instance in Zustand for programmatic control
- Auto-save uses debounced hook to localStorage

### DatabaseSelector (`src/components/Selector/DatabaseSelector.tsx`)

Dynamic control panel for query execution with three synchronized dropdowns:

**1. Database Selector**
- Dynamically populated from backend configuration
- Shows database labels (e.g., "Driver (BPP)", "Rider (BAP)")
- Stores database name internally (e.g., "bpp", "bap")
- Fetches configuration on mount from `/api/schemas/configuration`

**2. PostgreSQL Schema Selector**
- Dynamically populated based on selected database
- Shows available schemas from database configuration
- Falls back to default schema if schemas array is empty
- Sets `search_path` on backend during query execution

**3. Execution Mode Selector**
- Dynamically generated based on configured clouds
- **"Both"** mode: Executes on ALL configured clouds simultaneously
  - Label shows all cloud names (e.g., "Both (AWS + GCP + AZURE)")
- **Individual cloud modes**: One option per cloud (e.g., "AWS Only", "GCP Only")
- Supports unlimited number of clouds

**Execute Button**:
- Triggers query execution with selected database/schema/mode
- Shows loading spinner during execution
- Validates query is not empty before execution

**Architecture**:
- Fetches configuration once on mount, cached in localStorage (1 hour TTL)
- Updates schema dropdown when database selection changes
- Stores selections in Zustand global state

### ResultsPanel (`src/components/Results/ResultsPanel.tsx`)

Multi-cloud results display with expandable sections:

**Features**:
- **Dynamic Cloud Results**: Shows results for ALL executed clouds
- **Color-Coded Sections**: Each cloud has unique color (primary, secondary, info, etc.)
- **Expandable Sections**: Click to expand/collapse individual cloud results
- **Success/Error Indicators**: Clear visual feedback per cloud
- **Execution Duration**: Shows query execution time per cloud
- **Multiple Statement Results**: Numbered sections for each SQL statement
- **Table View**: Formatted table with column headers
- **Empty State**: Shows "No results" when query returns no rows
- **Error Display**: Shows error messages with stack traces (if available)

**Views**:
- **Table View**: Default, shows rows as HTML table with borders
- **Row Count**: Displays number of rows returned
- **Multi-Statement Support**: Shows "Statement 1", "Statement 2", etc. for multiple queries

**Implementation**:
- Dynamically iterates over cloud keys in response object
- Filters out metadata keys (`id`, `success`)
- Color assignment: First cloud = primary, second = secondary, rest = info/success/warning
- Auto-scrolls to results panel after query execution

### QueryHistory (`src/components/History/QueryHistory.tsx`)

Sidebar panel for viewing and managing query history:

**Features**:
- **Filterable List**: Filter by database, success status
- **Copy to Editor**: Click any query to load into SQL editor
- **Execution Metadata**: Shows user, timestamp, duration, mode
- **Success/Failure Indicators**: Color-coded status badges
- **Date Formatting**: Human-readable timestamps (e.g., "2 hours ago")
- **Paginated**: Loads recent queries with pagination support
- **Cloud-Specific Results**: Shows which clouds succeeded/failed

**Filters**:
- Database dropdown (all databases + "All Databases" option)
- Success status (all/success/failure)

**Implementation**:
- Fetches from `/api/history` with query parameters
- Caches in Zustand store
- Auto-refreshes after new query execution

### UserManagement (`src/components/Users/UserManagement.tsx`)

User administration panel (MASTER role only):

**Features**:
- **User List**: View all registered users
- **Activate/Deactivate**: Enable or disable user accounts
- **Change Role**: Modify user roles (MASTER, USER, READER)
- **User Registration**: Create new user accounts
- **Status Indicators**: Active/inactive badges
- **Role Badges**: Color-coded role indicators

**Actions**:
- **Activate**: Enable user login (MASTER only)
- **Deactivate**: Disable user login (MASTER only)
- **Change Role**: Update user permissions (MASTER only)
- **Create User**: Register new user with username, email, password, name

**Access Control**:
- Only visible to MASTER role users
- API endpoints protected by backend role middleware

## Pages

### LoginPage (`/login`)

Session-based authentication page:

**Features**:
- **Username/Password Login**: Standard form authentication
- **Session Cookies**: HTTP-only, secure cookies for session management
- **Redirect After Login**: Automatically redirects to console on success
- **Error Handling**: Shows login errors (invalid credentials, inactive user)
- **Feature Overview**: Displays key features of the application
- **Responsive Design**: Mobile-friendly layout

**Security**:
- Credentials sent via POST with withCredentials: true
- Session managed by backend (Redis-backed)
- Automatic redirect to login if session expires (401 response)

### ConsolePage (`/`)

Main query console with split-panel layout:

**Layout**:
- **Top Section**: DatabaseSelector (fixed)
- **Left Panel**: SQLEditor (resizable)
- **Right Panel**: ResultsPanel (auto-scrolls after execution)
- **Sidebar**: QueryHistory (toggleable)

**Workflow**:
1. Select database from dropdown
2. Select PostgreSQL schema
3. Choose execution mode (all clouds or specific cloud)
4. Write SQL query in editor
5. Click "Execute" or press Cmd/Ctrl+Enter
6. View results for each cloud in expandable sections
7. Check history sidebar for past queries

**Features**:
- **Auto-Save**: Query draft saved every 5 seconds to localStorage
- **Keyboard Shortcuts**: Cmd/Ctrl+Enter to execute
- **Auto-Scroll**: Automatically scrolls to results after execution
- **Protected Route**: Requires authentication, redirects to /login if not logged in

## State Management

Using **Zustand** for global state with the following slices:

### Authentication State
```typescript
user: User | null
setUser: (user: User | null) => void
logout: () => Promise<void>
```

### Query State
```typescript
currentQuery: string
setCurrentQuery: (query: string) => void
selectedDatabase: string               // Dynamic database name (e.g., 'bpp', 'bap')
setSelectedDatabase: (database: string) => void
selectedPgSchema: string              // PostgreSQL schema (e.g., 'public', 'atlas_app')
setSelectedPgSchema: (schema: string) => void
selectedMode: string                  // Execution mode (e.g., 'both', 'aws', 'gcp')
setSelectedMode: (mode: string) => void
```

### Results State
```typescript
queryResult: QueryResponse | null
setQueryResult: (result: QueryResponse | null) => void
isExecuting: boolean
setIsExecuting: (executing: boolean) => void
```

### History State
```typescript
queryHistory: QueryExecution[]
setQueryHistory: (history: QueryExecution[]) => void
```

### Editor State
```typescript
editorInstance: editor.IStandaloneCodeEditor | null
setEditorInstance: (instance: editor.IStandaloneCodeEditor | null) => void
```

### UI State
```typescript
showHistory: boolean
setShowHistory: (show: boolean) => void
```

**Note**: All state is typed with TypeScript interfaces defined in `src/types/index.ts`.

## API Integration

All backend communication via `src/services/api.ts`:

### Authentication API (`authAPI`)
```typescript
getCurrentUser(): Promise<User>
login(username: string, password: string): Promise<{ user: User; message: string }>
logout(): Promise<void>
listUsers(): Promise<{ users: User[] }>               // MASTER only
activateUser(username: string): Promise<void>         // MASTER only
deactivateUser(username: string): Promise<void>       // MASTER only
changeRole(username: string, role: Role): Promise<void> // MASTER only
```

### Query API (`queryAPI`)
```typescript
execute(request: QueryRequest): Promise<QueryResponse>
validate(query: string): Promise<{ valid: boolean; error?: string }>
```

**QueryRequest Structure**:
```typescript
{
  query: string;           // SQL query to execute
  database: string;        // Dynamic database name (e.g., 'bpp', 'bap')
  mode: string;            // Execution mode ('both' or cloud name)
  pgSchema?: string;       // Optional PostgreSQL schema
  timeout?: number;        // Optional timeout in milliseconds
}
```

**QueryResponse Structure**:
```typescript
{
  id: string;              // Execution UUID
  success: boolean;        // Overall success
  [cloudName: string]: {   // Dynamic cloud results
    success: boolean;
    result?: QueryResult;
    results?: StatementResult[];
    error?: string;
    duration_ms: number;
    statementCount?: number;
  }
}
```

### Schema API (`schemaAPI`)
```typescript
getConfiguration(): Promise<DatabaseConfiguration>
getSchemas(database: string, cloud: string): Promise<{ schemas: string[]; default: string }>
clearCache(): void  // Clear localStorage cache
```

**DatabaseConfiguration Structure**:
```typescript
{
  primary: {
    cloudName: string;          // e.g., "aws"
    databases: DatabaseInfo[];
  };
  secondary: Array<{
    cloudName: string;          // e.g., "gcp", "azure"
    databases: DatabaseInfo[];
  }>;
}

interface DatabaseInfo {
  name: string;                 // Internal name (e.g., "bpp", "bap")
  label: string;                // Display name (e.g., "Driver (BPP)")
  cloudType: string;            // Cloud provider
  schemas: string[];            // Available PostgreSQL schemas
  defaultSchema: string;        // Default schema
}
```

### History API (`historyAPI`)
```typescript
getHistory(filter?: HistoryFilter): Promise<QueryExecution[]>
getExecutionById(id: string): Promise<QueryExecution>
```

### Axios Configuration

**Base Configuration**:
- `baseURL`: From `VITE_API_URL` env or runtime config.js
- `withCredentials: true`: Send session cookies
- `Content-Type: application/json`

**Response Interceptor**:
- 401 responses → Redirect to /login
- Error responses → Show toast notification
- Successful responses → Pass through

**Caching**:
- Configuration API responses cached in localStorage (1 hour TTL)
- Schema API responses cached per database (1 hour TTL)
- Cache keys: `database_configuration`, `schemas_{database}_{cloud}`

## Development

### Available Scripts

```bash
# Install dependencies
npm install

# Start development server (http://localhost:5173)
npm run dev

# Build for production (outputs to dist/)
npm run build

# Preview production build
npm run preview

# Lint TypeScript and fix issues
npm run lint

# Type check without building
npx tsc --noEmit
```

### Development Server

Vite dev server features:
- **Hot Module Replacement (HMR)**: Instant updates without full page reload
- **Fast Startup**: Optimized cold start with esbuild
- **TypeScript Support**: Native TypeScript compilation
- **Proxy Support**: Can proxy API requests to avoid CORS in development

### Building for Production

Production build process:
1. TypeScript compilation
2. Bundle optimization (tree-shaking, minification)
3. Asset optimization (images, fonts)
4. Code splitting (vendor chunks)
5. Source map generation

**Output**: `dist/` directory ready for static hosting or Docker

## Environment Variables

### Development (`.env`)

```env
# Backend API URL
VITE_API_URL=http://localhost:3000
```

### Production (Docker)

For Docker deployments, use runtime configuration via `public/config.js`:

```javascript
window.__APP_CONFIG__ = {
  BACKEND_URL: 'https://your-api-domain.com'
};
```

This file is generated at runtime by Docker entrypoint script, allowing backend URL configuration without rebuilding the frontend image.

## Docker Deployment

### Build Image

```bash
cd frontend
docker build -t dual-db-manager-frontend --build-arg BACKEND_URL=https://api.example.com .
```

**Build Arguments**:
- `BACKEND_URL`: Backend API URL (overridable at runtime)

### Run Container

```bash
docker run -p 80:80 \
  -e BACKEND_URL=https://api.example.com \
  dual-db-manager-frontend
```

**Runtime Configuration**:
- `BACKEND_URL` environment variable generates `/config.js` at container startup
- Nginx serves static files from `/usr/share/nginx/html`
- Runs on port 80 by default

### Dockerfile Overview

Multi-stage build:
1. **Build stage**: Installs dependencies and builds production bundle
2. **Production stage**: Nginx serves static files with runtime config

## Browser Support

- **Chrome/Edge**: Latest 2 versions ✅
- **Firefox**: Latest 2 versions ✅
- **Safari**: Latest 2 versions ✅
- **Mobile**: Responsive design works on tablets/phones

**Requirements**:
- ES2020+ support
- Modern JavaScript features (async/await, modules)
- LocalStorage API
- Fetch API

## TypeScript

**Configuration** (`tsconfig.json`):
- Target: ES2020
- Module: ESNext
- Strict mode enabled
- React JSX support
- Path aliases configured

**Type Definitions**:
- All API responses typed in `src/types/index.ts`
- Component props fully typed
- Zustand store fully typed
- No `any` types in production code (except Monaco callbacks)

## Styling

**Material-UI (MUI) v5**:
- Custom theme with dark mode
- Responsive breakpoints
- Consistent spacing (8px grid)
- Color palette:
  - Primary: Blue (database selector)
  - Secondary: Green (results)
  - Error: Red (errors)
  - Warning: Orange (dangerous queries)

**Layout**:
- Flexbox-based responsive layout
- CSS Grid for complex layouts
- `sx` prop for inline styling
- No external CSS files (all styles in components)

## Performance Optimizations

1. **Code Splitting**: React.lazy() for route-based splitting
2. **Memoization**: useMemo() for expensive computations
3. **Debouncing**: Auto-save debounced to 5 seconds
4. **Caching**: API responses cached in localStorage
5. **Bundle Size**: Tree-shaking removes unused code
6. **Asset Optimization**: Images and fonts optimized in build

## Security

- **No credentials in code**: All sensitive data from backend
- **Session-based auth**: HTTP-only cookies prevent XSS
- **CORS**: Backend validates origin
- **Input validation**: User input sanitized before sending to backend
- **XSS prevention**: React escapes user input by default
- **SQL injection prevention**: Backend uses parameterized queries

## Troubleshooting

### Issue: "Network Error" or "ERR_CONNECTION_REFUSED"

**Cause**: Backend not running or wrong API URL

**Solution**:
1. Verify backend is running: `curl http://localhost:3000/health`
2. Check `VITE_API_URL` in `.env`
3. Check browser console for actual error

### Issue: "401 Unauthorized" after login

**Cause**: Session cookies not being sent

**Solution**:
1. Ensure `withCredentials: true` in axios config
2. Check backend CORS allows credentials
3. Verify backend `SESSION_SECRET` is set
4. Check Redis is running

### Issue: Dropdown shows "No databases available"

**Cause**: Backend configuration not loaded or invalid

**Solution**:
1. Check backend has `config/databases.json`
2. Verify `/api/schemas/configuration` returns valid data:
   ```bash
   curl http://localhost:3000/api/schemas/configuration
   ```
3. Clear localStorage cache: `localStorage.clear()`
4. Refresh browser

### Issue: Query results not appearing

**Cause**: JavaScript error or rendering issue

**Solution**:
1. Open browser DevTools console
2. Check for errors in console
3. Verify query response structure in Network tab
4. Check if `queryResult` is set in Zustand store

### Issue: Monaco editor not loading

**Cause**: CDN blocked or network issue

**Solution**:
1. Check browser console for errors
2. Verify Monaco CDN is accessible
3. Try clearing browser cache
4. Check if ad blocker is interfering

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes with TypeScript types
4. Test thoroughly (all features, all clouds)
5. Run linter: `npm run lint`
6. Commit changes: `git commit -m 'Add feature'`
7. Push to branch: `git push origin feature/my-feature`
8. Open Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](../LICENSE) file for details.

---

Built with ❤️ using React, TypeScript, and Material-UI for database administrators managing multi-cloud PostgreSQL deployments.
