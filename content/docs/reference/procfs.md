---
weight: 525
title: "/proc/fs/cetrafs"
description: "Every file and field cetrafs publishes under /proc/fs/cetrafs/<dev>/: info, properties, cluster and the writable controls."
toc: true
---

Each mounted volume gets a directory `/proc/fs/cetrafs/<dev>/`, where `<dev>` is the kernel's name for the device (`sdb`, `loop0`, `dm-3`...). It is created at mount and removed at unmount.

| File | Mode | Contents |
|---|---|---|
| `info` | read-only | Live topology, state and counters |
| `properties` | read-only | Static format and device properties |
| `cluster` | read-only | Every registered node and its liveness |
| `controls` | read-write | Per-mount tunables |

Reading the read-only files is safe on a live mount. `info` stays readable even if the device has gone away: fields that can be answered from memory are still printed, and the others read `unavailable (<errno>)`.

## `info`

### State

| Field | Meaning |
|---|---|
| `this_node_id` | This node's row index in the Node Registry |
| `write_ready` | `yes` if this node owns at least one Zone Group and can allocate. `no` is normal while every Zone Group is owned by live peers. |
| `file_lock` | `on` or `off`: the cluster-wide file-lock mode in effect (`off` = `nofilelock`) |
| `fenced` | `yes` if this node has fenced itself; every write fails with `EIO` until remount |
| `max_file_size_bytes` | The maximum file size the kernel enforces on this volume: the smaller of the volume capacity and 16 TiB |

### Geometry and space

| Field | Meaning |
|---|---|
| `block_size` | Always 4096 |
| `total_blocks` | Device size in blocks |
| `zone_group_count`, `block_group_count`, `bg_size_blocks` | Partitioning |
| `inodes_count`, `free_inodes` | Inode capacity and live free count |
| `total_data_blocks`, `free_data_blocks` | Data capacity and free count |
| `zg N: owner=… first_bg=… bg_count=… free_data_blocks=…` | One line per Zone Group. `owner` is a row index, `none`, or marked `(this node)`. |

Free counts for Zone Groups that other nodes own are refreshed at most once every `bg_sweep_min_secs` (30 s by default), so polling this file doesn't discard the allocator's cache. They can be up to that many seconds old.

### Coordination counters

These counters cover the whole module, not one mount: they include every volume this host has mounted.

| Field | Meaning |
|---|---|
| `cas_ops` | Compare-and-writes issued |
| `cas_miscompares` | Compare-and-writes the device rejected because the record had changed: real cross-node contention, each one retried. Stuck at 0 while several nodes are busy means they aren't actually contending. |
| `record_writes` | Full-record writes |
| `pending_free_appends` | Frees this node queued into another node's Zone Group |
| `pf_drains` | Pending-free queue drains performed |
| `foreign_free_leaks` | Extents not freed because the owning node's pending-free queue was full. The space is leaked on purpose and later reclaimed by the scrubber or `fsck -r`; the caller never sees an error. |
| `zg_pending_deltas` | Zone Groups with free-count changes held in memory, not yet written to disk (this mount) |

### Journal

| Field | Meaning |
|---|---|
| `journal_writes` | Journaled block writes |
| `journal_replays` | Journal areas this node replayed |
| `journal_replay_declines` | Contested replay claims this node gave up to a peer |
| `journal_replay_applied` | Entries replayed: interrupted writes completed |
| `journal_replay_skipped` | Entries skipped because the write had already landed, or the target was a freshly allocated block |
| `journal_replay_refused` | Entries **refused** because another node had since rewritten the target block. Each one is a cross-node overwrite that was prevented. Expect a burst after a failover under `nofilelock` and zero otherwise. |

### Scrubber

| Field | Meaning |
|---|---|
| `scrub_cycles` | Scrub cycles completed |
| `scrub_reclaimed` | Leaked data blocks reclaimed |
| `scrub_orphan_inodes_reclaimed` | Orphaned inodes reclaimed |
| `scrub_last_run_unix`, `scrub_last_run_ms` | When the last cycle started, and how long it took |

### Performance diagnostics

| Field | What to look for |
|---|---|
| `bg_pick_cursor`, `bg_pick_scan` | Allocation-cursor hits against full scans. `scan` rising in step with `cursor` means each block allocation is scanning again. |
| `bg_desc_kept`, `bg_desc_refreshed` | Descriptor sweeps that kept this node's cached Block Group descriptors, against those that forced them back to the device. `kept` should rise on a node that owns Zone Groups. |
| `bg_geom_reads` | Block Group geometry reads |
| `map_calls`, `map_blocks` | Block mapping calls against the blocks they covered. `blocks` much larger than `calls` means mappings come back as contiguous runs. |
| `giveback_blocks` | Preallocated blocks released because an extent split had no room. A last resort that should stay at or near zero. |
| `tree_blocks` | External extent-tree blocks (leaf or interior) written. Nonzero means some file outgrew its four inline extent slots. |
| `file_cache_drops`, `file_cache_reconciles` | Times this node dropped a file's cached extent tree and pages because a peer had republished the file, and the reconciles that followed. Drops should be about 0 on a node writing its own files, and every drop should be followed by a reconcile; `drops` running ahead of `reconciles` means files are stuck on the slow, uncached path. |

## `properties`

| Field | Meaning |
|---|---|
| `version` | On-disk format version |
| `block_size` | Block size |
| `cluster_id` | The volume's cluster identifier |
| `features_compat`, `features_ro_compat`, `features_incompat` | Feature bitmaps; incompatible flags are also printed by name |
| `caw: class=… logical_block_size=… max_caw_blocks=… available=…` | The device's compare-and-write capability. `class` is `scsi`, `nvme` or `none`. `available=no` means the volume is single-node only. |

## `cluster`

One line per Node Registry row that isn't free:

```text
node 1: state=REGISTERED uuid=… hb_seq=4711 last_seen=1792540000 label=pve2 stale=no (this node)
```

| Field | Meaning |
|---|---|
| `state` | `REGISTERED` |
| `uuid` | The node's stable machine UUID |
| `hb_seq` | Heartbeat counter, incremented every heartbeat |
| `last_seen` | Unix time of the last heartbeat. A clean unmount backdates it so peers see the departure at once. |
| `label` | Hostname, informational only |
| `stale` | Whether **this** node considers that peer dead |

## `controls` (writable)

Write one `key=value` (or `key value`) per write. Reading the file prints the current values. An unparseable or out-of-range write changes nothing and logs a warning; a successful change is logged at info level. Values last for this mount only.

| Key | Values | Default | Effect |
|---|---|---|---|
| `defrag` | `on`, `off` | `on` | Allow defragmentation at all on this mount, including `defrag.cetra` |
| `auto_defrag` | `on`, `off` | module `auto_defrag` | The background defragmenter |
| `hb_interval_secs` | 5–30 | 15 | Seconds between this node's heartbeats |
| `stale_secs` | 15–240, and ≥ 3 × `hb_interval_secs` | 120 | How long a peer may be silent before this node treats it as dead |

Timing is per node. Each node advertises its own heartbeat rate, and its peers give it at least four of those intervals, so the values don't have to match across the cluster. The file-lock mode is set at mount, not here.
