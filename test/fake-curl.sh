#!/usr/bin/env bash
# curl for the tests, linked in as `curl` ahead of the real one: the addresses cage's network checks probe
# (registry.npmjs.org, github.com, archive.ubuntu.com) answer from here, so no test needs the internet. Every other
# address goes to the real curl (REAL_CURL). Hosts named in NET_DOWN don't answer at all; hosts in NET_BLOCKED get
# a proxy's "403" to the connection, as a company firewall would.
url="" w=""
prev=""
for a in "$@"; do
  case "$a" in http://*|https://*) url="$a" ;; esac
  [ "$prev" != -w ] || w="$a"
  prev="$a"
done
host="${url#*://}" host="${host%%/*}"
case "$host" in
  registry.npmjs.org|github.com|archive.ubuntu.com) ;;
  *) exec "${REAL_CURL:?set REAL_CURL to the real curl}" "$@" ;;
esac
echo "$url" >> "${FAKE_CURL_LOG:-/dev/null}"
case " ${NET_DOWN:-} " in *" $host "*)
  [ -z "$w" ] || printf '000 000'
  echo "curl: (6) Could not resolve host: $host" >&2
  exit 6 ;;
esac
case " ${NET_BLOCKED:-} " in *" $host "*)
  [ -z "$w" ] || printf '000 403'
  echo "curl: (56) CONNECT tunnel failed, response 403" >&2
  exit 56 ;;
esac
[ -z "$w" ] || printf '200 000'
exit 0
