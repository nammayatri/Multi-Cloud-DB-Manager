-- Config Replicate: composite-capable table links.
--
-- fk_remap could only ever say "this one column points at that table", and
-- resolved the parent by its primary key -- so a parent keyed on more than one
-- column silently took part in nothing. fk_links replaces it with an explicit
-- list of {child columns -> parent table (parent columns)} of any arity.
--
-- fk_remap is left in place and still written for single-column links, so a
-- rollback to the previous build keeps working. An empty parentColumns on a
-- link means "the parent's primary key", which is how a group saved before this
-- migration is read back.

ALTER TABLE dual_db_manager.config_replicate_group_tables
  ADD COLUMN IF NOT EXISTS fk_links JSONB NOT NULL DEFAULT '[]'::jsonb;
