---
weight: 517
title: "growfs.cetra"
description: "Grow a cetrafs volume into space its device already has: synopsis, options, preconditions, what it writes, refusals and exit codes."
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

`growfs.cetra` is **offline**. It refuses to run, even with `-n`, if:

- the volume is **mounted on this machine**;
- another node's Node Registry row is still **heartbeating**, meaning that node has the volume mounted;
- the Node Registry can't be read, so it can't prove that no other node has the volume mounted.

Unmount the volume on every node first.

The volume must also be one this release accepts: format `0x0008` (0.8.x) or `0x0009`, with a valid superblock. A superblock checksum mismatch is refused with a request to run `fsck.cetra` first.

## What it does

The Zone Group count never changes. The tool adds whole Block Groups, of the volume's existing Block Group size, after the existing ones, and assigns them round-robin to the existing Zone Groups, the same way `mkfs.cetra` does. Existing structures **don't move**: the Zone Group table, the original Block Group table, the inode table, the Node Registry, the pending-free queues and the journals stay where they are.

The descriptors of the new Block Groups go into a new segment of the Block Group table, in a **tail reserve** at the end of the grown area, linked to the existing table. See [the Block Group table chain](/docs/reference/on-disk-format/#block-group-table-chain).

The writes are ordered so that a crash at any point leaves either the volume as it was before, or the grown volume. The new regions and the new segment are written and flushed before anything refers to them, and the superblock is updated last.

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

A row marked `NOT READY` was written by a module older than 0.9. The tool still grows the volume, but that node won't mount it until its module is upgraded. The notice also names the module loaded on this machine, if any.

On success the last line is `cetrafs growfs: completed (layout_gen N) -- run fsck.cetra to verify`.

## Space a grow can't use

Each grow after the first leaves the previous tail reserve behind, as a hole between the old Block Groups and the new ones. Those blocks can't become part of a Block Group. The volume records them in the superblock's `orphan_blocks`, and the plan reports them for this grow and in total. Space at the end of the device smaller than one Block Group is left unused too.

## Refusals

| Condition | Exit |
|---|---|
| Volume mounted locally, or by a node that is still heartbeating | `3` |
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
| `3` | Device couldn't be accessed, or is **mounted locally or by a live peer** |

## Examples

```sh
growfs.cetra /dev/sdb -n          # preview
growfs.cetra /dev/sdb             # grow to the whole device
growfs.cetra /dev/sdb -s 2T       # grow to 2 TiB
fsck.cetra /dev/sdb               # then verify
```
