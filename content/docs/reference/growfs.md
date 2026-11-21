---
weight: 517
title: "growfs.cetra"
description: "Grow a cetrafs volume into space its device already has, live or offline: synopsis, options, preconditions, what it writes, refusals and exit codes."
toc: true
---

## Synopsis

```text
growfs.cetra <blockdev> [-s size] [-N inodes] [-n]
```

Grows a cetrafs volume into space the device already has: a LUN that has been enlarged, or space that `mkfs.cetra -s` left unformatted. The device **must be the first argument**. For the whole procedure, see [Grow a volume](/docs/how-tos/grow-volume/).

## Options

| Option | Meaning | Default |
|---|---|---|
| `-s size` | Grow to this size instead of the whole device. Takes a `K`, `M`, `G` or `T` suffix; a bare number is MiB, as with `mkfs.cetra -s`. Must be a multiple of 4 KiB and no larger than the device. | The whole device |
| `-N inodes` | The inode count to grow to | What `mkfs.cetra` would give a volume of the new size, if that is more than the volume has |
| `-n` | Dry run: check the volume, compute and print the plan, write nothing | |

An argument `growfs.cetra` doesn't understand is refused before the device is touched.

## Live or offline

`growfs.cetra` picks the mode by whether this machine has the volume mounted.

**Live, on a machine that has it mounted.** Other nodes may have it mounted too, and guests keep running. The kernel publishes the grow, and refuses if:

- a registered node doesn't advertise the live-grow capability (`live_grow_ready: no` in [`cluster`](/docs/reference/procfs/#cluster));
- the mount is read-only or has stopped;
- the caller lacks `CAP_SYS_ADMIN`, or holds no `growfs.cetra` claim on the volume.

Every node's device must already show the new size. A node whose device is behind keeps its current layout and says so once in `dmesg`. Until it is rescanned, I/O there to files with blocks in the new space fails with `EIO`, and nothing is marked damaged. On multipath, the map must be resized as well as the paths.

**Offline, on a machine that doesn't have it mounted.** It refuses to run, even with `-n`, if another node's Node Registry row is still **heartbeating**, or if the registry can't be read to prove that none is.

**In both modes** it refuses to start while an `fsck.cetra -r` or another grow is running on the volume (`is being repaired right now`).

While it works, `growfs.cetra` holds the same claim as [`fsck.cetra -r`](/docs/reference/fsck/#while--r-runs): new mounts on every node are refused with `EBUSY` until it finishes, and existing mounts carry on during a live grow. If it is killed, it releases the claim on the way out; a claim left by `SIGKILL` or a crash is reaped once it is no longer renewed.

## What it does

The tool adds whole Block Groups, of the volume's Block Group size, after the existing ones, and, if the inode count grows, a new segment of the inode table. Existing structures **don't move**: the Zone Group table, the original Block Group and inode tables, the Node Registry, the pending-free queues and the journals stay where they are. The Zone Group count never changes.

The new descriptors go into a new segment of the Block Group table, in a **tail reserve** at the end of the grown area, linked to the existing table. The new inodes go into a segment next to it, linked the same way, and their numbers carry on where the table ended. See [the table chains](/docs/reference/on-disk-format/#table-chains).

**Offline**, the new Block Groups are assigned round-robin to the existing Zone Groups. The writes are ordered so that a crash at any point leaves either the volume as it was before, or the grown volume: the new regions and segments are written and flushed before anything refers to them, and the superblock is updated last.

**Live**, the new Block Groups start unowned, and nodes take them through the ordinary claim path. The tool writes them and the segments past the current end, then passes the new superblock to the kernel with the `CETRAFS_IOC_GROW` ioctl. The kernel checks every new Block Group header and inode segment on the device before it writes anything, then credits the unowned pool, links the segments and swaps block 0, each by compare-and-write. Other nodes compare `layout_gen` on every heartbeat and catch up when it moves, or at once when they first meet the new space.

Each grow increments `layout_gen`. Shrinking isn't possible: a smaller volume means a reformat.

## Output

First the plan, headed `plan` (or `(DRY-RUN)` with `-n`): the device size, the current and target size, the Block Group, Zone Group and inode counts before and after, where the new regions and the tail reserve go, any blocks left over by rounding, and how many blocks this grow and past grows have left unusable.

Then every node registered on the volume, and whether it can follow a live grow:

```text
  Nodes registered on this volume:
    row 0   pve1                     ready (module understands a grown layout)
    row 1   pve2                     ready (module understands a grown layout)
```

On success the last line is `cetrafs growfs: completed (layout_gen N) -- run fsck.cetra to verify`. After a live grow, which starts by printing `is mounted on … -- growing it live`, it is `cetrafs growfs: completed live (layout_gen N); every node picks up the new space on its next heartbeat`.

## If a live grow is interrupted

The volume stays at its old size and keeps working; run `growfs.cetra` again to finish. An interrupted grow can leave two marks, neither of them damage:

- `fsck.cetra` notes a table segment the superblock doesn't count yet. The next grow replaces it.
- A Zone Group's `pool_free_blocks` is too high: the grow credited the unowned pool and didn't publish. The next mount on any node, or the next grow, takes the credit back (`dmesg`: `held N blocks of a live grow that never published -- taken back`). Until then `df` overstates free space by that much.

## Space a grow can't use

Each grow after the first leaves the previous tail reserve behind, as a hole between the old Block Groups and the new ones. The superblock records those blocks in `orphan_blocks`, and the plan reports them. Space at the end of the device smaller than one Block Group is left unused too.

## Refusals

| Condition | Exit |
|---|---|
| Volume mounted by a node that is still heartbeating, and not mounted on this machine | `3` |
| Live: a registered node doesn't advertise the live-grow capability | `3` |
| Live: the volume changed while the grow ran | `3`: nothing was published; run it again |
| Live: the kernel found no `growfs.cetra` claim, or refused to publish | `3`: see `dmesg` |
| Node Registry unreadable | `3` |
| Not a cetrafs volume, another format version, wrong block size | `1` |
| Superblock checksum mismatch | `1`: run `fsck.cetra` first |
| The volume already fills the target size | `1` |
| The added space is smaller than one Block Group, or can't hold the new table segments | `1`: grow by more |
| `-s` larger than the device, malformed, or not a multiple of 4 KiB | `2` |

## Exit status

| Code | Meaning |
|---|---|
| `0` | Volume grown (or dry run completed) |
| `1` | Couldn't grow |
| `2` | Bad invocation, or an argument out of range |
| `3` | Device couldn't be accessed, **mounted by a live peer and not on this machine**, or a live grow wasn't published |

## Examples

```sh
growfs.cetra /dev/sdb -n            # preview
growfs.cetra /dev/sdb               # grow to the whole device
growfs.cetra /dev/sdb -s 2T         # grow to 2 TiB
growfs.cetra /dev/sdb -N 200000     # grow, and raise the inode count to 200,000
fsck.cetra --live /dev/sdb          # verify a live grow without unmounting
```
