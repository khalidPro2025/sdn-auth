#!/usr/bin/env bash
# Automatisation du lien local veth entre OVS br-vx (host) et s1 (dans le conteneur Mininet)
# Usage:
#   veth-link.sh create [MININET=mininet] [OVS_BR=br-vx] [S1=s1] [IF_MS=veth-ms] [IF_S1=veth-s1] [MTU=1450]
#   veth-link.sh delete [IF_MS=veth-ms] [IF_S1=veth-s1]
#   veth-link.sh status  [MININET=mininet] [OVS_BR=br-vx] [S1=s1] [IF_MS=veth-ms] [IF_S1=veth-s1]
set -euo pipefail

CMD="${1:-}"
shift || true

MININET="${MININET:-mininet}"
OVS_BR="${OVS_BR:-br-vx}"
S1="${S1:-s1}"
IF_MS="${IF_MS:-veth-ms}"
IF_S1="${IF_S1:-veth-s1}"
MTU="${MTU:-1450}"

# parse key=val or KEY=VAL args
for arg in "$@"; do
  case "$arg" in
    MININET=*) MININET="${arg#*=}";;
    OVS_BR=*)  OVS_BR="${arg#*=}";;
    S1=*)      S1="${arg#*=}";;
    IF_MS=*)   IF_MS="${arg#*=}";;
    IF_S1=*)   IF_S1="${arg#*=}";;
    MTU=*)     MTU="${arg#*=}";;
  esac
done

die(){ echo "ERROR: $*" >&2; exit 1; }

case "$CMD" in
  create)
    command -v docker >/dev/null || die "docker manquant"
    ovs-vsctl br-exists "$OVS_BR" || die "bridge $OVS_BR introuvable"

    # Crée la paire veth côté hôte
    ip link del "$IF_MS" 2>/dev/null || true
    ip link del "$IF_S1" 2>/dev/null || true
    ip link add "$IF_MS" type veth peer name "$IF_S1"
    ip link set "$IF_MS" up
    ip link set "$IF_S1" up
    ip link set dev "$IF_MS" mtu "$MTU"
    ip link set dev "$IF_S1" mtu "$MTU"

    # Attache IF_MS au bridge OVS
    ovs-vsctl --may-exist add-port "$OVS_BR" "$IF_MS"

    # Envoie IF_S1 dans le conteneur Mininet
    PID="$(docker inspect -f '{{.State.Pid}}' "$MININET" 2>/dev/null || true)"
    [ -n "$PID" ] && [ "$PID" != "0" ] || die "conteneur $MININET introuvable/running"
    ip link set "$IF_S1" netns "$PID"

    # Dans Mininet: up + add-port à s1 (OVS interne)
    docker exec "$MININET" sh -lc "
      ip link set $IF_S1 up || true;
      ovs-vsctl --may-exist add-port $S1 $IF_S1 || true;
      ip link set dev $S1 mtu $MTU || true
    "

    echo "[veth-link] create OK: $OVS_BR:$IF_MS <-> $MININET/$S1:$IF_S1 (MTU=$MTU)"
  ;;
  delete)
    # détache côté OVS
    ovs-vsctl del-port "$OVS_BR" "$IF_MS" 2>/dev/null || true
    # détruit interfaces (host et ns si présent)
    ip link del "$IF_MS" 2>/dev/null || true
    ip link del "$IF_S1" 2>/dev/null || true
    echo "[veth-link] delete OK: $IF_MS/$IF_S1"
  ;;
  status)
    echo "=== Host side ==="
    ip -br link 2>/dev/null | grep -E "$IF_MS|$IF_S1" || true
    echo "=== OVS $OVS_BR ==="
    ovs-vsctl show | sed -n "/Bridge $OVS_BR/,/Bridge/p" | sed '/^Bridge /,$!d'
    echo "=== Mininet $MININET ($S1) ==="
    docker exec "$MININET" sh -lc "ovs-vsctl show; ip -br link" || true
  ;;
  *)
    cat >&2 <<EOF
Usage:
  $0 create [MININET=mininet] [OVS_BR=br-vx] [S1=s1] [IF_MS=veth-ms] [IF_S1=veth-s1] [MTU=1450]
  $0 delete [IF_MS=veth-ms] [IF_S1=veth-s1]
  $0 status [MININET=mininet] [OVS_BR=br-vx] [S1=s1] [IF_MS=veth-ms] [IF_S1=veth-s1]
EOF
    exit 2
  ;;
esac
