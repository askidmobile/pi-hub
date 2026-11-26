-- Base commit at task start: changed files and commit checks are computed against it,
-- even if base_branch moves later (plan phase 3).
ALTER TABLE tasks ADD COLUMN base_commit TEXT;
