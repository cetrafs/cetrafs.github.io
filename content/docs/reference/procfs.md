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
| `fenced` | `yes` if this mount has stopped, for any cause; every access fails with `EIO` until remount. Before 0.9.4 only fencing did this, and only writes failed. |
| `stopped` | Why it stopped: `none`, `fenced`, `lease`, `error`, `corruption`, `manual` or `device_gone`. See [What a stopped mount does](/docs/reference/mount-options/#what-a-stopped-mount-does). Since 0.9.4. |
| `corruptions` | Damaged metadata this mount has found. Above `0`, the volume needs `fsck.cetra`. Since 0.9.4. |
| `max_file_size_bytes` | The maximum file size the kernel enforces on this volume: the smaller of the volume capacity and 16 TiB |

### Geometry and space

| Field | Meaning |
|---|---|
| `block_size` | Always 4096 |
| `total_blocks` | Device size in blocks |
| `zone_group_count`, `block_group_count`, `bg_size_blocks` | Partitioning |
| `inodes_count`, `free_inodes` | Inode capacity and live free count |
| `total_data_blocks`, `free_data_blocks` | Data capacity and free count |
| `zg N: owner=… block_groups=… free_data_blocks=…` | One line per Zone Group. `owner` is a row index, `none`, or marked `(this node)`. `block_groups` is how many Block Groups the Zone Group owns right now; it changes as nodes claim free Block Groups and hand empty ones back. |

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
| `pf_drop_runs`, `pf_drop_blocks` | Extents dropped because a pending-free queue was full, and the blocks they held. Should stay at 0; a rise means a Zone Group owner isn't draining its queue. |
| `pf_full_scans` | Complete scans of a pending-free queue that found no free slot. While a queue is known to be full, appends skip it for `pf_full_backoff_ms`, so this should rise far more slowly than `pf_drop_runs`. |
| `pf_drain_blocks` | Queue blocks read by drain passes. Should follow how full the queues are, not their size: an empty queue costs a handful of reads per heartbeat. |
| `bg_recounts` | Block Group free counts recomputed from the bitmap because the cached count claimed free space the bitmap didn't have. Expected to stay at 0. |
| `zg_pending_deltas` | Zone Groups with free-count changes held in memory, not yet written to disk (this mount) |

### Journal

| Field | Meaning |
|---|---|
| `journal_writes` | Journaled block writes |
| `journal_slots_stuck` | Journal slots held by entries kept for replay after a failed write. Nonzero means the device refused writes; once every slot is held, journaled writes fail until a remount. Since 0.9.4. |
| `journal_replays` | Journal areas this node replayed |
| `journal_replay_declines` | Contested replay claims this node gave up to a peer |
| `journal_replay_applied` | Entries replayed: interrupted writes completed |
| `journal_replay_torn` | Of those, entries whose target block was **torn** (caught mid-write by the crash) and was repaired by the replay |
| `journal_replay_skipped` | Entries skipped because the write had already landed, or the target was a freshly allocated block |
| `journal_replay_refused` | Entries **refused** because another node had since rewritten the target block. Each one is a cross-node overwrite that was prevented. Expect a burst after a failover under `nofilelock` and zero otherwise. |

### Scrubber

| Field | Meaning |
|---|---|
| `scrub_cycles` | Scrub cycles completed |
| `scrub_inflight_skips` | Cycles that freed nothing because a node had frees in flight, from a truncate, a hole punch, a defragmentation step or an xattr removal. Since 0.9.5. |
| `scrub_reclaimed` | Leaked data blocks reclaimed |
| `scrub_orphan_inodes_reclaimed` | Orphaned inodes reclaimed |
| `scrub_last_run_unix`, `scrub_last_run_ms` | When the last cycle started, and how long it took |

### Performance diagnostics

| Field | What to look for |
|---|---|
| `bg_pick_cursor`, `bg_pick_scan` | Allocation-cursor hits against full scans. `scan` rising in step with `cursor` means each block allocation is scanning again. |
| `bg_desc_kept`, `bg_desc_refreshed` | Descriptor sweeps that kept this node's cached Block Group descriptors, against those that forced them back to the device. `kept` should rise on a node that owns Zone Groups. |
| `bg_geom_reads` | Block Group geometry reads |
| `dio_fallbacks`, `dio_converts` | `O_DIRECT` writes that went through the page cache instead, and direct-write completions that converted preallocated blocks. `dio_fallbacks` should stay at 0. Since 0.9.4. |
| `map_calls`, `map_blocks` | Block mapping calls against the blocks they covered. `blocks` much larger than `calls` means mappings come back as contiguous runs. |
| `giveback_blocks` | Preallocated blocks released because an extent split had no room. A last resort that should stay at or near zero. |
| `tree_blocks` | External extent-tree blocks (leaf or interior) written. Nonzero means some file outgrew its four inline extent slots. |
| `tree_reads` | External extent-tree blocks read during lookups. Should stay close to a couple per lookup, however fragmented the file. |
| `ext_cache_hits`, `ext_cache_misses` | Lookups answered by the extent each file remembers from its last lookup, against those that walked the tree. On a sequential write `hits` should far outnumber `misses`; if it doesn't move, the cache isn't working and a fragmented image is paying for a tree walk on every block. See [Aged images](/docs/concepts/performance/#aged-images). |
| `lock_suspends`, `lock_resumes` | Files whose lock this node suspended with `flock(LOCK_UN)` on a default mount, and took back with `flock(LOCK_EX)`. A suspension also ends when the file is closed, so the two needn't match; a gap that keeps growing while files stay open means something unlocks files and never takes them back. See [handing one file's lock over](/docs/concepts/locking/#handing-one-files-lock-over-on-a-default-mount). |
| `file_cache_drops`, `file_cache_reconciles` | Times this node dropped a file's cached extent tree and pages because a peer had republished the file, and the reconciles that followed. Drops should be about 0 on a node writing its own files, and every drop should be followed by a reconcile; `drops` running ahead of `reconciles` means files are stuck on the slow, uncached path. |
| `file_cache_cold_parked` | Files waiting for a heartbeat to retry a cold-tree reconcile that couldn't read the record. Since 0.9.5. |
| `verdict_fills` | Times this node asked the device whether another node has a file open, rather than using its cached answer. Since 0.9.5. |
| `ext_cache_stale_refused` | Extent-cache stores refused because the cache was dropped during the walk. Since 0.9.5. |
| `label_invalidations` | Security labels invalidated because a refresh saw a file's ctime move. Since 0.9.5. |
| `late_claims_cleared` | Claims of this node that nothing here uses, cleared by the sweep `own_claim_resweep_secs` after an unclean re-attach. Since 0.9.5. |
| `deferred_orphaned`, `deferred_adopted` | Held-back extent-tree blocks left behind by an evicted inode, and those a later edit moved back to their inode's list. Since 0.9.5. |
| `defrag_max_step_blocks` | The largest defragmentation step taken since the module was loaded. Since 0.9.5. |
| `layout_gen` | The volume's layout generation, raised by every grow. Since 0.9.5. |
| `layout_refreshes`, `layout_refresh_refused` | Times this node adopted a new layout after a grow, and times it kept its layout because the one on the device couldn't be accepted. Since 0.9.5. |

## `properties`

| Field | Meaning |
|---|---|
| `version` | On-disk format version |
| `block_size` | Block size |
| `kernel_page_size`, `blocks_per_page` | The kernel's page size and how many filesystem blocks fit in a page. Since 0.9.4 a mount needs 4096 and 1. |
| `cluster_id` | The volume's cluster identifier |
| `features_compat`, `features_ro_compat`, `features_incompat` | Feature bitmaps; incompatible flags are also printed by name |
| `caw: class=… logical_block_size=… max_caw_blocks=… available=…` | The device's compare-and-write capability. `class` is `scsi`, `nvme` or `none`. `available=no` means the volume is single-node only. |

## `cluster`

One line per Node Registry row that isn't free:

```text
node 1: state=REGISTERED uuid=… hb_seq=4711 last_seen=1792540000 label=pve2 caps=0x1 stale=no (this node)
live_grow_ready: yes
```

| Field | Meaning |
|---|---|
| `state` | `REGISTERED`. A row held by `growfs.cetra` or an offline `fsck.cetra -r` is printed as `row=N REPAIR-IN-PROGRESS last_seen=… label=…` instead; it is why mounts are being refused. |
| `uuid` | The node's stable machine UUID |
| `hb_seq` | Heartbeat counter, incremented every heartbeat |
| `last_seen` | Unix time of the last heartbeat. A clean unmount backdates it so peers see the departure at once. |
| `label` | Hostname, informational only |
| `caps` | Capabilities the node's module advertised when it registered. `0x1` is the live-grow capability, from 0.9 or later, though a live grow also needs every node on 0.9.5; `0x0` is a module from before 0.9. |
| `stale` | Whether **this** node considers that peer dead |

After the node lines, `live_grow_ready: yes|no` says whether every registered node advertises `0x1`. `no` means at least one registered node runs a module older than 0.9, and a live grow is refused. `yes` doesn't tell 0.9.5 from earlier releases: see [Grow a volume](/docs/how-tos/grow-volume/#1-upgrade-every-node).

## `controls` (writable)

Write one `key=value` (or `key value`) per write. Reading the file prints the current values. An unparseable or out-of-range write changes nothing and logs a warning; a successful change is logged at info level. Values last for this mount only.

| Key | Values | Default | Effect |
|---|---|---|---|
| `defrag` | `on`, `off` | `on` | Allow defragmentation at all on this mount, including `defrag.cetra` |
| `shutdown` | `now` | | Stops the mount at once, as a crash would. One way: unmount and mount to come back. See [Stopping a mount by hand](/docs/reference/mount-options/#stopping-a-mount-by-hand). Since 0.9.4. |
| `auto_defrag` | `on`, `off` | module `auto_defrag` | The background defragmenter |
| `defrag_available` | read-only: `yes`, or `no` on a `nofilelock` mount | | Whether defragmentation can run at all, whatever `defrag` says. Since 0.9.5. |
| `hb_interval_secs` | 5–30 | 15 | Seconds between this node's heartbeats |
| `stale_secs` | 15–240, and ≥ 3 × `hb_interval_secs` | 120 | How long a peer may be silent before this node treats it as dead |

Timing is per node. Each node advertises its own heartbeat rate, and its peers give it at least four of those intervals, so the values don't have to match across the cluster. The file-lock mode is set at mount, not here.
