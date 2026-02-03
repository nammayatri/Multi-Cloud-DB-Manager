# Database Configuration Guide

Complete guide for configuring the Dual Database Manager's multi-cloud database setup.

## Table of Contents

- [Overview](#overview)
- [Configuration File Structure](#configuration-file-structure)
- [Environment Variable Substitution](#environment-variable-substitution)
- [Configuration Examples](#configuration-examples)
- [Adding/Removing Clouds](#addingremoving-clouds)
- [Schema Configuration](#schema-configuration)
- [Security Best Practices](#security-best-practices)
- [Troubleshooting](#troubleshooting)

## Overview

The Dual Database Manager uses a JSON-based configuration system (`backend/config/databases.json`) that supports:

- **Unlimited clouds**: Add as many cloud providers as needed
- **Multiple databases per cloud**: Each cloud can have multiple databases
- **Dynamic schema configuration**: Pre-configure available schemas per database
- **Environment variable substitution**: Secure credential management
- **Zero hardcoding**: All configuration is data-driven

## Configuration File Structure

### Complete Structure

```json
{
  "primary": {
    "cloudName": "string",
    "db_configs": [
      {
        "name": "string",
        "label": "string",
        "host": "string",
        "port": number,
        "user": "string",
        "password": "string",
        "database": "string",
        "schemas": ["string"],
        "defaultSchema": "string"
      }
    ]
  },
  "secondary": [
    {
      "cloudName": "string",
      "db_configs": [
        // Same structure as primary.db_configs
      ]
    }
  ],
  "history": {
    "host": "string",
    "port": number,
    "user": "string",
    "password": "string",
    "database": "string"
  }
}
```

### Field Descriptions

#### Primary Cloud

- **cloudName** (string, required): Unique identifier for the primary cloud (e.g., "aws", "gcp", "azure")
- **db_configs** (array, required): Array of database configurations

#### Database Configuration (`db_configs`)

- **name** (string, required): Internal database identifier (e.g., "db1", "db2", "analytics")
  - Used as the key for routing queries
  - Must be unique within a cloud

- **label** (string, required): Human-readable display name (e.g., "Production DB", "Analytics Database")
  - Shown in frontend dropdown
  - Can contain spaces and special characters

- **host** (string, required): Database host/IP address
  - Can use environment variable: `"${DB_HOST}"`

- **port** (number, required): Database port (typically 5432 for PostgreSQL)

- **user** (string, required): Database username
  - Can use environment variable: `"${DB_USER}"`

- **password** (string, required): Database password
  - **IMPORTANT**: Use environment variable: `"${DB_PASSWORD}"`
  - Never commit plaintext passwords to version control

- **database** (string, required): PostgreSQL database name to connect to

- **schemas** (array, required): List of available PostgreSQL schemas in this database
  - Empty array `[]` means no specific schemas (will use default schema)
  - Frontend populates schema dropdown from this list

- **defaultSchema** (string, required): Default schema to use when connecting
  - Typically "public" unless your app uses a different default

#### Secondary Clouds

Array of cloud configurations with the same structure as primary cloud.

#### History Database

Special configuration for storing query history:
- **host**, **port**, **user**, **password**, **database**: Same as database configuration
- Can point to any of your configured databases
- Will automatically create `dual_db_manager` schema if `RUN_MIGRATIONS=true`

## Environment Variable Substitution

### How It Works

Use `${VARIABLE_NAME}` syntax in `databases.json`. At runtime, the system replaces these with values from `.env` file.

### Example

**databases.json:**
```json
{
  "primary": {
    "cloudName": "aws",
    "db_configs": [
      {
        "name": "prod",
        "label": "Production",
        "host": "${AWS_DB_HOST}",
        "port": 5432,
        "user": "${AWS_DB_USER}",
        "password": "${AWS_DB_PASSWORD}",
        "database": "${AWS_DB_NAME}",
        "schemas": ["public", "app"],
        "defaultSchema": "public"
      }
    ]
  }
}
```

**.env:**
```env
AWS_DB_HOST=prod-db.example.com
AWS_DB_USER=admin
AWS_DB_PASSWORD=super-secret-password
AWS_DB_NAME=production_db
```

### Best Practices

1. **Always use environment variables for:**
   - Passwords
   - Sensitive hostnames/IPs
   - Usernames in production

2. **Can hardcode:**
   - Port numbers (usually 5432)
   - Schema names
   - Labels
   - Database names (if not sensitive)

3. **Never commit:**
   - `.env` file with real credentials
   - `databases.json` with plaintext passwords

## Configuration Examples

### Example 1: Single Cloud, Single Database

Simplest setup - one cloud provider, one database:

```json
{
  "primary": {
    "cloudName": "aws",
    "db_configs": [
      {
        "name": "maindb",
        "label": "Main Database",
        "host": "localhost",
        "port": 5432,
        "user": "postgres",
        "password": "${DB_PASSWORD}",
        "database": "myapp",
        "schemas": ["public"],
        "defaultSchema": "public"
      }
    ]
  },
  "secondary": [],
  "history": {
    "host": "localhost",
    "port": 5432,
    "user": "postgres",
    "password": "${DB_PASSWORD}",
    "database": "myapp"
  }
}
```

### Example 2: Two Clouds, Multiple Databases

Production use case - primary AWS, replica GCP:

```json
{
  "primary": {
    "cloudName": "aws",
    "db_configs": [
      {
        "name": "users",
        "label": "User Database",
        "host": "${AWS_HOST}",
        "port": 5432,
        "user": "${AWS_USER}",
        "password": "${AWS_PASSWORD}",
        "database": "users_db",
        "schemas": ["public", "auth", "profiles"],
        "defaultSchema": "public"
      },
      {
        "name": "analytics",
        "label": "Analytics Database",
        "host": "${AWS_HOST}",
        "port": 5432,
        "user": "${AWS_USER}",
        "password": "${AWS_PASSWORD}",
        "database": "analytics_db",
        "schemas": ["public", "events", "metrics"],
        "defaultSchema": "events"
      }
    ]
  },
  "secondary": [
    {
      "cloudName": "gcp",
      "db_configs": [
        {
          "name": "users",
          "label": "User Database (Replica)",
          "host": "${GCP_HOST}",
          "port": 5432,
          "user": "${GCP_USER}",
          "password": "${GCP_PASSWORD}",
          "database": "users_db",
          "schemas": ["public", "auth", "profiles"],
          "defaultSchema": "public"
        }
      ]
    }
  ],
  "history": {
    "host": "${AWS_HOST}",
    "port": 5432,
    "user": "${AWS_USER}",
    "password": "${AWS_PASSWORD}",
    "database": "users_db"
  }
}
```

### Example 3: Three Clouds

Multi-region deployment:

```json
{
  "primary": {
    "cloudName": "aws-us",
    "db_configs": [
      {
        "name": "app",
        "label": "Application DB (US)",
        "host": "${AWS_US_HOST}",
        "port": 5432,
        "user": "${AWS_USER}",
        "password": "${AWS_PASSWORD}",
        "database": "appdb",
        "schemas": ["public"],
        "defaultSchema": "public"
      }
    ]
  },
  "secondary": [
    {
      "cloudName": "aws-eu",
      "db_configs": [
        {
          "name": "app",
          "label": "Application DB (EU)",
          "host": "${AWS_EU_HOST}",
          "port": 5432,
          "user": "${AWS_USER}",
          "password": "${AWS_PASSWORD}",
          "database": "appdb",
          "schemas": ["public"],
          "defaultSchema": "public"
        }
      ]
    },
    {
      "cloudName": "gcp-asia",
      "db_configs": [
        {
          "name": "app",
          "label": "Application DB (Asia)",
          "host": "${GCP_ASIA_HOST}",
          "port": 5432,
          "user": "${GCP_USER}",
          "password": "${GCP_PASSWORD}",
          "database": "appdb",
          "schemas": ["public"],
          "defaultSchema": "public"
        }
      ]
    }
  ],
  "history": {
    "host": "${AWS_US_HOST}",
    "port": 5432,
    "user": "${AWS_USER}",
    "password": "${AWS_PASSWORD}",
    "database": "appdb"
  }
}
```

## Adding/Removing Clouds

### Adding a New Cloud

1. **Add cloud to `databases.json`:**

```json
{
  "secondary": [
    // ... existing clouds ...
    {
      "cloudName": "azure",
      "db_configs": [
        {
          "name": "db1",
          "label": "Azure Database",
          "host": "${AZURE_HOST}",
          "port": 5432,
          "user": "${AZURE_USER}",
          "password": "${AZURE_PASSWORD}",
          "database": "mydb",
          "schemas": ["public"],
          "defaultSchema": "public"
        }
      ]
    }
  ]
}
```

2. **Add environment variables to `.env`:**

```env
AZURE_HOST=azure-db.database.windows.net
AZURE_USER=admin
AZURE_PASSWORD=secure-password
```

3. **Restart backend** - That's it! The frontend will automatically show:
   - "Azure Only" in execution mode dropdown
   - "Both (AWS + GCP + AZURE)" for all clouds

### Removing a Cloud

1. Delete the cloud object from `databases.json`
2. Restart backend
3. Frontend automatically updates

## Schema Configuration

### PostgreSQL Schema vs Database

- **Database**: Top-level PostgreSQL container
- **Schema**: Namespace within a database

Example:
```
Database: myapp
├── Schema: public
│   ├── Table: users
│   └── Table: posts
└── Schema: analytics
    ├── Table: events
    └── Table: metrics
```

### Configuring Schemas

**Option 1: Pre-configure schemas** (Recommended)

```json
{
  "schemas": ["public", "app", "analytics"],
  "defaultSchema": "public"
}
```

Frontend dropdown shows these schemas. Queries execute with `SET search_path TO schema_name`.

**Option 2: Empty schemas array**

```json
{
  "schemas": [],
  "defaultSchema": "public"
}
```

Backend will query `information_schema` for available schemas (legacy mode, slower).

### Schema Search Path

When you select a schema in the frontend, the backend executes:

```sql
SET search_path TO "your_schema", public;
-- Then executes your query
SELECT * FROM my_table;  -- Searches in your_schema first, then public
```

## Security Best Practices

### 1. Credential Management

**✅ DO:**
```json
{
  "password": "${DB_PASSWORD}",
  "host": "${DB_HOST}"
}
```

**❌ DON'T:**
```json
{
  "password": "plaintext-password",
  "host": "production-db.internal.company.com"
}
```

### 2. `.gitignore` Configuration

Ensure these are in `.gitignore`:

```
# Environment files
.env
.env.local
.env.production

# Configuration with secrets
backend/config/databases.json
```

**Only commit:**
```
backend/config/databases.example.json
```

### 3. Example Files

Create `databases.example.json` with placeholders:

```json
{
  "primary": {
    "cloudName": "cloud1",
    "db_configs": [
      {
        "name": "db1",
        "label": "Database 1",
        "host": "${DB_HOST}",
        "port": 5432,
        "user": "${DB_USER}",
        "password": "${DB_PASSWORD}",
        "database": "${DB_NAME}",
        "schemas": ["public"],
        "defaultSchema": "public"
      }
    ]
  },
  "secondary": [],
  "history": {
    "host": "${DB_HOST}",
    "port": 5432,
    "user": "${DB_USER}",
    "password": "${DB_PASSWORD}",
    "database": "${DB_NAME}"
  }
}
```

### 4. Production Deployment

For Kubernetes/Docker deployments:

1. **Use Kubernetes Secrets:**
   ```yaml
   env:
     - name: DB_PASSWORD
       valueFrom:
         secretKeyRef:
           name: db-secrets
           key: password
   ```

2. **Or mount `databases.json` as ConfigMap** (without passwords, use env vars)

3. **Enable SSL/TLS for database connections** (add to future version)

## Troubleshooting

### Issue: "Pool not found"

**Error:** `Database pool not found: cloud1_db1`

**Cause:** Mismatch between frontend selection and backend configuration

**Solution:**
1. Check `databases.json` has database with name "db1" in cloud "cloud1"
2. Restart backend to reload configuration
3. Clear browser cache and reload frontend

### Issue: Environment variables not substituted

**Error:** Database connection fails with literal `${DB_PASSWORD}`

**Cause:** Environment variable not defined in `.env`

**Solution:**
1. Ensure `.env` file exists in `backend/` directory
2. Add missing variable: `DB_PASSWORD=your-password`
3. Restart backend (nodemon should auto-restart)

### Issue: "No schemas available"

**Symptom:** PostgreSQL Schema dropdown is empty

**Cause:** Empty `schemas` array and query to `information_schema` failed

**Solution:**
1. Pre-configure schemas in `databases.json`:
   ```json
   {
     "schemas": ["public", "your_app_schema"],
     "defaultSchema": "public"
   }
   ```
2. Or grant user access to `information_schema`:
   ```sql
   GRANT SELECT ON information_schema.schemata TO your_user;
   ```

### Issue: Connection timeout

**Error:** `Connection terminated due to connection timeout`

**Causes:**
- Database host not reachable from backend
- Firewall blocking port 5432
- Incorrect host/port configuration

**Solutions:**
1. Test connection manually:
   ```bash
   psql -h your-host -p 5432 -U your-user -d your-database
   ```
2. Check firewall rules allow backend IP
3. Verify host/port in `databases.json`

### Issue: Frontend shows old configuration

**Symptom:** Changed `databases.json` but frontend still shows old clouds/databases

**Solution:**
1. Restart backend (changes load on startup)
2. Clear browser localStorage:
   ```javascript
   localStorage.clear();
   ```
3. Hard refresh browser (Cmd+Shift+R or Ctrl+Shift+R)

## Configuration Validation

To validate your configuration without starting the full app:

```bash
cd backend
node -e "
  const fs = require('fs');
  const path = require('path');
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'config/databases.json'), 'utf-8')
      .replace(/\$\{([^}]+)\}/g, (match, varName) => process.env[varName] || match)
  );
  console.log('Configuration valid!');
  console.log('Primary cloud:', config.primary.cloudName);
  console.log('Primary databases:', config.primary.db_configs.length);
  console.log('Secondary clouds:', config.secondary.length);
"
```

Expected output:
```
Configuration valid!
Primary cloud: aws
Primary databases: 2
Secondary clouds: 1
```

## Summary

- ✅ Use `databases.json` for all database configuration
- ✅ Use environment variables for sensitive data
- ✅ Pre-configure schemas for better UX
- ✅ Keep `databases.example.json` in version control
- ✅ Never commit real credentials
- ✅ Restart backend after configuration changes

For more information, see the [main README](../README.md).
