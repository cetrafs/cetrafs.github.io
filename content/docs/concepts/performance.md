---
weight: 440
title: "Performance model"
description: "Why data throughput is high and metadata operations are slow, what the measurements show, and how to benchmark cetrafs honestly."
toc: true
---

## Two very different paths

**File data** goes straight to the disk. A node writes blocks it owns, or blocks of a file it has locked, with no cross-node coordination at all. Contiguous runs are mapped in one call, so a direct read of 2,048 contiguous blocks costs one mapping lookup instead of 2,048. qemu's `cache=none` is direct I/O, so this is the path a guest actually uses. Aligned direct overwrites of blocks already written run in parallel, under a shared lock.

**Metadata operations** are **synchronous and coherent across nodes**. A create, mkdir or unlink takes ordered compare-and-writes for the namespace lock, reads of directory blocks fresh from the device, and journaled writes. Each of those is a real round trip to the array, and about 40% of an operation is compare-and-writes that have to happen in order and can't be overlapped.

## Measured

Data path, on HPE 3PAR over 32 Gb FC multipath, arm64 Proxmox nodes:

| Workload | cetrafs | GFS2, same LUN |
|---|---|---|
| `dd bs=1M oflag=direct` | **613–710 MB/s** | 283 MB/s |
| `dd bs=1M iflag=direct` (read) | **1.0–1.2 GB/s** | not measured |
| `dd bs=1M oflag=sync` | 340–424 MB/s | 241–242 MB/s |

4 KiB random `O_DIRECT` I/O with fio, on an enterprise FC array, one node, a fully written 16 GiB file:

| Queue depth 16 | `libaio` | `io_uring` |
|---|---|---|
| Random write | 29,207 IOPS | 25,451 IOPS |
| Random read | 47,730 IOPS | 38,381 IOPS |

cetrafs doesn't advertise non-blocking direct I/O, so `io_uring` hands every request to a worker thread, which costs 13–20% at depth 16. That is one reason to [avoid `aio=io_uring`](/docs/how-tos/configure-vm-disks/#set-aiothreads) for VM disks.

Metadata operations, on a 5 GiB iSCSI LUN with atomic CAW:

| Operation | Time |
|---|---|
| create | ~407 ms |
| mkdir | ~416 ms |
| unlink | ~457 ms |
| rmdir | ~513 ms |
| stat | ~21 ms |
| *one device read / synchronous write / compare-and-write* | *~5.5 / ~38 / ~36 ms* |

## Direct writes into holes

qemu with `cache=none` writes a thin VM image with `O_DIRECT`, and the first write to each block of a sparse or preallocated image lands in a hole or in preallocated space. cetrafs keeps those writes direct: a hole is allocated as preallocated space, the data goes straight to the device, and the blocks are marked written only when the write completes, so nothing (a reader, a peer, a crash) can see what they held before. The guest keeps its queue depth. On a 1 Gbit iSCSI node:

| `O_DIRECT` writes | Throughput |
|---|---|
| Random 4 KiB into a hole, QD32 | 1,578–1,597 IOPS |
| Sequential 1 MiB into a hole, QD16 | 94–95 MiB/s (link-bound) |
| Random 4 KiB into preallocated space, QD32 | 1,291–1,296 IOPS |
| Random 4 KiB overwrite, for reference | 21,019–21,226 IOPS |

Random writes into holes stay far below overwrites: each one changes the extent tree. A first write into preallocated space marks a 64 KiB unit written at a time, so a guest writing in small scattered pieces doesn't split the extent once per block. Writes smaller than a block (a 512-byte guest sector) wait for each other, as on ext4. `dio_fallbacks` in [`info`](/docs/reference/procfs/#performance) counts direct writes that went through the page cache and should stay at 0.

## Zeroing and space reclaim

`fallocate(ZERO_RANGE)`, which qemu uses for write-zeroes requests, zeroes written blocks in place with the SCSI WRITE ZEROES command, without freeing or moving anything. On an FC array, a stream of 1 MiB zeroings from one process ran at 733 per second, 17 times the old punch-and-reallocate path, and left the file's layout untouched where the old path turned 9 extents into 6,376. A 1 MiB zeroing costs what the raw command does, about 1.2 ms.

UNMAP of an emptied Block Group runs in the background, as the group is handed back. Measured on an FC array with fio running on two nodes, handing back about 35 GiB of Block Groups while files were deleted didn't move the guests' IOPS beyond the noise. `fstrim` of 1 GiB of freed space inside Block Groups took 1.5 s with fio running on both nodes; a first `fstrim` over 1.5 TiB of unowned Block Groups took 155 s, with the guests on the other node still running. See [Return free space to a thin LUN](/docs/how-tos/reclaim-thin-space/).

## Aged images

A buffered write asks for the location of its data one 4 KiB block at a time. On a file rewritten in place for months, the extent-tree leaves cover wide, overlapping ranges, so walking the tree from the top for every block would read several leaves each time: a VM image would slow down as it aged.

So each file remembers several recently found extents, and the blocks that follow are answered from them without walking the tree. A change to the file's extent map invalidates them. Rewriting 1 GiB at 64 KiB into an already allocated file, on an FC array:

| | Compact file | Fragmented file |
|---|---|---|
| Throughput | 1173 MB/s | 1091 MB/s |

`ext_cache_hits` and `ext_cache_misses` in [`info`](/docs/reference/procfs/#performance) show whether the cache is working. Several invariants of this kind are guarded by tests that count device reads per operation, so a change that put a tree walk back on every block fails the gate.

## Read-only opens

A file opened only for reading holds no lock, but nothing it is reading through can be freed while it has the file open (see [What a reader sees](/docs/concepts/locking/#what-a-reader-sees)). So a reader trusts its cached layout between changes to the file, checking once a second whether one has happened, and buffered reads use readahead. That is how a qcow2 backing file, or a base image shared by linked clones, is read. Reading in 1 MiB `read()` calls on an FC array:

| Read-only open | Throughput |
|---|---|
| Default mount, sparse 8 GiB file | 2051 MB/s |
| Default mount, 2 GiB of data | 2361 MB/s |
| `nofilelock`, file also open on a second node | 2393 MB/s |

## What that means for workloads

The design trades metadata speed for coherence without a lock manager. That fits **VM images**: a datastore holds a few hundred large files, each opened once and written for months. It fits **many small files badly**: a build tree, a mail spool or a home directory server would spend its time in metadata round trips. That isn't what cetrafs is for.

## Inside the guest

Most of the gap between a host's throughput and a guest's is qemu configuration, not the filesystem. On the same stack, `aio=threads` against `io_uring` was worth 30% on raw images and more than 4× on qcow2, and qcow2's fragmentation adds to that. See [Configure VM disks for cetrafs](/docs/how-tos/configure-vm-disks/).

## Benchmarking honestly

Shared arrays are noisy, and these points have led to wrong conclusions before:

- **Measure the raw device in the same session.** The array is shared, and its own throughput moves. In one session the same LUN gave 564 MB/s with `dd bs=1M oflag=direct` and no filesystem at all, while cetrafs on it gave 470–543 MB/s: 83–96% of a ceiling that was itself below the range in the table above. Without the raw figure, that reads as a 30% regression in cetrafs.
- **Use a new filename for every write run.** Rewriting an existing file reuses blocks that are already allocated and never exercises the allocator, so it measures something else.
- **Measure durable writes.** A plain buffered `dd` measures the page cache. Use `oflag=direct` or `oflag=sync`.
- **Quote ranges, not single numbers.** Two back-to-back runs of the same command on one node have differed by 18% on writes and 28% on reads. A single-run A/B difference smaller than about 30% tells you nothing.
- **Interleave A, B, A, B**, and use a ratio (for example write/read throughput in the same session) as the control. Absolute numbers drift with whatever else is using the array; ratios hold steady.
- **Turn off qemu's `detect_zeroes`** when writing zeroes inside a guest, or qemu drops the writes.
- **A loop device proves nothing about speed.** It has no compare-and-write and serves "uncached" reads from the host page cache.

The counters in `/proc/fs/cetrafs/<dev>/info` show regressions without a profiler: `bg_pick_cursor` against `bg_pick_scan` (is allocation scanning?), `bg_desc_kept` against `bg_desc_refreshed` (is something dropping the allocator's cache?), and `map_calls` against `map_blocks` (are block mappings coming back in contiguous runs?).
