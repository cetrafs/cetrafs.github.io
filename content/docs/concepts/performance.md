---
weight: 440
title: "Performance model"
description: "Why data throughput is high and metadata operations are slow, what the measurements show, and how to benchmark cetrafs honestly."
toc: true
---

## Two very different paths

**File data** goes straight to the disk. A node writes blocks it owns, or blocks of a file it has locked, with no cross-node coordination at all. Contiguous runs are mapped in one call, so a direct read of 2,048 contiguous blocks costs one mapping lookup instead of 2,048. qemu's `cache=none` is direct I/O, so this is the path a guest actually uses.

**Metadata operations** are **synchronous and coherent across nodes**. A create, mkdir or unlink takes ordered compare-and-writes for the namespace lock, reads of directory blocks fresh from the device, and journaled writes. Each of those is a real round trip to the array, and about 40% of an operation is compare-and-writes that have to happen in order and can't be overlapped.

## Measured

Data path, on HPE 3PAR over 32 Gb FC multipath, arm64 Proxmox nodes:

| Workload | cetrafs | GFS2, same LUN |
|---|---|---|
| `dd bs=1M oflag=direct` | **613–710 MB/s** | 283 MB/s |
| `dd bs=1M iflag=direct` (read) | **1.0–1.2 GB/s** | not measured |
| `dd bs=1M oflag=sync` | 340–424 MB/s | 241–242 MB/s |

Metadata operations, on a 5 GiB iSCSI LUN with atomic CAW:

| Operation | Time |
|---|---|
| create | ~407 ms |
| mkdir | ~416 ms |
| unlink | ~457 ms |
| rmdir | ~513 ms |
| stat | ~21 ms |
| *one device read / synchronous write / compare-and-write* | *~5.5 / ~38 / ~36 ms* |

## What that means for workloads

The design trades metadata speed for coherence without a lock manager. That fits **VM images**: a datastore holds a few hundred large files, each opened once and written for months. It fits **many small files badly**: a build tree, a mail spool or a home directory server would spend its time in metadata round trips. That isn't what cetrafs is for.

## Inside the guest

Most of the gap between a host's throughput and a guest's is qemu configuration, not the filesystem. On the same stack, `aio=threads` against `io_uring` was worth 30% on raw images and more than 4× on qcow2, and qcow2's fragmentation adds to that. See [Configure VM disks for cetrafs](/docs/how-tos/configure-vm-disks/).

## Benchmarking honestly

Shared arrays are noisy, and these points have led to wrong conclusions before:

- **Use a new filename for every write run.** Rewriting an existing file reuses blocks that are already allocated and never exercises the allocator, so it measures something else.
- **Measure durable writes.** A plain buffered `dd` measures the page cache. Use `oflag=direct` or `oflag=sync`.
- **Quote ranges, not single numbers.** Two back-to-back runs of the same command on one node have differed by 18% on writes and 28% on reads. A single-run A/B difference smaller than about 30% tells you nothing.
- **Interleave A, B, A, B**, and use a ratio (for example write/read throughput in the same session) as the control. Absolute numbers drift with whatever else is using the array; ratios hold steady.
- **Turn off qemu's `detect_zeroes`** when writing zeroes inside a guest, or qemu drops the writes.
- **A loop device proves nothing about speed.** It has no compare-and-write and serves "uncached" reads from the host page cache.

The counters in `/proc/fs/cetrafs/<dev>/info` show regressions without a profiler: `bg_pick_cursor` against `bg_pick_scan` (is allocation scanning?), `bg_desc_kept` against `bg_desc_refreshed` (is something dropping the allocator's cache?), and `map_calls` against `map_blocks` (are block mappings coming back in contiguous runs?).
