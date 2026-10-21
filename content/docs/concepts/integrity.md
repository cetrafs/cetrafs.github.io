---
weight: 435
title: "Checksums and integrity"
description: "CRC32C on every on-disk structure, verified by the kernel on read, the torn-read retry, inode generations, and how fsck decides what it may repair."
toc: true
---

## Checksums everywhere

Every on-disk structure carries a **CRC32C** (Castagnoli) checksum:

- the superblock,
- Zone Group descriptors (the contested first 512 bytes and the static remainder each have their own checksum),
- Block Group descriptors and headers,
- Node Registry rows,
- every inode,
- journal headers and payloads,
- the **tail** of every directory block, extent-tree block and extended-attribute block.

The **kernel verifies** these on read, not just fsck. A record with a bad checksum is never trusted.

## Torn reads are retried, not reported

Nodes read shared metadata without holding a lock, so a node can read a block while another node is in the middle of writing it, and see half of each version. A checksum mismatch is therefore retried a few times, with a short backoff, before cetrafs declares real corruption. Directory blocks carry their own checksummed tail for the same reason: a reader that catches a 4 KiB directory block half-written retries instead of misreading the entries.

## Generations catch reused inode numbers

An inode number can be freed on one node and reused on another while some node still caches the old file. Each inode is stamped with a **generation** when it is allocated, and every rewrite keeps it. A node that finds a cached inode whose generation doesn't match the disk discards the cached copy and loads the inode again.

## The volume map is checked, not just checksummed

At mount, cetrafs checks the whole region map the superblock describes: every region starts after block 0, nothing wraps, everything fits inside the device, no regions overlap, and every count fits its region. A superblock with a correct checksum but impossible geometry is still refused.

Volumes from an unknown format version, or carrying an unknown *incompatible* feature bit, are refused. An unknown *read-only-compatible* bit forces a read-only mount.

## Endianness

The on-disk format is little-endian. Every multi-byte field is declared as a little-endian type and is only accessed through conversion helpers. A sparse-based build check (`make endian-check`) treats any raw access as an error, so the format is portable across host byte order by construction. Only little-endian hosts have actually been tested.

## How fsck decides what to repair

`fsck.cetra -r` follows one principle: **repair only what has one correct answer.**

- A bitmap bit that disagrees with the extent trees has one right value. So does a cached free count against its bitmap, and a link count against the directory entries that name the inode. These are repaired.
- An orphan inode with `nlink=0` is garbage and is freed. An orphan with `nlink>0` lost its directory entry, so it goes to `/lost+found`.
- **Two files claiming the same block** has no correct answer: nothing on disk says which file should keep it. Neither does an unreadable inode, whose blocks might belong to a live file, or a directory entry pointing at nothing, where removing it destroys a name.

For the second group fsck reports and **changes nothing**. A wrong guess would turn a contained fault into lost data across files. That is worse than leaving it for a person to decide.
