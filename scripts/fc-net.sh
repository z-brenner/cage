#!/usr/bin/env bash
# Host networking for cage Firecracker VMs. Needs root. Idempotent.
#
#   sudo scripts/fc-net.sh up <index> <owner-user>   create TAP cage<index> (owned by user) + firewall
#   sudo scripts/fc-net.sh down <index>              remove TAP cage<index>
#   sudo scripts/fc-net.sh firewall                  (re)apply firewall/NAT rules only
#   sudo scripts/fc-net.sh teardown                  remove all cage rules and TAPs
#
# Each VM N gets a /30: host 172.30.N.1 <-> guest 172.30.N.2. Policy:
#   - VMs reach the internet (NAT out of the default-route interface)
#   - VMs CANNOT reach: the host itself (except replies to host-initiated SSH), each other,
#     private/LAN ranges, link-local (incl. cloud metadata 169.254.169.254), CGNAT/Tailscale ranges
# TAPs do not survive a host reboot; run `up` again (or add it to a systemd unit).
set -euo pipefail

BASE="${CAGE_SUBNET_BASE:-172.30}"
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }

wan_if() { ip -4 route show default | awk '{for (i=1;i<NF;i++) if ($i=="dev") {print $(i+1); exit}}'; }

chain() { # chain <table> <name>: create or flush
  iptables -t "$1" -N "$2" 2>/dev/null || iptables -t "$1" -F "$2"
}
hook() { # hook <table> <parent> <args...>: insert jump once
  local t="$1" p="$2"; shift 2
  iptables -t "$t" -C "$p" "$@" 2>/dev/null || iptables -t "$t" -I "$p" 1 "$@"
}

firewall() {
  local wan; wan="$(wan_if)"
  [ -n "$wan" ] || { echo "no default route; cannot set up NAT" >&2; exit 1; }
  sysctl -qw net.ipv4.ip_forward=1

  chain filter CAGE-FWD
  iptables -A CAGE-FWD -o cage+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -A CAGE-FWD -i cage+ -o cage+ -j DROP
  for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8; do
    iptables -A CAGE-FWD -i cage+ -d "$net" -j DROP
  done
  iptables -A CAGE-FWD -i cage+ -o "$wan" -j ACCEPT
  iptables -A CAGE-FWD -i cage+ -j DROP
  hook filter FORWARD -j CAGE-FWD

  chain filter CAGE-IN
  iptables -A CAGE-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -A CAGE-IN -j DROP
  hook filter INPUT -i cage+ -j CAGE-IN

  chain nat CAGE-NAT
  iptables -t nat -A CAGE-NAT -s "$BASE.0.0/16" -o "$wan" -j MASQUERADE
  hook nat POSTROUTING -j CAGE-NAT
  echo "firewall: VMs -> internet via $wan; host/LAN/metadata/inter-VM blocked"
}

up() {
  local idx="${1:?index}" owner="${2:?owner user}" tap="cage$1"
  [[ "$idx" =~ ^[0-9]+$ ]] && [ "$idx" -ge 1 ] && [ "$idx" -le 250 ] || { echo "index must be 1..250" >&2; exit 1; }
  if ! ip link show "$tap" >/dev/null 2>&1; then
    ip tuntap add dev "$tap" mode tap user "$owner"
  fi
  ip addr replace "$BASE.$idx.1/30" dev "$tap"
  ip link set "$tap" up
  sysctl -qw "net.ipv6.conf.$tap.disable_ipv6=1" || true
  firewall
  echo "$tap: host $BASE.$idx.1 <-> guest $BASE.$idx.2 (owner $owner)"
}

down() {
  ip link del "cage${1:?index}" 2>/dev/null || true
}

teardown() {
  for t in $(ip -o link show | awk -F': ' '{print $2}' | grep -E '^cage[0-9]+$' || true); do ip link del "$t"; done
  iptables -D FORWARD -j CAGE-FWD 2>/dev/null || true
  iptables -D INPUT -i cage+ -j CAGE-IN 2>/dev/null || true
  iptables -t nat -D POSTROUTING -j CAGE-NAT 2>/dev/null || true
  for c in CAGE-FWD CAGE-IN; do iptables -F "$c" 2>/dev/null || true; iptables -X "$c" 2>/dev/null || true; done
  iptables -t nat -F CAGE-NAT 2>/dev/null || true; iptables -t nat -X CAGE-NAT 2>/dev/null || true
  echo "cage networking removed"
}

case "${1:-}" in
  up) up "${2:-}" "${3:-}" ;;
  down) down "${2:-}" ;;
  firewall) firewall ;;
  teardown) teardown ;;
  *) sed -n '2,14p' "$0"; exit 2 ;;
esac
