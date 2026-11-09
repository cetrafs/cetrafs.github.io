---
weight: 517
title: "growfs.cetra"
description: "Grow a cetrafs volume into space its device already has, live or offline: synopsis, options, preconditions, what it writes, refusals and exit codes."
toc: true
---

## Synopsis

```text
growfs.cetra <blockdev> [-s size] [-n]
```

Grows a cetrafs volume into space the device already has: a LUN that has been enlarged, or space that `mkfs.cetra -s` left unformatted. The device **must be the first argument**. For the whole procedure, see [Grow a volume](/docs/how-tos/grow-volume/).

## Options

| Option | Meaning | Default |
|---|---|---|
| `-s size` | Grow to this size instead of the whole device. Takes a `K`, `M`, `G` or `T` suffix; a bare number is MiB, as with `mkfs.cetra -s`. Must be a multiple of 4 KiB and no larger than the device. | The whole device |
| `-n` | Dry run: check the volume, compute and print the plan, write nothing | |

## Preconditions

`growfs.cetra` runs in one of two modes, chosen by whether this machine has the volume mounted.

**Live, on a machine that has it mounted** (since 0.9.5). Other nodes may have it mounted too. The kernel publishes the grow, and it refuses if:

- any registered node doesn't advertise the live-grow capability. Modules from 0.9 to 0.9.4 advertise it but don't follow a live grow, so make sure every node runs 0.9.5 first;
- the mount is read-only or has stopped;
- the caller lacks `CAP_SYS_ADMIN`, or holds no `growfs.cetra` claim on the volume.

Every node's device must already show the new size. A node whose device is behind keeps its current layout and says so once in `dmesg`. Until it is rescanned, I/O there to files with blocks in the new space fails with `EIO`, and nothing is marked damaged.

**Offline, on a machine that doesn't have it mounted.** It refuses to run, even with `-n`, if:

- another node's Node Registry row is still **heartbeating**, meaning that node has the volume mounted;
- the Node Registry can't be read, so it can't prove that no other node has the volume mounted.

**In both modes** it refuses to start while an `fsck.cetra -r` or another grow is running on the volume (`is being repaired right now`).

While it works, `growfs.cetra` holds the same claim as `fsck.cetra -r`: new mounts on every node are refused with `EBUSY` until it finishes, and mounts that already exist carry on during a live grow. If it is killed, it releases the claim on the way out; a claim left by `SIGKILL` or a crash is reaped by the next mount, after the stale window. Since 0.9.4 an offline `growfs.cetra` also stops if a node starts heartbeating under its claim, and refuses to restamp a damaged record. See [While `-r` runs](/docs/reference/fsck/#while--r-runs).

The volume must also be one this release accepts: format `0x0009`, with a valid superblock. (0.9 and 0.9.1 also grew `0x0008` volumes from 0.8.x.) A superblock checksum mismatch is refused with a request to run `fsck.cetra` first.

## What it does

The Zone Group count never changes. The tool adds whole Block Groups, of the volume's existing Block Group size, after the existing ones. Existing structures **don't move**: the Zone Group table, the original Block Group table, the inode table, the Node Registry, the pending-free queues and the journals stay where they are.

The descriptors of the new Block Groups go into a new segment of the Block Group table, in a **tail reserve** at the end of the grown area, linked to the existing table. See [the Block Group table chain](/docs/reference/on-disk-format/#block-group-table-chain).

**Offline**, the new Block Groups are assigned round-robin to the existing Zone Groups, the same way `mkfs.cetra` does. The writes are ordered so that a crash at any point leaves either the volume as it was before, or the grown volume. The new regions and the new segment are written and flushed before anything refers to them, and the superblock is updated last.

**Live**, the new Block Groups start unowned, and nodes take them through the ordinary claim path. The tool writes them and the segment past the current end, then passes the new superblock to the kernel with the `CETRAFS_IOC_GROW` ioctl. The kernel walks the whole new layout before it writes anything, then credits the unowned pool, links the segment and swaps block 0, each by compare-and-write. Other nodes compare `layout_gen` on every heartbeat and catch up when it moves.

Each grow increments `layout_gen` and stamps the volume format **`0x0009`**.

## A one-way door

A module or tools older than 0.9 **refuse a grown volume**. That is deliberate: they would otherwise read the new layout as damage and invite a repair. So once a volume has been grown, every node that mounts it needs a cetrafs module from 0.9 or later, and you can't roll the packages back. Upgrade every node **before** you grow.

There is no shrinking. A smaller volume means a reformat.

## Output

First the plan, headed `plan` (or `(DRY-RUN)` with `-n`): the device size, the volume's current and target size, the Block Group and Zone Group counts before and after, where the new Block Group regions and the tail reserve go, any blocks left over by rounding, and how many blocks this grow and all past grows have left unusable.

Then a notice about the format version, with every node registered on the volume and whether its module can mount a grown volume:

```text
  Nodes registered on this volume:
    row 0   pve1                     ready (module understands a grown layout)
    row 1   pve2                     ** NOT READY -- module predates grow; it will refuse this volume **
```

A row marked `NOT READY` was written by a module older than 0.9. An offline grow still goes ahead, but that node won't mount the volume until its module is upgraded. A live grow is refused. The notice also names the module loaded on this machine, if any.

On success the last line is `cetrafs growfs: completed (layout_gen N) -- run fsck.cetra to verify`. After a live grow, which starts by printing `is mounted on … -- growing it live`, it is `cetrafs growfs: completed live (layout_gen N); every node picks up the new space on its next heartbeat`.

## Space a grow can't use

Each grow after the first leaves the previous tail reserve behind, as a hole between the old Block Groups and the new ones. Those blocks can't become part of a Block Group. The volume records them in the superblock's `orphan_blocks`, and the plan reports them for this grow and in total. Space at the end of the device smaller than one Block Group is left unused too.

## Refusals

| Condition | Exit |
|---|---|
| Volume mounted by a node that is still heartbeating, and not mounted on this machine | `3` |
| Live: a registered node doesn't advertise the live-grow capability | `3`: upgrade it, or grow offline |
| Live: the volume changed while the grow ran | `3`: nothing was published; run it again |
| Live: the kernel found no `growfs.cetra` claim, or refused to publish | `3`: see `dmesg` |
| Node Registry unreadable | `3` |
| Not a cetrafs volume, unsupported format version, wrong block size | `1` |
| Superblock checksum mismatch | `1`: run `fsck.cetra` first |
| The volume already fills the target size | `1` |
| The added space is smaller than one Block Group, or can't even hold the new table segment | `1`: grow by more |
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
growfs.cetra /dev/sdb -n          # preview
growfs.cetra /dev/sdb             # grow to the whole device
growfs.cetra /dev/sdb -s 2T       # grow to 2 TiB
fsck.cetra /dev/sdb               # then verify
```
