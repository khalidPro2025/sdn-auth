#!/usr/bin/env bash
set -euo pipefail

log(){ printf '%s %s\n' "[$(date -Is)]" "$*"; }

# ---- Paramètres (overridables) ----
BRIDGE_NAME="${BRIDGE_NAME:-br-vx}"
VXLAN_KEY="${VXLAN_KEY:-100}"
WAN_IF="${WAN_IF:-enp0s3}"
LOCAL_IP="${LOCAL_IP:-192.168.1.12}"    
 # IP du serveur micro-services (OVS-B)
PEERS="${PEERS:-192.168.1.19}"          
 # IP du serveur SDN (OVS-A)
MTU="${MTU:-1450}"
OF_VERSION="${OF_VERSION:-OpenFlow13}"
ODL_ADDR="${ODL_ADDR:-192.168.1.19:6653}" 
# contrôleur ODL côté SDN
OF_SSL="${OF_SSL:-false}"

log "OVS-B starting:
  BRIDGE_NAME=$BRIDGE_NAME
  VXLAN_KEY=$VXLAN_KEY
  WAN_IF=$WAN_IF
  LOCAL_IP=$LOCAL_IP
  PEERS=$PEERS
  MTU=$MTU
  OF_VERSION=$OF_VERSION
  ODL_ADDR=$ODL_ADDR
  OF_SSL=$OF_SSL
"

modprobe openvswitch 2>/dev/null || true

if [ "$LOCAL_IP" = "auto" ]; then
  LOCAL_IP=$(ip -4 addr show "$WAN_IF" | awk '/inet /{print $2}' | cut -d/ -f1 | head -n1 || true)
fi
[ -n "$LOCAL_IP" ] || { log "ERROR: LOCAL_IP introuvable"; exit 1; }

if ! pgrep -x ovsdb-server >/dev/null 2>&1; then
  /usr/share/openvswitch/scripts/ovs-ctl start --system-id=random || true
fi
for i in {1..40}; do [ -S /var/run/openvswitch/db.sock ] && break; sleep 0.5; done
[ -S /var/run/openvswitch/db.sock ] || { log "ERROR: OVS DB socket indisponible"; exit 1; }

ovs-vsctl --may-exist add-br "$BRIDGE_NAME"
ovs-vsctl set bridge "$BRIDGE_NAME" protocols="$OF_VERSION" fail-mode=secure || true
ip link set "$BRIDGE_NAME" up || true
ip link set "$BRIDGE_NAME" mtu "$MTU" || true

idx=0
IFS=',' read -ra P <<< "$PEERS"
for peer in "${P[@]}"; do
  peer="$(echo "$peer" | xargs)"; [ -z "$peer" ] && continue
  name="vxlan-$idx"
  ovs-vsctl --may-exist add-port "$BRIDGE_NAME" "$name" \
    -- set interface "$name" type=vxlan \
       options:remote_ip="$peer" \
       options:local_ip="$LOCAL_IP" \
       options:key="$VXLAN_KEY" \
       options:dst_port="4789" mtu_request="$MTU"
  idx=$((idx+1))
done

CTRL="tcp:$ODL_ADDR"
[ "$OF_SSL" = "true" ] && CTRL="ssl:$ODL_ADDR"
ovs-vsctl set-controller "$BRIDGE_NAME" "$CTRL" || true
ovs-vsctl set-manager ptcp:6640 || true

ovs-vsctl show
ovs-ofctl -O "$OF_VERSION" show "$BRIDGE_NAME" 2>/dev/null || true

log "OVS-B prêt (bridge=$BRIDGE_NAME)."
tail -F /var/log/openvswitch/ovs-vswitchd.log /var/log/openvswitch/ovsdb-server.log
