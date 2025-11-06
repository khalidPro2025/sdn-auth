#!/usr/bin/env bash
# Usage: attach-overlay <container_name> <IP/CIDR> [BRIDGE=br-vx] [MTU=1450]
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <container> <IP/CIDR> [BRIDGE=br-vx] [MTU=1450]" >&2
  exit 2
fi

C="$1"; IP_CIDR="$2"; BR="${3:-br-vx}"; MTU="${4:-1450}"

command -v docker >/dev/null || { echo "docker manquant"; exit 1; }
ovs-vsctl br-exists "$BR" || { echo "bridge OVS $BR introuvable"; exit 1; }

PID="$(docker inspect -f '{{.State.Pid}}' "$C" 2>/dev/null || true)"
[ -n "$PID" ] && [ "$PID" != "0" ] || { echo "conteneur $C introuvable/running"; exit 1; }

short="$(echo -n "$C" | tr -cd '[:alnum:]' | head -c 10)"
VETH_HOST="veth-${short}"
VETH_CT="ct-${short}"

# Nettoyage si besoin
ip link del "$VETH_HOST" 2>/dev/null || true

# Crée et branche
ip link add "$VETH_HOST" type veth peer name "$VETH_CT"
ip link set "$VETH_HOST" up
ip link set "$VETH_HOST" mtu "$MTU"
ovs-vsctl --may-exist add-port "$BR" "$VETH_HOST"

ip link set "$VETH_CT" netns "$PID"
nsenter -t "$PID" -n ip link set "$VETH_CT" name eth1
nsenter -t "$PID" -n ip addr flush dev eth1 || true
nsenter -t "$PID" -n ip addr add "$IP_CIDR" dev eth1
nsenter -t "$PID" -n ip link set eth1 up
nsenter -t "$PID" -n ip link set eth1 mtu "$MTU"

echo "[attach-overlay] OK: $C -> $BR (eth1=$IP_CIDR, MTU=$MTU, host-port=$VETH_HOST)"
