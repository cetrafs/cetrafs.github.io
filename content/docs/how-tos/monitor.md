---
weight: 350
title: "Monitor a volume"
description: "What to watch on a live cetrafs cluster: free space, node liveness, write readiness, contention, journal replays and the kernel log."
toc: true
---

Each mounted volume publishes its live state under `/proc/fs/cetrafs/<dev>/`, where `<dev>` is the kernel's name for the device (`sdb`, `dm-3`...). Reading these files is cheap and safe on a live mount. Every field is described in the [procfs reference](/docs/reference/procfs/).

## Quick health check

```sh
D=/proc/fs/cetrafs/$(ls /proc/fs/cetrafs | head -1)
cat $D/cluster
grep -E '^(write_ready|fenced|file_lock|free_data_blocks|free_inodes|cas_miscompares|journal_replay_refused|scrub_reclaimed)' $D/info
```

## What to watch

| Signal | Where | Healthy | Investigate when |
|---|---|---|---|
| Free space | `info`: `free_data_blocks`, `free_inodes` (or `df`) | Steady consumption | Approaching zero. Inodes are fixed at mkfs time. |
| Node liveness | `cluster`: `stale=` per row | All `no` | A row shows `stale=yes` (that peer has crashed or stalled) or keeps showing it for a long time. |
| Fenced | `info`: `fenced` | `no` | `yes`: this node's lease was revoked and every write fails with `EIO`. Remount. See [Recover from a node failure](/docs/how-tos/recover-node-failure/). |
| Write readiness | `info`: `write_ready` | `yes` on nodes that write | Persistently `no`: every Zone Group is owned by another node. Too few Zone Groups for the number of writers. |
| Contention | `info`: `cas_miscompares` | Rising slowly while several nodes work | Stuck at `0` while two nodes are both busy: they may not really share the device (check the storage path). |
| Replay guard | `info`: `journal_replay_refused` | `0` in steady state | Rises with no recent crash. Each count is a cross-node overwrite that replay *refused* to apply; `dmesg` names the block. A burst right after a failover under `nofilelock` is expected. |
| Leak reclaim | `info`: `scrub_reclaimed`, `scrub_cycles` | `scrub_cycles` keeps advancing | `fsck` reports leaked blocks that never go down across several crashes. Check that the scrubber is on. |
| Kernel log | `dmesg` | Lifecycle lines only | Any `EUCLEAN`, `leaking`, `WARNING` or `BUG` line from cetrafs. |

## Free space as Proxmox sees it

`statfs` (so `df`, and Proxmox's `pvestatd`) reports live free-block and free-inode counts, including space other nodes have just used.

## Example: a simple Prometheus textfile exporter

cetrafs has no exporter of its own. The `info` file is `key: value` text, which is easy to turn into metrics for the node_exporter textfile collector:

```sh
#!/bin/sh
# /usr/local/bin/cetrafs-metrics.sh, run from cron or a systemd timer
OUT=/var/lib/node_exporter/textfile/cetrafs.prom
TMP=$OUT.$$
for d in /proc/fs/cetrafs/*/; do
  dev=$(basename "$d")
  awk -v dev="$dev" -F': *' '
    $1 ~ /^[a-z_]+$/ && $2 ~ /^[0-9]+$/ { printf "cetrafs_%s{dev=\"%s\"} %s\n", $1, dev, $2 }
    $1 == "write_ready" { printf "cetrafs_write_ready{dev=\"%s\"} %d\n", dev, ($2=="yes") }
    $1 == "fenced"      { printf "cetrafs_fenced{dev=\"%s\"} %d\n", dev, ($2=="yes") }
  ' "$d/info"
  printf 'cetrafs_stale_peers{dev="%s"} %d\n' "$dev" "$(grep -c 'stale=yes' "$d/cluster")"
done > "$TMP" && mv "$TMP" "$OUT"
```

Good alerts to start with: `cetrafs_fenced == 1`, `cetrafs_stale_peers > 0` for longer than a few minutes, a non-zero increase in `cetrafs_journal_replay_refused` with no failover, and low `cetrafs_free_data_blocks`.
