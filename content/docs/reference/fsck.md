---
weight: 510
title: "fsck.cetra"
description: "Check and repair a cetrafs volume offline: synopsis, the four passes, what -r repairs and refuses, and exit codes."
toc: true
---

## Synopsis

```text
fsck.cetra [-r] <blockdev>
```

| Option | Meaning |
|---|---|
| *(none)* | Check only. Changes nothing. |
| `-r` | Repair faults that have one correct answer. Refuses everything else. |

## Preconditions

Refuses to run if the volume is **mounted locally**, or if its Node Registry has a **live row**: a node that is still heartbeating. To tell, it watches every row a node hasn't left cleanly, and a row whose heartbeat doesn't move counts as gone. Since 0.9.4 it watches for the longest stale window a node may be set to, 240 s, because a node's own `stale_secs` isn't on the device: a tool that waited less could take a node with a long window for dead. Since 0.9.3 that verdict never depends on comparing clocks, so a node whose clock lags can't be taken for dead, and a row caught mid-update is read again instead of being skipped.

## Passes

| Pass | Checks |
|---|---|
| 1. Structural | Format version (`0x0009`); superblock checksum, every field the mount checks (since 0.9.4), and region map, including what past grows recorded; the Block Group table chain (no loop, no segment outside its place, as many descriptors as Block Groups); Zone Group and Block Group descriptors and headers; every Block Group owned by a real Zone Group or by none, with no two Block Groups overlapping; Node Registry rows |
| 2. Cluster metadata | Per-node journal flags and slots; pending-free queue entries, including, since 0.9.3, a queued free for a block a file still uses (draining it would free live data) |
| 3. Content | Inode bitmap and data bitmaps against the extent trees (all depths), in both directions; cross-file block overlap; two extents of one file over the same logical block, and preallocation outside a regular file (since 0.9.4); cached free counts against bitmaps; leaks |
| 4. Namespace | Every directory's entries and block tails; a directory's size against the entries it holds (since 0.9.3); a directory with more than one name (since 0.9.4); `.` and `..`; link counts against referring entries; directory entry type against inode mode; reachability from the root |

## What `-r` repairs

| Fault | Repair |
|---|---|
| Bitmap bit disagrees with the extent trees (leaked, or would be double-allocated) | Bit set to match the trees |
| Block Group or Zone Group cached free count disagrees with its bitmap | Count recomputed |
| A Zone Group's count of free space in unowned Block Groups (`pool_free_blocks`) disagrees with those Block Groups | Count recomputed |
| `nlink` disagrees with the entries naming the inode | `nlink` corrected |
| Orphan inode with `nlink = 0` | Freed |
| Orphan inode with `nlink > 0` (lost directory entry) | Linked into `/lost+found` as `#<ino>` |
| Directory block whose tail checksum is wrong but whose entries all parse (with `.` and `..` correct in a first block) | Tail re-stamped, names kept. Before 0.9.2 the block was erased and its files went to `/lost+found` by number. |
| Directory size disagrees with the entries it holds | Size corrected. Since 0.9.3. |
| A regular file's extent leaf whose tail checksum is wrong | Salvaged since 0.9.5: an entry is kept if its blocks are in a data region, set in the bitmap, named by nothing else, inside the index range, not overlapping another entry and clear of the damaged sector. The rest become holes. A leaf it can't salvage is reported. |

If `-r` reports reclaimed blocks, run it again. Some reclamation it enables is picked up on the next pass.

A live grow that stopped partway can leave two marks that aren't damage: a note about a table segment the superblock doesn't count yet, which the next grow replaces, and a `pool_free_blocks` that is too high, which `-r` recounts. See [Grow a volume](/docs/how-tos/grow-volume/#if-something-goes-wrong).

## What `-r` refuses

Reported, never changed:

| Fault | Why |
|---|---|
| Cross-file block overlap | Nothing on disk says which file should keep the block |
| Unreadable inode record or extent header, or an extent tree deeper than the format allows | Its blocks can't be marked as used, so clearing them as leaks could hand a live file's blocks to someone else |
| Dangling directory entry | Removing it destroys a name |
| A directory with more than one name, or one whose extent tree no directory can have | Since 0.9.4. Removing either name frees what the other still names, and a link count derived without an unwalkable directory's names would be lowered. Either one blocks every repair in the run. |
| Journal entries a mount hasn't replayed yet | The next mount completes those writes, which a repair made around them would contradict. Mount the volume once, unmount it, and run `-r` again. Since 0.9.3. |

## While `-r` runs

A repair writes the inode table, the bitmaps and directory blocks for minutes, so nothing may mount the volume meanwhile. Since 0.9.2, `fsck.cetra -r` **claims the volume** first: it holds a Node Registry row in the `REPAIR` state, and a mount on any node is refused with `EBUSY` until the repair ends. The claim is a lease that the repair renews every 5 seconds. A mount that finds a claim watches it for the stale window (since 0.9.4; 15 seconds in 0.9.3), and if it wasn't renewed, the repairer is gone and the mount goes ahead. Before 0.9.3 the mount judged the claim by its timestamp, so a node whose clock ran ahead could mount in the middle of a repair.

Since 0.9.4:

- On a device with compare-and-write, the claim is taken, renewed and released with compare-and-write, as the kernel does, so two repairs started together can't both go ahead.
- While it works, the repair keeps watching the registry. If a node starts heartbeating under its claim, it stops; a repair that has lost its claim writes nothing more.
- Killed with `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT`, `SIGPIPE` or `SIGABRT`, it releases the claim. A claim left by `SIGKILL` or a crash is reaped by the next mount or tool.
- When the registry is full, a repair borrows the row of a node that has provably left, and gives it back afterwards. `fsck.cetra -r` also retires departed rows nothing references, so a volume that has seen many machines can register new ones. Other nodes show the row as `REPAIR-IN-PROGRESS` in [`cluster`](/docs/reference/procfs/#cluster).

A second `fsck.cetra -r` on a volume already being repaired stops with `is already being repaired` and exit code `3`. A check without `-r` takes no claim.

## Exit status

| Code | Meaning |
|---|---|
| `0` | Clean |
| `1` | Problems found |
| `2` | Bad invocation |
| `3` | Couldn't examine the device |

## Notes

- Use an `fsck.cetra` from the same build as the kernel module. A mismatched version can misread the format.
- After an unclean shutdown, expect a few orphans, counter drift and leaked blocks. See [Journaling and crash consistency](/docs/concepts/journaling/#per-fsync-not-per-syscall).
