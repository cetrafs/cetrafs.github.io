---
weight: 540
title: "On-disk format"
description: "The cetrafs on-disk layout: superblock, Zone and Block Group descriptors, Node Registry, journals, inodes, extents, directory entries and feature flags."
toc: true
---

The authoritative specification is `include/cetrafs.h` in the source tree. The kernel module and the userspace tools both compile against it. This page summarises it for format version **`0x0009`**.

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

That is the layout `mkfs.cetra` writes. A [grow](/docs/reference/growfs/) moves none of it. It adds new Block Group regions after the existing ones, and a **tail reserve** after those that holds a new segment of the Block Group table (see [below](#block-group-table-chain)). The Zone Group count never changes, so the Zone Group table and the pending-free queues never move either. A second grow places its regions after the first grow's tail reserve, so the Block Group data area can contain holes: it is a bounding box, `[bg_regions_start, bg_data_end)`, rather than one contiguous run.

## Superblock (block 0, 424 bytes)

| Field | Meaning |
|---|---|
| `magic` | `0xC4553770` |
| `version` | Format version (`0x0009`). This release also mounts, checks and grows `0x0008` volumes from 0.8.x; that window is temporary. Otherwise the version can change between beta releases and is never migrated. |
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
| `layout_gen` | Incremented by every grow; 0 on a volume never grown |
| `tail_reserve_start`, `tail_reserve_blocks` | Where the latest grow put its table segment; 0 if never grown |
| `orphan_blocks` | Blocks left unusable by past grows (superseded tail reserves); reported by `growfs.cetra` |
| `bg_data_end` | End of the Block Group data area; 0 if never grown, where the area is exactly `bg_regions_start + B × bg_size_blocks` |
| `bg_table_next`, `bg_table_first_count` | Block Group table chain: the first appended segment, and how many descriptors the original table holds; both 0 if never grown |
| `features_compat/_incompat/_ro_compat` | Feature bitmaps |
| `checksum` | CRC32C |
| `uuid` | Filesystem UUID |

## Zone Group descriptor (one block each)

The **hot sector** (first 512 bytes, changed by compare-and-write) holds `zg_id`, `owner_node_id` (registry row, or `0xFFFF` for none), `free_data_blocks` (the sum of its Block Groups' free counts), `hb_seq`, `hot_checksum`, and `pool_free_blocks`: the free space in **unowned** Block Groups assigned to this Zone Group's shard (`bg_id mod Z`), so that space handed back still counts as free. The **cold** part holds `cold_checksum`. Its `first_bg_id` and `bg_count` fields are no longer used: since `0x0009`, a Zone Group doesn't record its members, each Block Group records its owner.

## Block Group descriptor and region

The descriptor holds `bg_id`, `owner_zg` (the owning Zone Group, or `0xFFFF` when no Zone Group owns it), `start_block`, `length_blocks`, the offsets of the header, bitmap and data within the region, `data_block_count`, the cached `free_data_blocks`, `checksum`, and `reconcile_seq`. `reconcile_seq` advances whenever a change of Zone Group ownership rewrites the free count from the bitmap, so a late update from the previous owner is detected and dropped.

`owner_zg` changes while the cluster runs: a node claims an unowned Block Group, or hands an empty one back, with one compare-and-write on this record. `mkfs.cetra` assigns Block Group *b* to Zone Group *b* mod *Z*; a grow assigns the new ones the same way.

Block Groups no longer have to be adjacent: a grown volume has a hole where each earlier tail reserve was. They must not overlap, and each must lie inside the data area.

Each region:

```text
| header (1 block) | data bitmap (dbm blocks) | data blocks |
```

where `dbm = ceil((length_blocks − 1) / 32769)`. A 1 GiB Block Group (262,144 blocks) has 8 bitmap blocks and 262,135 data blocks.

### Block Group table chain

The original Block Group table, at `bg_table_start`, never moves, and holds `bg_table_first_count` descriptors. Each grow appends a **segment**: a header block followed by one descriptor block per added Block Group. The header (`magic` `0xC4553B65`, `count`, `first_bg_id`, `next`, `checksum`) fits in one sector, so linking a new segment is one compare-and-write on the previous segment's `next` (or on the superblock's `bg_table_next` for the first). A crash between writing a segment and linking it leaves an unreferenced segment, which nothing reads: the volume stays as it was before the grow.

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
| `caps` | Capabilities its module advertised at registration. Bit `0x1` (`NODE_CAP_LIVE_GROW`): the module understands a grown volume. A row from a module before 0.9 reads 0. |

## Per-node journal

Slice `node_journal_start + row × node_journal_blocks` belongs to registry row `row`. It holds a **flag block** (`state` CLEAN or DIRTY; `replay_owner`, claimed by compare-and-write) followed by two-block **slots**. A slot is a header block (`magic`, `txn_id`, `target_lba`, `payload_checksum`, the target's checksum before the change, flags such as `F_FRESH`, `header_checksum`) followed by a payload block holding the complete new contents of the target.

## Pending-free queue entry (16 bytes)

`{lba, count, magic}`: an extent freed by a node that doesn't own the Zone Group, waiting for the owner to apply it. Each Zone Group's queue is 256 blocks (1 MiB), room for 65,536 entries: enough to hold the frees from deleting a large, fragmented VM image.

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
extent index    16 bytes: logical range of the child [first, end), physical block of child
```

The tree is at most depth 2: the inode's 4 inline slots, then interior blocks, then leaf blocks. Arrays at every depth are **append-only and unordered**, so growing a file always edits a single block, and readers handle any order. Leaf and interior blocks end with a checksummed `{magic, crc}` tail. An extent marked *uninitialized* was preallocated and reads as zeroes until it is written.

Each index entry in an interior block records the range of logical blocks its child covers, so a lookup reads only the leaf that can hold the block instead of every leaf. The range only ever widens; an end of `0` means "unknown, read the child". Index entries in the inode's inline root carry no range.

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
