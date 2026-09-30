#!/bin/bash
# Firecracker guest boot hook (runs before sshd). Reads its settings from the kernel command line:
#   cage.ip=172.30.N.2/30 cage.gw=172.30.N.1 cage.hostname=cage-x cage.key=<base64 ssh pubkey>
# Deliberately NOT `set -e`: SSH reachability comes first, and a failure in a later step
# (DNS, hostname) must never leave the VM unreachable. Problems go to the journal/console.
set -u
CMDLINE="${CAGE_CMDLINE:-/proc/cmdline}"
warn() { echo "cage-init: $*" >&2; }

IP='' GW='' HN='' KEY=''
for kv in $(cat "$CMDLINE"); do
  case "$kv" in
    cage.ip=*) IP="${kv#cage.ip=}" ;;
    cage.gw=*) GW="${kv#cage.gw=}" ;;
    cage.hostname=*) HN="${kv#cage.hostname=}" ;;
    cage.key=*) KEY="$(printf '%s' "${kv#cage.key=}" | base64 -d 2>/dev/null)" || warn "bad cage.key" ;;
  esac
done

# 1. SSH: per-VM host keys (the image ships none) and the host's key for the cage user.
ssh-keygen -A >/dev/null || warn "ssh-keygen -A failed"

# Only mount a disk that is really ours (label set by mkfs in the host backend).
if [ -b /dev/vdb ] && [ "$(blkid -s LABEL -o value /dev/vdb 2>/dev/null)" = cagedata ] && ! mountpoint -q /home/cage; then
  mount -o noatime /dev/vdb /home/cage || warn "could not mount data disk /dev/vdb"
fi
if [ ! -e /home/cage/.cage-home ]; then
  cp -rT /etc/skel /home/cage && touch /home/cage/.cage-home
fi
chown cage:cage /home/cage && chmod 750 /home/cage
if [ -n "$KEY" ]; then
  install -d -m 700 -o cage -g cage /home/cage/.ssh
  printf '%s\n' "$KEY" > /home/cage/.ssh/authorized_keys
  chown cage:cage /home/cage/.ssh/authorized_keys && chmod 600 /home/cage/.ssh/authorized_keys
fi

# 2. Network (point-to-point /30 to the host TAP).
ip link set lo up || warn "lo up failed"
if [ -n "$IP" ]; then
  ip link set eth0 up || warn "eth0 up failed"
  ip addr replace "$IP" dev eth0 || warn "ip addr $IP failed"
  if [ -n "$GW" ]; then ip route replace default via "$GW" || warn "default route via $GW failed"; fi
fi

# 3. DNS: public resolvers (the host firewall drops guest->host traffic). Overwrite in place so a
#    bind-mounted file works too; replace a dangling systemd-resolved symlink.
if [ -L /etc/resolv.conf ]; then rm -f /etc/resolv.conf; fi
printf 'nameserver 1.1.1.1\nnameserver 9.9.9.9\noptions timeout:2 attempts:2\n' > /etc/resolv.conf || warn "could not write resolv.conf"

# 4. Identity.
if [ -n "$HN" ]; then
  hostname "$HN" || warn "hostname failed"
  echo "$HN" > /etc/hostname || true
fi
printf '127.0.0.1 localhost\n127.0.1.1 %s\n::1 localhost ip6-localhost\n' "${HN:-cage}" > /etc/hosts || warn "could not write /etc/hosts"
exit 0
