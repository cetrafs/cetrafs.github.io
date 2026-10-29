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

Refuses to run if the volume is **mounted locally**, or if its Node Registry has a **live row** (some node has it mounted, or crashed less than a stale window ago).

## Passes

| Pass | Checks |
|---|---|
| 1. Structural | Format version (`0x0008` or `0x0009`); superblock checksum and region map, including what past grows recorded; the Block Group table chain (no loop, no segment outside its place, as many descriptors as Block Groups); Zone Group and Block Group descriptors and headers; every Block Group owned by a real Zone Group or by none, with no two Block Groups overlapping; Node Registry rows |
| 2. Cluster metadata | Per-node journal flags and slots; pending-free queue entries |
| 3. Content | Inode bitmap and data bitmaps against the extent trees (all depths), in both directions; cross-file block overlap; cached free counts against bitmaps; leaks |
| 4. Namespace | Every directory's entries and block tails; `.` and `..`; link counts against referring entries; directory entry type against inode mode; reachability from the root |

## What `-r` repairs

| Fault | Repair |
|---|---|
| Bitmap bit disagrees with the extent trees (leaked, or would be double-allocated) | Bit set to match the trees |
| Block Group or Zone Group cached free count disagrees with its bitmap | Count recomputed |
| A Zone Group's count of free space in unowned Block Groups (`pool_free_blocks`) disagrees with those Block Groups | Count recomputed |
| `nlink` disagrees with the entries naming the inode | `nlink` corrected |
| Orphan inode with `nlink = 0` | Freed |
| Orphan inode with `nlink > 0` (lost directory entry) | Linked into `/lost+found` as `#<ino>` |

If `-r` reports reclaimed blocks, run it again. Some reclamation it enables is picked up on the next pass.

## What `-r` refuses

Reported, never changed:

| Fault | Why |
|---|---|
| Cross-file block overlap | Nothing on disk says which file should keep the block |
| Unreadable inode record or extent header | Clearing its blocks could hand a live file's blocks to someone else |
| Dangling directory entry | Removing it destroys a name |

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
