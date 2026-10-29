---
weight: 505
title: "mkfs.cetra"
description: "Create a cetrafs volume: synopsis, every option with its default and bounds, auto-tuning, and exit codes."
toc: true
---

## Synopsis

```text
mkfs.cetra <blockdev> [-z ZGs] [-b BG_MiB] [-N inodes] [-J MiB] [-M nodes] [-s size] [-n] [-f]
```

The device **must be the first argument**. Options follow it.

## Options

| Option | Meaning | Default | Bounds |
|---|---|---|---|
| `-z ZGs` | Number of Zone Groups | 16 | 1–255; clamped down to the actual number of Block Groups |
| `-b BG_MiB` | Block Group size in MiB | 1024; automatically 512 on small devices | ≥ 512 |
| `-N inodes` | Total inodes | 1 per 4 MiB of device, capped at 65,536 | ≥ 1024; must fit a 32-bit count |
| `-J MiB` | Journal size **per node**, in MiB | 2; shrunk so the total across all node slots stays near 5% of the device | `0` disables journaling; otherwise at least 12 KiB per node |
| `-M nodes` | Node Registry capacity (maximum cluster nodes) | 64 | 1–64 |
| `-s size` | Format only this much of the device and leave the rest unused, for a later [grow](/docs/reference/growfs/). Takes a `K`, `M`, `G` or `T` suffix; a bare number is MiB. | The whole device | A multiple of 4 KiB |
| `-n` | Dry run: compute and print the geometry, write nothing | | |
| `-f` | Force: overwrite a device that looks non-empty. **Never** overrides a live peer. | | |

## Auto-tuning

When `-b` and `-J` are omitted:

- **Block Group size** drops from 1024 MiB to 512 MiB when 1024 MiB would lose more than about 10% of the device to rounding. There is no partial Block Group at the end of the device.
- **Journal size** is capped so that all `-M` per-node journals together take about 5% of the device.

Both have no effect on normal-sized LUNs, and passing `-b` or `-J` explicitly overrides them.

## What it writes

The superblock, the Zone Group table, the Block Group table, the global inode bitmap and inode table, an empty Node Registry, the pending-free queues, the per-node journal areas, every Block Group header and bitmap, and the root directory (inode 1). Every structure gets its checksum. Block Groups are dealt out to Zone Groups round-robin: Block Group *b* goes to Zone Group *b* mod *Z*, so each Zone Group gets `B / Z` of them and the first `B mod Z` get one extra. The volume is stamped format version `0x0009`.

## Output

A summary on stdout, beginning `cetrafs mkfs completed` (or `cetrafs mkfs (DRY-RUN)` with `-n`), listing the device size, Zone Group and Block Group counts and sizes, the location and size of each region, how Block Groups were divided among Zone Groups, and the superblock checksum.

## Exit status

| Code | Meaning |
|---|---|
| `0` | Volume created (or dry run completed) |
| `1` | Couldn't create: device too small (under 1024 blocks), non-empty without `-f`, impossible geometry, or a write failure |
| `2` | Bad invocation, or an argument out of range |
| `3` | Device couldn't be accessed, or is **mounted locally or by a live peer** |

## Examples

```sh
mkfs.cetra /dev/sdb -n          # preview
mkfs.cetra /dev/sdb             # defaults
mkfs.cetra /dev/sdb -M 8 -z 32  # 8 nodes, 32 Zone Groups
mkfs.cetra /dev/sdb -f          # reformat a device that held data
mkfs.cetra /dev/sdb -s 500G     # use 500 GiB now, grow into the rest later
```
