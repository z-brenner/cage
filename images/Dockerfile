# syntax=docker/dockerfile:1
# Firecracker guest rootfs for one cage agent. Built by images/build-rootfs.sh, which converts
# the container filesystem to an ext4 image. The same guest/provision.sh is used for Lima VMs.
FROM ubuntu:24.04
ARG KIND
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# Optional extra CA (corporate TLS-intercepting proxy): build-rootfs.sh passes it as a BuildKit secret.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then \
      apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates >/dev/null && \
      cp /run/secrets/extra_ca /usr/local/share/ca-certificates/cage-extra-ca.crt && update-ca-certificates >/dev/null; \
    fi

RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      systemd systemd-sysv udev dbus kmod iproute2 iputils-ping openssh-server sudo \
      ca-certificates curl git e2fsprogs >/dev/null \
 && rm -rf /var/lib/apt/lists/*

COPY guest/provision.sh /opt/cage/provision.sh
RUN bash /opt/cage/provision.sh "$KIND" \
 && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache

# Single unprivileged agent user. Passwordless sudo is fine: the VM is the cage.
RUN (userdel -r ubuntu 2>/dev/null || true) \
 && useradd -m -s /bin/bash cage \
 && echo 'cage ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/cage && chmod 0440 /etc/sudoers.d/cage \
 && passwd -l root

COPY guest/cage-init.sh /usr/local/sbin/cage-init
COPY guest/cage-init.service /etc/systemd/system/cage-init.service
COPY guest/sshd-cage.conf /etc/ssh/sshd_config.d/cage.conf
RUN chmod 0755 /usr/local/sbin/cage-init \
 && systemctl enable cage-init.service ssh.service \
 && (systemctl disable ssh.socket 2>/dev/null || true) \
 && systemctl mask systemd-networkd-wait-online.service getty@tty1.service \
 && rm -f /etc/ssh/ssh_host_* \
 && echo cage > /etc/hostname
