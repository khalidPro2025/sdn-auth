FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openvswitch-switch iproute2 iputils-ping jq ca-certificates util-linux \
      docker.io \
    && rm -rf /var/lib/apt/lists/*

# Entrypoint actuel (démarre OVS + bridge + ports VXLAN + controller)
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Outils d’intégration overlay depuis CE conteneur
COPY tools/attach-overlay.sh /usr/local/bin/attach-overlay
COPY tools/veth-link.sh         /usr/local/bin/veth-link
RUN chmod +x /usr/local/bin/attach-overlay  /usr/local/bin/veth-link


# Defaults (surchargés par docker-compose)
ENV BRIDGE_NAME=br-vx \
    VXLAN_KEY=100 \
    ODL_ADDR=192.168.1.19:6653 \
    WAN_IF=enp0s3 \
    LOCAL_IP=192.168.1.12 \
    PEERS=192.168.1.19 \
    MTU=1450 \
    OF_VERSION=OpenFlow13

ENTRYPOINT ["/entrypoint.sh"]
