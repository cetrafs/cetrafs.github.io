---
weight: 525
title: "/proc/fs/cetrafs"
description: "The files and fields cetrafs publishes under /proc/fs/cetrafs/<dev>/: info, properties, cluster and the writable controls."
toc: true
---

Each mounted volume gets a directory `/proc/fs/cetrafs/<dev>/`, where `<dev>` is the kernel's name for the device (`sdb`, `loop0`, `dm-3`...). It is created at mount and removed at unmount.

| File | Mode | Contents |
|---|---|---|
| `info` | root only | Live state, space and counters |
| `properties` | everyone | Static format and device properties |
| `cluster` | root only | Every registered node and its liveness |
| `controls` | root writes | Per-mount settings and operator actions |

`info` and `cluster` read the device on every read, which is why they are root-only: an unprivileged loop polling them would put steady load on the SAN. `info` stays readable even if the device has gone away: fields that can be answered from memory are still printed, and the others read `unavailable (<errno>)`.

## `info`

`info` prints many more counters than this page lists. Most of them exist so the test suites can count operations; the ones below are those worth reading on a live system.

### State

| Field | Meaning |
|---|---|
| `this_node_id` | This node's row in the Node Registry |
| `write_ready` | `yes` if this node owns at least one Zone Group and can allocate. `no` is normal while every Zone Group is owned by live peers. |
| `file_lock` | `on` or `off`: the cluster-wide file-lock mode in effect (`off` = `nofilelock`) |
| `fenced` | `yes` if this mount has stopped, for any cause; every access fails with `EIO` until remount |
| `stopped` | Why it stopped: `none`, `fenced`, `lease`, `error`, `corruption`, `manual` or `device_gone`. See [What a stopped mount does](/docs/reference/mount-options/#what-a-stopped-mount-does). |
| `corruptions` | Damaged metadata this mount has found. Above `0`, the volume needs `fsck.cetra`. |
| `fsck_needed` | `no`, or `since <unix time> by row <N>`: a node found damaged metadata and recorded it in the superblock. Cleared by a clean `fsck.cetra -r`. |
| `sb_copy` | `ok`, `stale` or `bad`: the copy of block 0 at block 2048, as found at mount. `stale` or `bad` means `fsck.cetra -r` should rewrite it at the next maintenance window. |
| `volume_uuid` | The volume's UUID, the same on every node. Also reported as the filesystem UUID and in `statfs`'s `f_fsid`. |
| `max_file_size_bytes` | The largest file the format allows: 1 EiB |

### Geometry and space

| Field | Meaning |
|---|---|
| `block_size` | Always 4096 |
| `total_blocks` | Volume size in blocks |
| `zone_group_count`, `block_group_count`, `bg_size_blocks` | Partitioning |
| `layout_gen` | The volume's layout generation, raised by every grow. The same on every node a heartbeat after a grow. |
| `inodes_count`, `free_inodes` | Inode capacity and live free count |
| `total_data_blocks`, `free_data_blocks` | Data capacity and free blocks on the whole volume |
| `free_data_blocks_owned`, `free_data_blocks_unowned_bgs` | Free blocks in the Block Groups this node owns, and in those nobody owns. Their sum is what **this node** can allocate: a node never takes space back from a live peer. Watch these per node. |
| `  zg N: owner=… block_groups=… free_data_blocks=…` | One line per Zone Group. `owner` is a row, `none`, or marked `(this node)`. |

Free counts for Zone Groups that other nodes own are refreshed at most every `bg_sweep_min_secs` (30 s by default), so polling this file doesn't discard the allocator's cache.

### Coordination

These counters cover the whole module, not one mount.

| Field | Meaning |
|---|---|
| `cas_ops` | Compare-and-writes issued |
| `cas_miscompares` | Compare-and-writes the device rejected because the record had changed: real cross-node contention, each one retried. Stuck at 0 while several nodes are busy means they aren't really contending. |
| `pending_free_appends` | Frees this node queued into another node's Zone Group |
| `pf_drop_runs`, `pf_drop_blocks` | Frees dropped because the owner's queue was full, and the blocks they held. The blocks stay allocated until the scrubber reclaims them. Should stay at 0. |
| `bg_recounts` | Block Group free counts recomputed because the cached count claimed space the bitmap didn't have. Expected to stay at 0. |

### Integrity

| Field | Meaning |
|---|---|
| `bmap_crc_bad` | Bitmap sectors that failed their checksum. The node neither allocates from nor frees into such a sector; `fsck.cetra -r` rewrites it. |
| `alloc_damaged_skips` | Allocations that skipped a Block Group whose descriptor is damaged |
| `tree_half_full` | Files that have passed half their extent tree's capacity. The kernel log names each one; copying the file lays it out again in long extents. |

### Journal

| Field | Meaning |
|---|---|
| `journal_writes` | Journaled block writes |
| `journal_slots_stuck` | Journal slots held by entries kept after a failed write. Nonzero means the device refused writes. |
| `journal_replays` | Journal areas this node replayed |
| `journal_replay_applied` | Entries replayed: interrupted writes completed |
| `journal_replay_torn` | Of those, entries whose target was torn by the crash and repaired by the replay |
| `journal_replay_skipped` | Entries skipped because the write had already landed, or the target was a new block |
| `journal_replay_refused` | Entries **refused** because the block had since been rewritten. Each one is a cross-node overwrite that was prevented. |
| `journal_replay_kept` | Entries held back because a live node has the file open for writing. The file can't be opened elsewhere until they settle. |

### Scrubber

| Field | Meaning |
|---|---|
| `scrub_cycles` | Scrub cycles completed |
| `scrub_reclaimed` | Leaked data blocks reclaimed |
| `scrub_orphan_inodes_reclaimed` | Orphaned inodes reclaimed |
| `scrub_inflight_skips` | Cycles that freed nothing because a node had frees in flight (a truncate, hole punch, defragmentation step or xattr removal) |
| `scrub_dead_journal_kept` | Blocks the scrubber left alone because a dead node's unsettled journal may still name them |
| `scrub_last_run_unix`, `scrub_last_run_ms` | When the last cycle started, and how long it took |

### Discard and space

| Field | Meaning |
|---|---|
| `discard_cmds`, `discard_blocks` | UNMAP commands sent, and the blocks they covered |
| `discard_handback_bgs` | Emptied Block Groups unmapped as they went back to the pool |
| `discard_pending_bgs` | Block Groups held out of use because their UNMAP's outcome is unknown. See [Return free space to a thin LUN](/docs/how-tos/reclaim-thin-space/#a-block-group-stuck-waiting-for-its-unmap). |
| `discard_errors` | UNMAPs the device refused. The blocks are freed anyway. |
| `trim_leaked_blocks` | Blocks held back because an `fstrim` UNMAP failed in a way that may still execute. The scrubber returns them after `trim_quarantine_secs`. |
| `trim_quarantined` | Blocks currently in that quarantine |
| `trim_held_zone_groups` | Zone Groups this node took over and keeps from the scrubber for the quarantine, because the previous owner's hold was lost with it |
| `inline_discard_queued`, `inline_discard_cmds`, `inline_discard_blocks`, `inline_discard_dropped` | The `-o discard` queue: runs queued, commands and blocks sent, and runs dropped because the queue was full. `fstrim` still finds dropped space. |
| `space_waits` | Overwrites that waited because the array had no space for them: a full thin pool, or a snapshot's copy-on-write |
| `close_space_waits` | Last closes that waited for space to write what they still held |
| `held_refusals` | Metadata blocks a flush couldn't write for lack of space, kept for the next flush |

### Performance

| Field | What to look for |
|---|---|
| `bg_pick_cursor`, `bg_pick_scan` | Allocation-cursor hits against full scans. `scan` rising in step with `cursor` means each block allocation is scanning again. |
| `bg_desc_kept`, `bg_desc_refreshed` | Descriptor sweeps that kept this node's cached Block Group descriptors, against those that forced them back to the device. `kept` should rise on a node that owns Zone Groups. |
| `dio_fallbacks`, `dio_converts` | `O_DIRECT` writes that went through the page cache instead (should stay at 0), and direct writes that converted preallocated blocks |
| `map_calls`, `map_blocks` | Block mapping calls against the blocks they covered. `blocks` much larger than `calls` means mappings come back as contiguous runs. |
| `ext_cache_hits`, `ext_cache_misses` | Lookups answered by the extents each file remembers, against those that walked the tree. On a sequential write `hits` should far outnumber `misses`. |
| `tree_blocks`, `tree_reads` | External extent-tree blocks written, and read during lookups |
| `zero_inplace_blocks` | Blocks `ZERO_RANGE` zeroed in place with WRITE ZEROES |
| `file_cache_drops`, `file_cache_reconciles` | Times this node dropped a file's cached tree because a peer changed the file, and the reconciles that followed. `drops` running ahead of `reconciles` means files are stuck on the slow, uncached path. |
| `lock_suspends`, `lock_resumes` | Files whose lock this node suspended with `flock(LOCK_UN)` on a default mount, and took back with `flock(LOCK_EX)` |
| `defrag_passes`, `defrag_yields` | Defragmentation passes, and passes that stepped aside for an open or a peer |

## `properties`

| Field | Meaning |
|---|---|
| `version` | On-disk format version (`0x000a`) |
| `block_size` | Block size |
| `kernel_page_size`, `blocks_per_page` | The kernel's page size and how many filesystem blocks fit in a page. A mount needs 4096 and 1. |
| `test_params` | `locked` for a packaged build, which refuses every test-only parameter; `settable` for a developer build |
| `features_compat`, `features_ro_compat`, `features_incompat` | Feature bitmaps; incompatible flags are also printed by name |
| `caw: class=… logical_block_size=… max_caw_blocks=… available=…` | The device's compare-and-write capability. `class` is `scsi`, `nvme` or `none`. `available=no` means the volume is single-node only. |

## `cluster`

One line per Node Registry row that isn't free:

```text
node 1: state=REGISTERED uuid=… hb_seq=4711 last_seen=1795140000 label=pve2 caps=0x1 stale_secs=120 departure=none stale=no incarnation=2841992710 (this node)
live_grow_ready: yes
```

| Field | Meaning |
|---|---|
| `state` | `REGISTERED`. A row held by `growfs.cetra` or an offline `fsck.cetra -r` is printed as `row=N REPAIR-IN-PROGRESS last_seen=… label=…` instead; it is why mounts are being refused. |
| `uuid` | The node's stable machine UUID |
| `hb_seq` | Heartbeat counter. Liveness is judged by watching it move, never by comparing clocks. |
| `last_seen` | Unix time of the last heartbeat, informational |
| `label` | Hostname, informational |
| `caps` | Capabilities the node's module advertised. `0x1` is live grow. |
| `stale_secs` | That node's own stale window |
| `departure` | `none` (mounted, or crashed with no verdict yet), `clean` (it unmounted and said so) or `dead` (a peer fenced it, or an HA agent declared it dead) |
| `stale` | Whether **this** node considers that peer dead |
| `incarnation` | Which mount of that node the row belongs to, drawn afresh at every mount. Needed by the `dead=` and `retire_journal=` controls. |

After the node lines, `live_grow_ready: yes|no` says whether every registered node advertises the live-grow capability.

## `controls`

Write one `key=value` (or `key value`) per write. Reading the file prints the current settings. An unparseable or out-of-range write changes nothing and logs a warning; a successful change is logged. Settings last for this mount only.

### Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `defrag` | `on`, `off` | `on` | Allow defragmentation at all on this mount, including `defrag.cetra` |
| `auto_defrag` | `on`, `off` | module `auto_defrag` | The background defragmenter |
| `defrag_available` | read-only | | Whether defragmentation can run on this mount: `no` under `nofilelock` |
| `hb_interval_secs` | 5–30 | 15 | Seconds between this node's heartbeats |
| `stale_secs` | 15–240, and ≥ 3 × `hb_interval_secs` | 120 | How long a peer may be silent before this node treats it as dead |
| `handback_grace` | 30–1800 | 150, or module `handback_grace_secs` | Seconds a Zone Group this node claimed or allocated in keeps its empty Block Groups before handing them back. Read back as `handback_grace_secs`. Space only: no effect on safety. |
| `discard` | `on`, `off` | `on`, or `off` with `nodiscard` | UNMAP an emptied Block Group as it goes back to the pool, and allow `fstrim` |
| `inline_discard` | `on`, `off` | `off`, or `on` with `-o discard` | UNMAP freed space as it is freed. Needs `discard` on too. |
| `discard_supported` | read-only | | Whether the device takes discards at all |
| `shutdown` | read: `yes`, `no` | | Whether this mount has stopped |

Timing is per node. Each node advertises its own heartbeat rate and stale window, and its peers judge it by those, so the values don't have to match across the cluster.

### Actions

`dead=`, `retire_journal=` and `release_discards=` need `CAP_SYS_ADMIN`.

| Key | Effect |
|---|---|
| `shutdown=now` | Stops the mount at once, as a crash would. See [Stopping a mount by hand](/docs/reference/mount-options/#stopping-a-mount-by-hand). |
| `dead=<row>:<incarnation>` | Declares a peer that has been **powered off** dead, so its files can be taken over at once instead of after the stale window. Takes up to three of that host's heartbeats plus 5 s, and refuses a row that is still beating. See [Declare a fenced host dead](/docs/how-tos/recover-node-failure/#declare-a-fenced-host-dead). |
| `retire_journal=<row>:<incarnation>` | Gives up a dead node's journal entries that can't be replayed, after replaying everything that can be. Only for a host that will never mount again. See [A dead node's journal that won't settle](/docs/how-tos/recover-node-failure/#a-dead-nodes-journal-that-wont-settle). |
| `release_discards=now` | Releases the Block Groups held for an UNMAP of unknown outcome, untrimmed. Only once no earlier UNMAP can still land. See [Return free space to a thin LUN](/docs/how-tos/reclaim-thin-space/#a-block-group-stuck-waiting-for-its-unmap). |
