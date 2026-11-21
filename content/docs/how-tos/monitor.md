---
weight: 350
title: "Monitor a volume"
description: "What to watch on a live cetrafs cluster: free space per node, node liveness, damage marks, contention, journal replays, discard and the kernel log."
toc: true
---

Each mounted volume publishes its live state under `/proc/fs/cetrafs/<dev>/`, where `<dev>` is the kernel's name for the device (`sdb`, `dm-3`...). Reading these files is safe on a live mount; `info` and `cluster` read the device and are root-only. Every field is described in the [procfs reference](/docs/reference/procfs/).

## Quick health check

```sh
D=/proc/fs/cetrafs/$(ls /proc/fs/cetrafs | head -1)
sudo cat $D/cluster
sudo grep -E '^(write_ready|fenced|stopped|fsck_needed|sb_copy|file_lock|free_data_blocks|free_inodes|cas_miscompares|journal_replay_refused|scrub_reclaimed|bmap_crc_bad|discard_pending_bgs|space_waits)' $D/info
```

## What to watch

| Signal | Where | Healthy | Investigate when |
|---|---|---|---|
| Free space, per node | `info`: `free_data_blocks_owned` + `free_data_blocks_unowned_bgs`, `free_inodes`; or `df` on each node | Steady consumption | Approaching zero on any node. A node can run out while the volume has room; see [Limits](/docs/reference/limits/#operational-characteristics). Grow the volume, with `-N` for inodes. |
| Node liveness | `cluster`: `stale=` per row | All `no` | A row shows `stale=yes` (that peer has crashed or stalled) or keeps showing it for a long time. |
| Stopped | `info`: `fenced`, `stopped` | `no`, `none` | `fenced: yes`: the mount has stopped and every access fails with `EIO`; `stopped` says why. See [Recover from a node failure](/docs/how-tos/recover-node-failure/#a-mount-where-everything-fails-with-eio). |
| Damaged metadata | `info`: `corruptions`, `fsck_needed`, `bmap_crc_bad` | `0`, `no`, `0` | Anything else: writes to the damaged file fail with `EUCLEAN`. Run `fsck.cetra --live`, then [repair offline](/docs/how-tos/check-and-repair/). |
| Superblock copy | `info`: `sb_copy` | `ok` | `stale` or `bad`: run `fsck.cetra -r` at the next window to rewrite it. |
| Array out of space | `info`: `space_waits`; `dmesg` | `0` | Rising: the thin pool is full and writes are waiting. Give it space. |
| Discard | `info`: `discard_pending_bgs`, `discard_errors` | `0` | `discard_pending_bgs` staying above 0. See [Reclaim thin space](/docs/how-tos/reclaim-thin-space/#a-block-group-stuck-waiting-for-its-unmap). |
| Journal | `info`: `journal_slots_stuck` | `0` | Nonzero: the device refused writes. |
| Write readiness | `info`: `write_ready` | `yes` on nodes that write | Persistently `no`: every Zone Group is owned by another node. Too few Zone Groups for the number of writers. |
| Contention | `info`: `cas_miscompares` | Rising slowly while several nodes work | Stuck at `0` while two nodes are both busy: they may not really share the device (check the storage path). |
| Replay guard | `info`: `journal_replay_refused` | `0` in steady state | Rises with no recent crash. Each count is a cross-node overwrite that replay *refused* to apply; `dmesg` names the block. A burst right after a failover under `nofilelock` is expected. |
| Leak reclaim | `info`: `scrub_reclaimed`, `scrub_cycles` | `scrub_cycles` keeps advancing | `fsck` reports leaked blocks that never go down across several crashes. Check that the scrubber is on. A cycle that finds a node mid-truncate or mid-punch frees nothing and counts in `scrub_inflight_skips`, which only delays the reclaim. |
| Grow | `info`: `layout_gen` | The same on every node | Still lower on one node a heartbeat after a grow: check `layout_refresh_refused` and `dmesg`, and that its device shows the new size. |
| Kernel log | `dmesg` | Lifecycle lines only | Any `EUCLEAN`, `leaking`, `WARNING` or `BUG` line from cetrafs. |

## Free space as Proxmox sees it

`statfs` (so `df`, and Proxmox's `pvestatd`) reports live counts. This node's own use shows at once, and space other nodes have used within a second: the shared table is read from the LUN at most once a second, however often `statfs` is called, so even a tight `df` loop costs the storage one read a second. Its *available* figure is what **this node** can allocate, leaving out space in Block Groups a live peer owns, so `df` can show different free space on different nodes. It fails on a stopped mount.

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

Good alerts to start with: `cetrafs_fenced == 1`, `cetrafs_stale_peers > 0` for longer than a few minutes, `cetrafs_corruptions > 0` or `cetrafs_bmap_crc_bad > 0`, any increase in `cetrafs_space_waits`, a non-zero increase in `cetrafs_journal_replay_refused` with no failover, and low `cetrafs_free_data_blocks_owned + cetrafs_free_data_blocks_unowned_bgs` on any node. Add a `fsck_needed` check too: it isn't numeric, so test for a line other than `fsck_needed: no`.
