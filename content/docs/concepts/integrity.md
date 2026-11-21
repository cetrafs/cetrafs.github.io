---
weight: 435
title: "Checksums and integrity"
description: "CRC32C on every on-disk structure and bitmap sector, verified by the kernel on read; address checks; what happens when damage is found; the superblock copy; and how fsck decides what it may repair."
toc: true
---

## Checksums everywhere

Every on-disk structure carries a **CRC32C** (Castagnoli) checksum:

- the superblock and its copy,
- Zone Group descriptors (the contested first sector and the static remainder each have their own),
- Block Group descriptors and headers,
- Node Registry rows,
- both sectors of every inode,
- journal headers and payloads,
- **every 512-byte sector** of the allocation bitmaps,
- the **tail** of every directory block, extent-tree block and extended-attribute block.

The **kernel verifies** these on read, not just `fsck`. A record with a bad checksum is never trusted.

A bitmap sector carries its own checksum because a sector is what the device writes atomically, so the bits and their checksum always land together: a mismatch there is damage, never a half-finished write. A node neither allocates from nor frees into a damaged sector, counts it in `bmap_crc_bad`, and `fsck.cetra -r` rewrites it.

## Torn reads are retried, not reported

Nodes read shared metadata without holding a lock, so a node can read a block while another node is in the middle of writing it, and see half of each version. A checksum mismatch on such a block is retried a few times, with a backoff of milliseconds, before cetrafs declares real damage.

## A checksum isn't a sanity check

A checksum proves a record is intact, not that what it says makes sense. A validly stamped extent can still point into the inode table. So every address read off the disk is range-checked before it aims an I/O: an extent or tree pointer outside the data region of a single Block Group is refused, never followed. Lengths and counts read off the disk are bounded the same way before they size a copy or a loop.

At mount, cetrafs also checks the whole region map the superblock describes: every region starts after block 0, nothing wraps, everything fits inside the device, no regions overlap, and every count fits its region. A superblock with a correct checksum but impossible geometry is refused.

## Generations catch reused inode numbers

An inode number can be freed on one node and reused on another while some node still caches the old file. Each inode is stamped with a **generation** when it is allocated, and every rewrite keeps it. A node that finds a cached inode whose generation doesn't match the disk discards the cached copy and loads the inode again.

## When damage is found

Damage found at runtime is contained, not spread:

- Every write to the file or directory it was found in fails with `EUCLEAN`, so nothing is freed or rewritten on the strength of a damaged extent tree. Reads of the undamaged parts still work, and the rest of the mount carries on.
- The first node to find it records a lasting **"needs fsck"** mark in the superblock. Every node reports it at mount and in `info` until a clean `fsck.cetra -r` clears it.

`corruption=stop` stops the mount instead. See [mount options](/docs/reference/mount-options/#why-damaged-metadata-doesnt-stop-the-mount-by-default) for why that isn't the default.

## The superblock copy

A copy of block 0 lives at block 2048, 8 MiB into the volume: past what a partition tool, a disk label or a `dd` aimed at the wrong disk usually reaches. If block 0 is overwritten, the mount refuses and says whether the copy is good, and `fsck.cetra -r` checks the volume through the copy and restores block 0 from it. See [Recover from a node failure](/docs/how-tos/recover-node-failure/#the-mount-says-block-0-doesnt-verify).

## Endianness

The on-disk format is little-endian. Every multi-byte field is declared as a little-endian type and only accessed through conversion helpers. A sparse-based check (`make endian-check`) treats any raw access as an error, so the format is portable across host byte order by construction. Only little-endian hosts have been tested.

## How `fsck` decides what to repair

`fsck.cetra -r` follows one principle: **repair only what has one correct answer.**

- A bitmap bit that disagrees with the extent trees has one right value. So does a cached free count against its bitmap, and a link count against the directory entries that name the inode. These are repaired.
- A damaged Zone Group record, Block Group descriptor or registry row can be rebuilt from what the rest of the volume says about it. These are rebuilt.
- An orphan inode with `nlink=0` is garbage and is freed. An orphan with `nlink>0` lost its directory entry, so it goes to `/lost+found`.
- **Two files claiming the same block** has no correct answer: nothing on disk says which file should keep it. Neither does an unreadable inode, whose blocks might belong to a live file, or a directory entry pointing at nothing, where removing it destroys a name.

For the last group `fsck` reports and **changes nothing**. A wrong guess would turn a contained fault into lost data across files.
