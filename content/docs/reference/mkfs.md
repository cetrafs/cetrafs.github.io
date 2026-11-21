---
weight: 505
title: "mkfs.cetra"
description: "Create a cetrafs volume: synopsis, every option with its default and bounds, auto-tuning, what it writes, and exit codes."
toc: true
---

## Synopsis

```text
mkfs.cetra <blockdev> [-z ZGs] [-b BG_MiB] [-N inodes] [-J MiB] [-M nodes] [-A KiB] [-s size] [-n] [-f]
```

The device **must be the first argument**. Options follow it.

## Options

| Option | Meaning | Default | Bounds |
|---|---|---|---|
| `-z ZGs` | Number of Zone Groups | The larger of 16 and `-M` | 1–255; reduced to what the device can back. A warning is printed when there are fewer Zone Groups than nodes. |
| `-b BG_MiB` | Block Group size in MiB | 1024; automatically 512 on small devices | ≥ 512 |
| `-N inodes` | Initial inode count | 1 per 4 MiB of device, capped at 65,536 | ≥ 1024. A [grow](/docs/reference/growfs/) can add more. |
| `-J MiB` | Journal size **per node**, in MiB | 2; shrunk so the total across all node slots stays near 5% of the device | `0` disables journaling; otherwise at least 8 slots per node and at most 16384 MiB |
| `-M nodes` | Node Registry capacity (maximum cluster nodes) | 64 | 1–64 |
| `-A KiB` | Data alignment: every Block Group and its data region start on a multiple of it | 1024 (1 MiB) | A power of two from 4 to 65536 that divides the Block Group size. `4` means no alignment. |
| `-s size` | Format only this much of the device and leave the rest for a later [grow](/docs/reference/growfs/). Takes a `K`, `M`, `G` or `T` suffix; a bare number is MiB. | The whole device | A multiple of 4 KiB |
| `-n` | Dry run: compute and print the geometry, write nothing | | |
| `-f` | Force: format a device that looks non-empty, or whose old superblock no longer verifies. **Never** overrides a live peer. | | |

Numeric options are parsed strictly: `-z 5x` is refused instead of being read as 5. An argument `mkfs.cetra` doesn't understand is refused too.

## Auto-tuning

- **Zone Groups** default to one per possible node, at least 16, so every node that mounts can hold write capacity. On a small device, where the Zone Groups' pending-free queues would leave no room for a Block Group, the count is halved until it fits.
- **Block Group size** drops from 1024 MiB to 512 MiB when 1024 MiB would lose more than about 10% of the device to rounding.
- **Journal size** is capped so that all `-M` per-node journals together take about 5% of the device.

Passing `-z`, `-b` or `-J` explicitly overrides the automatic choice.

## Alignment

`-A` lines the data up with the array's allocation unit or stripe, so that an emptied Block Group's [UNMAP](/docs/how-tos/reclaim-thin-space/) covers whole allocation units and the array can actually release them. The 1 MiB default suits most arrays. Check your array's documentation for its UNMAP granularity, and set `-A` to it if it is larger. The alignment is fixed for the life of the volume; a grow places its new Block Groups by it.

## What it writes

The superblock, a copy of it at block 2048 (8 MiB in), the Zone Group table, the Block Group table, the inode bitmap and the inode table (every slot written as an empty record), an empty Node Registry, the pending-free queues, the per-node journal areas, every Block Group header and bitmap, and the root directory (inode 1). Every structure carries its checksum, and every volume gets its own UUID.

Block Groups are dealt out to Zone Groups round-robin: Block Group *b* goes to Zone Group *b* mod *Z*. The volume is stamped format version `0x000A`.

The copy of block 0 is written first and block 0 itself last, after everything else has been flushed, so an interrupted `mkfs.cetra` can't leave a new superblock pointing at a journal area that still holds the previous volume's entries. It also clears a backup GPT partition table at the end of the device, so a partitioning tool doesn't later "restore" a table over the volume.

## Safety checks

Before writing, `mkfs.cetra` refuses a device that is:

- mounted on this machine, in any mount namespace: it opens the device exclusively, and the kernel refuses that while a mount holds it;
- in use by a live peer: it reads the old volume's Node Registry from the device and watches every row that hasn't left cleanly, refusing while one is still heartbeating. If block 0 has been wiped, it finds the registry through the copy at block 2048.

`-f` overrides neither.

## Output

A summary on stdout, beginning `cetrafs mkfs completed` (or `cetrafs mkfs (DRY-RUN)` with `-n`): the device size, Zone Group and Block Group counts and sizes, the location and size of each region, how Block Groups were divided among Zone Groups, and the superblock checksum.

## Exit status

| Code | Meaning |
|---|---|
| `0` | Volume created (or dry run completed) |
| `1` | Couldn't create: device too small, non-empty without `-f`, impossible geometry, or a write failure |
| `2` | Bad invocation, or an argument out of range |
| `3` | Device couldn't be accessed, or is **mounted locally or by a live peer** |

## Examples

```sh
mkfs.cetra /dev/sdb -n          # preview
mkfs.cetra /dev/sdb             # defaults
mkfs.cetra /dev/sdb -M 8        # an 8-node cluster: 16 Zone Groups, 8 registry rows
mkfs.cetra /dev/sdb -A 16384    # align data to a 16 MiB array allocation unit
mkfs.cetra /dev/sdb -f          # reformat a device that held data
mkfs.cetra /dev/sdb -s 500G     # use 500 GiB now, grow into the rest later
```
