#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/backup-demo.sh"

if [[ "${1:-}" == '--help' ]]; then
  printf '%s\n' 'Usage: infra/reset-demo.sh --replace-local-demo' 'Builds a fresh migrated/seeded database, backs up the current demo, then atomically replaces its public schema.'
  exit 0
fi
[[ $# -eq 1 && "$1" == '--replace-local-demo' ]] || cq_fail 'Required: infra/reset-demo.sh --replace-local-demo'
cq_init
cq_require_offline_replacement
trap cq_cleanup EXIT
cq_prepare_tools
cq_make_stage
cq_stage_cli migrate
cq_stage_cli seed
cq_verify_stage
cq_prepare_sql
cq_replace_local reset
