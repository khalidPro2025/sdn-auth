
#!/usr/bin/env bash
# Ajoute (ou vérifie) un port VXLAN dans le conteneur Mininet vers l'hôte micro-services
# Usage: add-mininet-vxlan [REMOTE_IP=192.168.1.10] [VNI=100] [MININET_NAME=mininet] [BRIDGE_S1=s1]
set -euo pipefail

REMOTE_IP="${1:-192.168.1.10}"
VNI="${2:-100}"
MCTN="${3:-mininet}"
BRIDGE="${4:-s1}"

if ! docker inspect "$MCTN" >/dev/null 2>&1; then
  echo "ERROR: conteneur Mininet '$MCTN' introuvable" >&2
  exit 1
fi

cmd=(ovs-vsctl --may-exist add-port "$BRIDGE" vx-to-micro
      -- set interface vx-to-micro type=vxlan
         options:key="$VNI" options:remote_ip="$REMOTE_IP" options:dst_port="4789")

docker exec "$MCTN" sh -lc "$(printf '%q ' "${cmd[@]}")"
docker exec "$MCTN" sh -lc "ip link set dev $BRIDGE mtu 1450 || true"

echo "[add-mininet-vxlan] OK: $MCTN/$BRIDGE -> VXLAN key=$VNI remote_ip=$REMOTE_IP dst_port=4789"
echo "Astuce Mininet: assigne des IP overlay aux hôtes ex. 'h1 ip a add 10.99.0.21/24 dev h1-eth0'"
