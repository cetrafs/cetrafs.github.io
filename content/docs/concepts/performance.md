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

## Direct writes into holes

qemu with `cache=none` writes a thin VM image with `O_DIRECT`, and the first write to each block of a sparse or preallocated image lands in a hole or in preallocated space. Before 0.9.4, cetrafs couldn't map such a write directly: the kernel finished it through the page cache with a synchronous flush, under the file's lock, so every one of them ran at queue depth 1 whatever the guest asked for.

Since 0.9.4 the write stays direct. A hole is allocated as preallocated space, the data goes straight to the device, and the blocks are marked written only when the write completes, so nothing (a reader, a peer, a crash) can see what they held before. On an FC array, random 4 KiB writes into a sparse file are 35–40% faster. On a 1 Gbit iSCSI node, with the queue depths of a typical fio job:

| `O_DIRECT` writes | Before 0.9.4 | 0.9.4 |
|---|---|---|
| Random 4 KiB into a hole, QD32 | 1,357–1,371 IOPS | 1,578–1,597 IOPS |
| Sequential 1 MiB into a hole, QD16 | 72 MiB/s | 94–95 MiB/s (link-bound) |
| Random 4 KiB into preallocated space, QD32 | 960–965 IOPS | 1,291–1,296 IOPS |
| Random 4 KiB overwrite, for reference | | 21,019–21,226 IOPS |

Random writes into holes stay far below overwrites. A file filled in random order has extent leaves that each span the whole file, so finding a hole reads most of them; that cost predates 0.9.4. Writes smaller than a block (a 512-byte guest sector) wait for each other, as on ext4; a guest with 4 KiB sectors keeps its queue depth. `dio_fallbacks` in [`info`](/docs/reference/procfs/) counts direct writes that still went through the page cache and should stay at 0; the module parameter `dio_fill_holes=0` brings the old path back.

## Aged images

A buffered write asks for the location of its data one 4 KiB block at a time. Before 0.9, each of those lookups walked the file's extent tree from the top. On a compact file that costs nothing, because the inode's own slots rule out every leaf without reading one. On a file rewritten in place for months, the leaves cover wide, overlapping ranges, so most lookups read several of them: a VM image slowed down as it aged.

Since 0.9, each file remembers the last extent a lookup found, and the blocks that follow are answered from it without walking the tree. A change to the file's extent map invalidates it, and a preallocated extent is never remembered. Rewriting 1 GiB at 64 KiB into an already allocated, fragmented file, on the same FC array:

| | Compact file | Fragmented, before 0.9 | Fragmented, 0.9 |
|---|---|---|---|
| Throughput | 1173 MB/s | 710 MB/s | **1091 MB/s** |
| Extent-tree reads, whole run | — | 1,150,546 | **32,109** |

Compact files were already on the fast path and are unchanged. `ext_cache_hits` and `ext_cache_misses` in [`info`](/docs/reference/procfs/) show whether the cache is working.

## Read-only opens

A file opened only for reading holds no lock, and before 0.9.3 that made cetrafs distrust its cached copy of the file's layout: every 4 KiB it read, holes included, cost a fresh read of the inode record from the device. That is exactly how a qcow2 backing file, or a base image shared by linked clones, is read.

Since 0.9.3 a reader trusts its cached layout between changes to the file, checking once a second whether one has happened. That is safe because nothing a reader is reading through can be freed while it has the file open (see [What a reader sees](/docs/concepts/locking/#what-a-reader-sees)). Buffered reads also use readahead now, so contiguous pages go out as one request instead of one per 4 KiB. Reading in 1 MiB `read()` calls, on the same FC array, a file holding 2 GiB of data or an 8 GiB sparse one:

| Read-only open | Before 0.9.3 | 0.9.3 |
|---|---|---|
| Default mount, sparse file | 18 MB/s | **2051 MB/s** |
| Default mount, data | 18 MB/s | **2361 MB/s** |
| `nofilelock`, file also open on a second node | 17 MB/s | **2393 MB/s** |

Readahead helps a file open for writing too: buffered reads of data on a default mount went from 1834 to 2730 MB/s.

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
