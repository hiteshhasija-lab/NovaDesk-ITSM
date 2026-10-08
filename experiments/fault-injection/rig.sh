#!/usr/bin/env bash
# Isolated fault-injection rig for the decommission workflow. Runs on NOVAAPP01 as the
# normal user and touches NONE of the production containers, databases, ports or ESXi hosts:
#   - one podman pod "fi-lab" with its own network namespace (no LAN exposure; only
#     127.0.0.1:18080 -> NovaDesk and 127.0.0.1:18082 -> stub control are published, loopback only)
#   - fi-postgres  : a throwaway postgres:16 with its own database and credentials
#   - fi-novadesk  : the SAME image that is deployed in production, pointed at the throwaway DB
#                    and at the stub receiver. ESXi is the stub too: bin/govc (first on PATH) is a
#                    shim that forwards to the stub's ESXi model on the pod's loopback and never
#                    opens a network connection, and the ESXi credentials are dummies, so the rig
#                    cannot touch a real host or VM
#   - fi-stub      : stand-in for NovaConnect's three integration endpoints and for ESXi (govc),
#                    with fault modes
#
# Usage: rig.sh up [image] | down | status | restart-novadesk | logs [container]
set -Eeuo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POD=fi-lab
IMAGE="${2:-localhost/novadesk:0.0.64}"
KEY=fi-test-key

up() {
  if podman pod exists "$POD"; then echo "Pod $POD already exists (use: rig.sh down)"; exit 1; fi
  podman image exists "$IMAGE" || { echo "Image $IMAGE not found"; exit 1; }

  podman pod create --name "$POD" \
    --publish 127.0.0.1:18080:8080 \
    --publish 127.0.0.1:18082:18082 >/dev/null

  podman run -d --pod "$POD" --name fi-postgres \
    -e POSTGRES_USER=fi -e POSTGRES_PASSWORD=fi_pw -e POSTGRES_DB=fi \
    docker.io/library/postgres:16 >/dev/null
  # First start runs initdb against a temporary server that then restarts, so one successful
  # probe is not enough: require several consecutive real queries.
  ok=0
  for _ in $(seq 1 90); do
    if [ "$(podman exec fi-postgres psql -U fi -d fi -tAc 'select 1' 2>/dev/null || true)" = "1" ]; then
      ok=$((ok + 1)); [ "$ok" -ge 4 ] && break
    else
      ok=0
    fi
    sleep 1
  done
  [ "$ok" -ge 4 ] || { echo "Postgres did not become ready"; exit 1; }

  chmod +x "$DIR/bin/govc"
  podman run -d --pod "$POD" --name fi-stub \
    -v "$DIR:/fi:ro,Z" \
    -e SYNC_API_KEY="$KEY" \
    "$IMAGE" node /fi/stub.js >/dev/null

  podman run -d --pod "$POD" --name fi-novadesk \
    -e PORT=8080 -e HOST=0.0.0.0 -e HTTPS_PORT=8443 \
    -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGUSER=fi -e PGPASSWORD=fi_pw -e PGDATABASE=fi \
    -e SESSION_SECRET=fi-session-secret -e SYNC_API_KEY="$KEY" \
    -e NOVACONNECT_BASE_URL=http://127.0.0.1:18081 \
    -e DECOM_SOAK_PERIOD_HOURS=0.01 \
    -v "$DIR/bin:/fi/bin:ro,Z" -e PATH=/fi/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    -e ESXI_USER=fi-stub-user -e ESXI_PASSWORD=fi-stub-password \
    -e ESXI_POWER_TIMEOUT_S="${ESXI_POWER_TIMEOUT_S:-15}" -e ESXI_DESTROY_TIMEOUT_S="${ESXI_DESTROY_TIMEOUT_S:-45}" \
    -e CARD_SYNC_POLL_S="${CARD_SYNC_POLL_S:-5}" -e CARD_SYNC_BACKOFF_BASE_S="${CARD_SYNC_BACKOFF_BASE_S:-5}" \
    -e CARD_SYNC_BACKOFF_MAX_S="${CARD_SYNC_BACKOFF_MAX_S:-20}" -e CARD_SYNC_DEAD_AFTER="${CARD_SYNC_DEAD_AFTER:-3}" \
    "$IMAGE" >/dev/null

  for _ in $(seq 1 60); do
    curl -fsS http://127.0.0.1:18080/health >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS http://127.0.0.1:18080/health && echo
  curl -fsS http://127.0.0.1:18082/state >/dev/null && echo "stub control OK"
  govc_path="$(podman exec fi-novadesk sh -c 'command -v govc' || true)"
  [ "$govc_path" = "/fi/bin/govc" ] || { echo "SAFETY: govc in the rig resolves to '$govc_path', not the stub shim; tearing down"; podman pod rm -f "$POD" >/dev/null; exit 1; }
  podman exec fi-novadesk govc about | head -1 | grep -q "VMware ESXi" || { echo "SAFETY: the govc shim did not answer from the stub model; tearing down"; podman pod rm -f "$POD" >/dev/null; exit 1; }
  echo "Rig up. govc -> $govc_path (stub shim); ESXI_USER='$(podman exec fi-novadesk printenv ESXI_USER)' (dummy)"
}

down() {
  podman pod exists "$POD" || { echo "No pod $POD"; return 0; }
  podman pod rm -f "$POD" >/dev/null
  echo "Rig removed."
}

status() {
  podman pod ps --filter "name=$POD" --format '{{.Name}} {{.Status}}' || true
  podman ps -a --filter "pod=$POD" --format '{{.Names}} {{.Status}}' || true
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  restart-novadesk) podman restart fi-novadesk >/dev/null && for _ in $(seq 1 60); do curl -fsS http://127.0.0.1:18080/health >/dev/null 2>&1 && break; sleep 1; done && echo restarted ;;
  logs) podman logs --tail 80 "${2:-fi-novadesk}" ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
