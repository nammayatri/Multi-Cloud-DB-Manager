-- ============================================
-- Migration 006: Config Replicate
--
-- Copies configuration rows from one value of a "dimension" column to another
-- (e.g. merchant_operating_city_id 5 -> 9) across a fixed set of tables, in one
-- transaction, after a human has reviewed and ticked every row.
--
-- A GROUP is the reusable half: which dimension column, which tables, how each
-- table's rows are matched, and what each column means (copied vs regenerated
-- vs stamped with NOW()). A RUN is the disposable half: this group, this
-- database, this cloud, base value -> new value, on this date, by this person.
--
-- The group definition is SNAPSHOTTED onto the run (group_snapshot). Groups are
-- edited over time; without the snapshot an old run's audit record would be
-- read through today's configuration and quietly misdescribe what actually ran.
--
-- Per-statement detail lives in its own table rather than a JSONB column on the
-- run: the interesting audit question is "which rows changed", and that has to
-- be filterable and joinable, not a blob.
--
-- Idempotent -- safe to re-run.
-- ============================================

CREATE TABLE IF NOT EXISTS dual_db_manager.config_replicate_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Shown in the run picker, so it has to be unambiguous.
    name VARCHAR(200) NOT NULL,
    description TEXT,

    -- One or more columns that together identify a dimension value: a config may
    -- be scoped by a city, or by a merchant AND a city. Individual tables may
    -- spell each one differently, so these are the group's labels for the
    -- concepts, not column references. Order is significant -- it is what aligns
    -- a table's spellings and a run's values to the right concept.
    dimension_columns TEXT[] NOT NULL,

    -- SET NULL, not CASCADE: a group outlives whoever created it, and deleting
    -- a user must not silently destroy shared configuration.
    created_by UUID REFERENCES dual_db_manager.users(id) ON DELETE SET NULL,

    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP,

    CONSTRAINT config_replicate_groups_name_check CHECK (length(btrim(name)) > 0),
    CONSTRAINT config_replicate_groups_dimensions_check CHECK (array_length(dimension_columns, 1) >= 1)
);

-- Case-insensitive: "City Config" and "city config" are the same group to a
-- human scanning the picker, and two of them would be a support ticket.
CREATE UNIQUE INDEX IF NOT EXISTS idx_config_replicate_groups_name
    ON dual_db_manager.config_replicate_groups(lower(btrim(name)));

CREATE TABLE IF NOT EXISTS dual_db_manager.config_replicate_group_tables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL
        REFERENCES dual_db_manager.config_replicate_groups(id) ON DELETE CASCADE,

    schema_name VARCHAR(200) NOT NULL,
    table_name  VARCHAR(200) NOT NULL,

    -- This table's own name for each dimension, positionally aligned with the
    -- group's. Frequently differs (merchant_operating_city_id vs city_id vs moc_id).
    dimension_columns TEXT[] NOT NULL,

    -- Parent-before-child order, and the order rows are rendered in. Apply
    -- walks INSERTs forward and DELETEs backward through this, which is the
    -- only FK ordering guarantee the module offers.
    position INTEGER NOT NULL DEFAULT 0,

    -- AUTO: prefer a unique key that contains the dimension column, fall back
    -- to similarity. UNIQUE_KEY / SIMILARITY force one or the other, so a table
    -- whose "unique" key is actually semantically wrong can be overridden.
    match_strategy VARCHAR(20) NOT NULL DEFAULT 'AUTO',

    -- Pinned key columns for UNIQUE_KEY (dimension column excluded). Empty for
    -- AUTO, where the key is rediscovered at analyze time -- schemas change, and
    -- a stale pinned key would pair the wrong rows rather than fail loudly.
    match_key_columns TEXT[] NOT NULL DEFAULT '{}',

    -- { "<column>": "DIMENSION" | "MATCH_KEY" | "GENERATED" | "TIMESTAMP" | "COPIED" | "IGNORED" }
    -- Seeded by auto-detection at group-creation time, then hand-editable.
    -- Columns absent from this map fall back to auto-detection at analyze time,
    -- so a column added to the table later is classified rather than dropped.
    column_config JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- { "<column>": "<schema>.<table>" } -- this column is an FK whose value must
    -- be rewritten through the run's old-id -> new-id map when the referenced
    -- parent row is itself being inserted. Explicitly configured, never guessed:
    -- introspected FKs only pre-fill the wizard.
    fk_remap JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT config_replicate_group_tables_strategy_check CHECK (
        match_strategy IN ('AUTO', 'UNIQUE_KEY', 'SIMILARITY')
    )
);

-- A table may appear in a group only once, otherwise its rows would be
-- classified twice and applied twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_config_replicate_group_tables_unique
    ON dual_db_manager.config_replicate_group_tables(group_id, schema_name, table_name);

CREATE INDEX IF NOT EXISTS idx_config_replicate_group_tables_group
    ON dual_db_manager.config_replicate_group_tables(group_id, position);

CREATE TABLE IF NOT EXISTS dual_db_manager.config_replicate_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- SET NULL: deleting a group must not erase the record of what it did.
    group_id UUID REFERENCES dual_db_manager.config_replicate_groups(id) ON DELETE SET NULL,
    group_name VARCHAR(200) NOT NULL,
    -- The group exactly as it was when this run executed. See header.
    group_snapshot JSONB NOT NULL,

    database_name VARCHAR(100) NOT NULL,
    -- One cloud per run: the whole thing is a single transaction on a single
    -- connection, so there is no coherent meaning for "both".
    cloud_name VARCHAR(100) NOT NULL,

    -- Text, not typed: a dimension may be integer, uuid or text depending on the
    -- table. Values are only ever sent back to Postgres as parameters.
    base_values TEXT[] NOT NULL,
    new_values  TEXT[] NOT NULL,

    -- ABORTED is drift, not failure: the data moved between analyze and apply,
    -- so nothing was attempted. FAILED means statements ran and rolled back.
    status VARCHAR(20) NOT NULL DEFAULT 'RUNNING',

    applied_by UUID REFERENCES dual_db_manager.users(id) ON DELETE SET NULL,
    applied_by_username VARCHAR(200),

    -- Per-table counts + which match method each table used, for the run detail
    -- view. Row-level detail is in config_replicate_run_items.
    summary JSONB,

    rows_inserted INTEGER NOT NULL DEFAULT 0,
    rows_updated  INTEGER NOT NULL DEFAULT 0,
    rows_deleted  INTEGER NOT NULL DEFAULT 0,

    -- First error out of the transaction. Non-null implies status FAILED.
    error TEXT,
    duration_ms INTEGER,

    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMP,

    CONSTRAINT config_replicate_runs_status_check CHECK (
        status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'ABORTED')
    ),
    CONSTRAINT config_replicate_runs_values_differ CHECK (base_values <> new_values)
);

CREATE INDEX IF NOT EXISTS idx_config_replicate_runs_recent
    ON dual_db_manager.config_replicate_runs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_config_replicate_runs_group
    ON dual_db_manager.config_replicate_runs(group_id, created_at DESC);

-- One row per statement actually issued. Written AFTER the target transaction
-- resolves, in a separate transaction against the metadata DB -- the target DB
-- and the metadata DB are different servers, so there is no way to make the
-- audit write atomic with the data write. Recording intent up front and outcome
-- after would double the write volume for no extra truth; on a rollback nothing
-- changed in the target, and the failed run row alone says so.
CREATE TABLE IF NOT EXISTS dual_db_manager.config_replicate_run_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL
        REFERENCES dual_db_manager.config_replicate_runs(id) ON DELETE CASCADE,

    schema_name VARCHAR(200) NOT NULL,
    table_name  VARCHAR(200) NOT NULL,
    operation   VARCHAR(10)  NOT NULL,

    -- The analyze-time identity of the row, echoed back by the client on apply.
    -- Lets a run be replayed against a fresh analyze and diffed.
    diff_id TEXT NOT NULL,

    -- Parameterized SQL and its bound values, stored separately and never
    -- interpolated together. This is the record of what ran, not something to
    -- re-execute.
    sql TEXT NOT NULL,
    params JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Column-level old -> new for UPDATEs; the inserted row for INSERTs; the
    -- removed row for DELETEs.
    row_diff JSONB,

    -- NULL when the transaction rolled back before this statement ran.
    rows_affected INTEGER,
    position INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT config_replicate_run_items_operation_check CHECK (
        operation IN ('INSERT', 'UPDATE', 'DELETE')
    )
);

CREATE INDEX IF NOT EXISTS idx_config_replicate_run_items_run
    ON dual_db_manager.config_replicate_run_items(run_id, position);

GRANT ALL ON dual_db_manager.config_replicate_groups TO db_user;
GRANT ALL ON dual_db_manager.config_replicate_group_tables TO db_user;
GRANT ALL ON dual_db_manager.config_replicate_runs TO db_user;
GRANT ALL ON dual_db_manager.config_replicate_run_items TO db_user;
