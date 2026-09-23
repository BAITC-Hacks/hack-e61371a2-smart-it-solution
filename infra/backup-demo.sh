#!/usr/bin/env bash
set -euo pipefail
umask 077

# This file also provides the shared, guarded operations used by reset/restore.
CQ_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CQ_DB=""
CQ_DB_USER=""
CQ_HAS_WORKER="false"
CQ_STAGE=""
CQ_REPLACEMENT_SQL=""
CQ_BEFORE_BACKUP=""
CQ_REPLACED="false"
CQ_STOPPED="false"
CQ_RUNNING=()

cq_fail() { printf '%s\n' "$*" >&2; exit 1; }
cq_compose() { docker compose --project-directory "$CQ_ROOT" --file "$CQ_ROOT/compose.yaml" "$@"; }

cq_init() {
  command -v docker >/dev/null || cq_fail 'Docker CLI is required.'
  command -v python3 >/dev/null || cq_fail 'Python 3 is required for safe configuration validation.'
  case "${DOCKER_HOST:-}" in ''|unix://*) ;; *) cq_fail 'Only a local Docker Unix socket is allowed.' ;; esac
  local endpoint
  endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
  case "$endpoint" in unix://*) ;; *) cq_fail 'The active Docker context must be local.' ;; esac

  # Parse config in memory. Never print the rendered config or DATABASE_URL.
  local safe_config
  safe_config="$(cq_compose config --format json | python3 -c '
import json, re, sys
from urllib.parse import urlparse, unquote
try:
    cfg = json.load(sys.stdin)
    services = cfg["services"]
    back = services["back"]["environment"]
    database = services["db"]["environment"]
    if str(back.get("DEMO_MODE", "")).lower() != "true":
        raise ValueError()
    db = database["POSTGRES_DB"]
    user = database["POSTGRES_USER"]
    if not all(re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", x) for x in (db, user)):
        raise ValueError()
    url = urlparse(back["DATABASE_URL"])
    if url.scheme not in ("postgres", "postgresql") or url.hostname != "db" or (url.port or 5432) != 5432 or unquote(url.path) != "/" + db or unquote(url.username or "") != user:
        raise ValueError()
    origin = urlparse(back["APP_ORIGIN"])
    if origin.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError()
    for port in services["db"].get("ports", []):
        if port.get("host_ip") not in ("127.0.0.1", "::1"):
            raise ValueError()
    print(db, user, "true" if "worker" in services else "false")
except Exception:
    sys.exit("Refusing operation: compose must describe a local DEMO_MODE=true app using its own db service and loopback bindings.")
')" || cq_fail 'Demo configuration check failed; no database changes made.'
  read -r CQ_DB CQ_DB_USER CQ_HAS_WORKER <<< "$safe_config"

  local db_container container_root
  db_container="$(cq_compose ps -q db)"
  [[ -n "$db_container" && "$db_container" != *$'\n'* ]] || cq_fail 'Start the single local db service first: docker compose up -d db'
  container_root="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$db_container")"
  [[ "$container_root" == "$CQ_ROOT" ]] || cq_fail 'The running db container belongs to another workspace.'
  cq_compose exec -T db sh -c '[ "$POSTGRES_DB" = "$1" ] && [ "$POSTGRES_USER" = "$2" ]' sh "$CQ_DB" "$CQ_DB_USER" || cq_fail 'Running database settings differ from compose; refusing operation.'
  cq_compose exec -T db pg_isready --username "$CQ_DB_USER" --dbname "$CQ_DB" >/dev/null || cq_fail 'Local database is not ready.'
}

cq_backup() {
  local destination="${1:-$CQ_ROOT/backups/career-quest-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump}"
  mkdir -p "$(dirname "$destination")"
  destination="$(cd "$(dirname "$destination")" && pwd -P)/$(basename "$destination")"
  [[ ! -e "$destination" && ! -L "$destination" ]] || cq_fail 'Backup destination already exists; refusing overwrite.'
  local partial
  partial="$(mktemp "${destination}.partial.XXXXXX")"
  if ! cq_compose exec -T db pg_dump --username "$CQ_DB_USER" --dbname "$CQ_DB" --schema=public --format=custom --no-owner --no-acl > "$partial"; then
    rm -f "$partial"; cq_fail 'Backup failed; existing database was not changed.'
  fi
  if ! cq_compose exec -T db pg_restore --list < "$partial" >/dev/null; then
    rm -f "$partial"; cq_fail 'Backup archive validation failed.'
  fi
  chmod 600 "$partial"
  mv -n "$partial" "$destination"
  if [[ -e "$partial" ]]; then rm -f "$partial"; cq_fail 'Backup filename collision; choose another destination.'; fi
  python3 -c 'import hashlib,sys; p=sys.argv[1]; print(hashlib.sha256(open(p,"rb").read()).hexdigest())' "$destination" > "${destination}.sha256"
  chmod 600 "${destination}.sha256"
  printf '%s\n' "$destination"
}

cq_check_archive() {
  local archive="$1"
  [[ -f "$archive" && -r "$archive" ]] || cq_fail 'Provide a readable custom-format backup file.'
  cq_compose exec -T db pg_restore --list < "$archive" >/dev/null || cq_fail 'Invalid PostgreSQL backup archive.'
  if [[ -f "${archive}.sha256" ]]; then
    python3 -c 'import hashlib,sys; p=sys.argv[1]; expected=open(p+".sha256").read().strip(); actual=hashlib.sha256(open(p,"rb").read()).hexdigest(); sys.exit(0 if expected==actual else "Backup checksum mismatch")' "$archive" || cq_fail 'Backup integrity check failed.'
  fi
}

cq_prepare_tools() {
  local services=(back)
  [[ "$CQ_HAS_WORKER" != 'true' ]] || services+=(worker)
  cq_compose build "${services[@]}"
}

cq_require_unbilled_demo() {
  local database="${1:-$CQ_DB}" table charges
  table="$(cq_compose exec -T db psql -X -A -t --set ON_ERROR_STOP=1 --username "$CQ_DB_USER" --dbname "$database" --command "SELECT COALESCE(to_regclass('public.ai_usage')::text,'');")"
  if [[ -n "$table" ]]; then
    charges="$(cq_compose exec -T db psql -X -A -t --set ON_ERROR_STOP=1 --username "$CQ_DB_USER" --dbname "$database" --command "SELECT count(*) FROM ai_usage WHERE status='reserved' OR COALESCE(cost_microusd,0)>0;")"
    [[ "$charges" == '0' ]] || cq_fail 'Paid or unresolved AI usage exists. Demo replacement is blocked to preserve the spend limit; use the controlled recovery procedure.'
  fi
}

cq_require_offline_replacement() {
  cq_compose config --format json | python3 -c '
import json,sys
try:
    services=json.load(sys.stdin)["services"]
    for name in ("back", "worker"):
        settings=services.get(name,{}).get("environment",{})
        if str(settings.get("AI_ENABLED","false")).lower() != "false" or str(settings.get("WORKER_DELIVERY_ENABLED","false")).lower() != "false":
            raise ValueError()
except Exception:
    sys.exit("Set AI_ENABLED=false and WORKER_DELIVERY_ENABLED=false before replacing the local demo.")
' || cq_fail 'External calls must be disabled for a demo replacement.'
  cq_require_unbilled_demo
}

cq_make_stage() {
  CQ_STAGE="cq_demo_stage_$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
  cq_compose exec -T db createdb --username "$CQ_DB_USER" --owner "$CQ_DB_USER" --template template0 "$CQ_STAGE"
}

cq_stage_cli() {
  # Change only the database name inside the container. No password appears in argv or output.
  cq_compose run --rm --no-deps -e AI_ENABLED=false -e WORKER_DELIVERY_ENABLED=false back node -e '
const {spawnSync}=require("node:child_process");
const url=new URL(process.env.DATABASE_URL);
url.pathname="/"+process.argv[1];
const result=spawnSync(process.execPath,["dist/src/cli.js",process.argv[2]],{stdio:"inherit",env:{...process.env,DATABASE_URL:url.toString(),AI_ENABLED:"false",WORKER_DELIVERY_ENABLED:"false"}});
process.exit(result.status ?? 1);
' "$CQ_STAGE" "$1"
}

cq_verify_stage() {
  local verdict
  verdict="$(cq_compose exec -T db psql -X -A -t --set ON_ERROR_STOP=1 --username "$CQ_DB_USER" --dbname "$CQ_STAGE" --command "SELECT CASE WHEN (SELECT count(*) FROM employees)>=200 AND (SELECT count(*) FROM skills)>=60 AND (SELECT count(*) FROM events)>=40 AND (SELECT count(*) FROM participations)>=2743 AND (SELECT count(*) FROM user_accounts WHERE demo_only)>=4 AND (SELECT count(*) FROM guide_articles WHERE synthetic)>=15 THEN 'ok' ELSE 'invalid' END;")"
  [[ "$verdict" == 'ok' ]] || cq_fail 'Staged dataset verification failed; the running database was not replaced.'
  cq_require_unbilled_demo "$CQ_STAGE"
  # Restoring a backup must not reactivate cookies that were previously logged out or revoked.
  cq_compose exec -T db psql -X --quiet --set ON_ERROR_STOP=1 --username "$CQ_DB_USER" --dbname "$CQ_STAGE" --command 'UPDATE sessions SET revoked_at=COALESCE(revoked_at,now());' >/dev/null
}

cq_prepare_sql() {
  mkdir -p "$CQ_ROOT/backups"
  CQ_REPLACEMENT_SQL="$(mktemp "$CQ_ROOT/backups/.prepared-restore.XXXXXX")"
  chmod 600 "$CQ_REPLACEMENT_SQL"
  # Render completely before opening the replacement transaction. A broken producer cannot commit a partial stream.
  printf 'DROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n' > "$CQ_REPLACEMENT_SQL"
  cq_compose exec -T db pg_dump --username "$CQ_DB_USER" --dbname "$CQ_STAGE" --schema=public --format=plain --clean --if-exists --no-owner --no-acl >> "$CQ_REPLACEMENT_SQL"
}

cq_stop_writers() {
  local service
  while IFS= read -r service; do
    case "$service" in back|front|worker) CQ_RUNNING+=("$service") ;; esac
  done < <(cq_compose ps --services --status running)
  if [[ ${#CQ_RUNNING[@]} -gt 0 ]]; then cq_compose stop "${CQ_RUNNING[@]}"; fi
  CQ_STOPPED='true'
}

cq_replace_local() {
  local label="$1"
  cq_stop_writers
  cq_require_unbilled_demo
  CQ_BEFORE_BACKUP="$(cq_backup "$CQ_ROOT/backups/before-${label}-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump")"
  printf 'Recovery backup: %s\n' "$CQ_BEFORE_BACKUP"
  # Public schema replacement is transactional, including DDL and imported records.
  cq_compose exec -T db psql -X --quiet --single-transaction --set ON_ERROR_STOP=1 --username "$CQ_DB_USER" --dbname "$CQ_DB" < "$CQ_REPLACEMENT_SQL" >/dev/null
  CQ_REPLACED='true'
  if [[ ${#CQ_RUNNING[@]} -gt 0 ]]; then cq_compose up -d --no-deps "${CQ_RUNNING[@]}"; fi
  CQ_STOPPED='false'
  printf 'Local demo %s completed. Previously running app services were restarted.\n' "$label"
}

cq_cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$CQ_STAGE" && "$CQ_STAGE" =~ ^cq_demo_stage_[0-9a-f]{32}$ ]]; then
    cq_compose exec -T db dropdb --username "$CQ_DB_USER" --if-exists "$CQ_STAGE" >/dev/null 2>&1 || printf 'Temporary database requires manual cleanup: %s\n' "$CQ_STAGE" >&2
  fi
  [[ -z "$CQ_REPLACEMENT_SQL" ]] || rm -f "$CQ_REPLACEMENT_SQL"
  if [[ $status -ne 0 ]]; then
    if [[ "$CQ_REPLACED" == 'true' ]]; then printf '%s\n' 'Replacement committed, but restarting services failed. Inspect service health before retrying.' >&2;
    else printf '%s\n' 'Replacement did not commit. The original public schema remains in place.' >&2; fi
    [[ "$CQ_STOPPED" != 'true' ]] || printf '%s\n' 'App services remain stopped. Inspect the failure, then restart with docker compose up -d.' >&2
    [[ -z "$CQ_BEFORE_BACKUP" ]] || printf 'Recovery backup: %s\n' "$CQ_BEFORE_BACKUP" >&2
  fi
  exit "$status"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ "${1:-}" == '--help' ]]; then printf '%s\n' 'Usage: infra/backup-demo.sh [output.dump]' 'Creates a read-only backup of the guarded local demo. Existing files are never overwritten.'; exit 0; fi
  [[ $# -le 1 ]] || cq_fail 'Usage: infra/backup-demo.sh [output.dump]'
  cq_init
  cq_backup "${1:-}"
fi
