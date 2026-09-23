#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/backup-demo.sh"

if [[ "${1:-}" == '--help' ]]; then
  printf '%s\n' 'Usage: infra/restore-demo.sh --replace-local-demo path/to/backup.dump' 'Validates/restores in a temporary database, migrates and seeds, backs up the current demo, then atomically replaces its public schema.'
  exit 0
fi
[[ $# -eq 2 && "$1" == '--replace-local-demo' ]] || cq_fail 'Required: infra/restore-demo.sh --replace-local-demo path/to/backup.dump'
CQ_SOURCE_ARCHIVE="$2"
cq_init
cq_require_offline_replacement
cq_check_archive "$CQ_SOURCE_ARCHIVE"
trap cq_cleanup EXIT
cq_prepare_tools
cq_make_stage
cq_compose exec -T db pg_restore --username "$CQ_DB_USER" --dbname "$CQ_STAGE" --schema=public --no-owner --no-acl --clean --if-exists --exit-on-error --single-transaction < "$CQ_SOURCE_ARCHIVE"
cq_stage_cli migrate
cq_stage_cli seed
cq_verify_stage
cq_prepare_sql
cq_replace_local restore
