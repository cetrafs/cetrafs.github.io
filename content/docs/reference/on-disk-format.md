---
weight: 540
title: "On-disk format"
description: "The cetrafs on-disk layout and structures: superblock, Zone and Block Group descriptors, Node Registry, journals, inodes, extents, directory entries and feature flags."
toc: true
---

The authoritative specification is `include/cetrafs.h` in the source tree. The kernel module and the userspace tools both compile against it. This page summarises it for format version **`0x0006`**.

## Conventions

- Block size is fixed at **4096 bytes**. All offsets are block numbers (LBAs).
- Every multi-byte field is **little-endian**.
- Structures are byte-packed, with no padding added by the compiler.
- Checksums are **CRC32C**, computed as `~crc32c(~0, buf)` over the structure with its own checksum field zeroed, and stored as a little-endian 64-bit value.
- A record that nodes update by compare-and-write fits entirely in the first **512 bytes** (`CETRAFS_HOT_SECTOR`) of its block.
- Several structures carry zero-filled `reserved` space. New fields have been taken from it without a format change, because zero reads as the correct default.

## Layout

`Z` = Zone Group count, `B` = Block Group count, `N` = Node Registry capacity.

```text
LBA 0                 Superblock
LBA 1 .. Z            Zone Group table          (1 block per Zone Group)
LBA 1+Z .. Z+B        Block Group table         (1 block per Block Group)
...                   Global inode bitmap
...                   Global inode table        (1 inode per block)
...                   Node Registry             (128-byte rows, packed)
...                   Pending-free queues       (fixed slots per Zone Group)
...                   Per-node journals         (N slices)
bg_regions_start      Block Group regions 1 .. B
```

Every region start is a superblock field. Mount checks the whole map: every region starts after block 0, nothing wraps, everything fits inside `total_blocks`, no regions overlap, and every count fits its region.

## Superblock (block 0, 424 bytes)

| Field | Meaning |
|---|---|
| `magic` | `0xC4553770` |
| `version` | Format version (`0x0006`). Changed freely before 1.0; never migrated. |
| `sb_bytes` | Size of the superblock structure, as a sanity check |
| `block_size` | 4096 |
| `total_blocks` | Device size in blocks |
| `zone_group_count`, `block_group_count` | Z, B |
| `zg_table_start`, `bg_table_start` | Descriptor tables |
| `inode_bmap_start/_blocks`, `inode_table_start/_blocks` | Global inode bitmap and table |
| `bg_regions_start` | First Block Group region |
| `root_ino` | Root directory inode (1) |
| `inode_size`, `inodes_count` | On-disk inode size; total inode slots |
| `bg_size_blocks` | Target Block Group span |
| `cluster_id` | Cluster identifier |
| `node_table_start/_blocks/_count`, `node_entry_size` | Node Registry location and capacity |
| `pending_free_start`, `pending_free_blocks_per_zg` | Pending-free queues |
| `node_journal_start`, `node_journal_blocks` | Per-node journal area and size per node |
| `features_compat/_incompat/_ro_compat` | Feature bitmaps |
| `checksum` | CRC32C |
| `uuid` | Filesystem UUID |

## Zone Group descriptor (one block each)

The **hot sector** (first 512 bytes, changed by compare-and-write) holds `zg_id`, `owner_node_id` (registry row, or `0xFFFF` for none), `free_data_blocks` (the sum of its Block Groups' free counts), `hb_seq` and `hot_checksum`. The **cold** part, fixed at mkfs time, holds `first_bg_id`, `bg_count` and `cold_checksum`.

## Block Group descriptor and region

The descriptor holds `bg_id`, `owner_zg`, `start_block`, `length_blocks`, the offsets of the header, bitmap and data within the region, `data_block_count`, the cached `free_data_blocks`, `checksum`, and `reconcile_seq`. `reconcile_seq` advances whenever a change of Zone Group ownership rewrites the free count from the bitmap, so a late update from the previous owner is detected and dropped.

Each region:

```text
| header (1 block) | data bitmap (dbm blocks) | data blocks |
```

where `dbm = ceil((length_blocks − 1) / 32769)`. A 1 GiB Block Group (262,144 blocks) has 8 bitmap blocks and 262,135 data blocks.

## Node Registry row (128 bytes)

| Field | Meaning |
|---|---|
| `node_uuid[16]` | Stable machine UUID |
| `state` | `FREE` (0) or `REGISTERED` (1) |
| `hb_seq` | Heartbeat counter |
| `last_seen` | Unix seconds of the last heartbeat (backdated on a clean unmount) |
| `label[32]` | Hostname, informational |
| `checksum` | CRC32C |
| `fence_epoch` | The node's lease. Incremented by whoever takes over its resources; the node fences itself when it changes. |
| `hb_interval_secs` | The node's own heartbeat rate |

## Per-node journal

Slice `node_journal_start + row × node_journal_blocks` belongs to registry row `row`. It holds a **flag block** (`state` CLEAN or DIRTY; `replay_owner`, claimed by compare-and-write) followed by two-block **slots**. A slot is a header block (`magic`, `txn_id`, `target_lba`, `payload_checksum`, the target's checksum before the change, flags such as `F_FRESH`, `header_checksum`) followed by a payload block holding the complete new contents of the target.

## Pending-free queue entry (16 bytes)

`{lba, count, magic}`: an extent freed by a node that doesn't own the Zone Group, waiting for the owner to apply it.

## Inode (one per 4 KiB block)

| Field | Meaning |
|---|---|
| `ino`, `mode`, `uid`, `gid`, `nlink`, `size`, `blocks`, `atime`, `mtime`, `ctime` | Standard |
| `flags` | `EXTENTS` (always), `XATTR` |
| extent root | Header plus 4 inline extents (depth 0) or 4 index entries (depth 1–2) |
| `xattr_block` | External xattr block, or 0 |
| `lock_owner_node`, `lock_mode` | Whole-file exclusive lock |
| `ns_lock_owner` | Per-inode namespace lock (`0xFFFF` when free) |
| `read_open_nodes` | 64-bit read-presence mask, one bit per registry row |
| `dirent_seq` | Directories: incremented on every directory-block change |
| `generation` | Stamped at allocation; detects inode-number reuse |
| `inode_checksum` | CRC32C |

## Extents

```text
extent header   12 bytes: magic, entries, max, depth, generation
extent          16 bytes: logical block (32-bit), length (31-bit + uninitialized flag), physical block
extent index    12 bytes: logical block, physical block of child
```

The tree is at most depth 2: the inode's 4 inline slots, then interior blocks, then leaf blocks. Arrays at every depth are **append-only and unordered**, so growing a file always edits a single block, and readers handle any order. Leaf and interior blocks end with a checksummed `{magic, crc}` tail. An extent marked *uninitialized* was preallocated and reads as zeroes until it is written.

## Directory entry (266 bytes, fixed size)

`inode (u64) + name_len (u16) + file_type (u8) + name[255]`. 15 entries fit in a block, and each block ends with a checksummed `{magic, crc}` tail. Directories use the same extent machinery as files, up to depth 1.

## Extended attribute entry (322 bytes)

`key[64] + value_len (u16) + value[256]`, packed into one block per inode (about 12 entries) with a checksummed tail. `key` holds the full name including its namespace; an empty key marks a free slot.

## Feature flags

| Flag | Bit | Set by mkfs |
|---|---|---|
| `INCOMPAT_EXTENTS` | 0 | yes |
| `INCOMPAT_GLOBAL_ITBL` | 1 | yes |
| `INCOMPAT_BIT2_UNUSED` | 2 | no (formerly the SCSI PR backend) |
| `INCOMPAT_NODE_REGISTRY` | 3 | yes |
| `ROCOMPAT_SPARSE` | 0 | no |

An unknown incompatible bit prevents the mount. An unknown read-only-compatible bit forces a read-only mount. `fsck` reports unknown bits by name.
