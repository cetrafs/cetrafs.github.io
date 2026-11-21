---
weight: 540
title: "On-disk format"
description: "The cetrafs on-disk layout, format 0x000A: superblock and its copy, Zone and Block Group descriptors, Node Registry, journals, inodes, extents, directory entries and feature flags."
toc: true
---

The authoritative specification is `include/cetrafs.h` in the source tree. The kernel module and the userspace tools both compile against it. This page summarises it for format version **`0x000A`**.

## Conventions

- Block size is fixed at **4096 bytes**. All offsets are block numbers (LBAs).
- Every multi-byte field is **little-endian**.
- Structures are byte-packed, with no padding added by the compiler.
- Checksums are **CRC32C**, computed as `~crc32c(~0, buf)` over the structure with its own checksum field zeroed, and stored as a little-endian 64-bit value.
- A record that nodes update by compare-and-write keeps everything that changes, and the checksum covering it, inside one **512-byte sector**, the unit the array compares and writes atomically.
- Every such sector carries a **stamp** that every compare-and-write moves to a value no swap wrote before, so a sector never returns to an earlier image. A swap whose command timed out is judged by the stamp a re-read finds.

## Layout

`Z` = Zone Group count, `B` = Block Group count, `N` = Node Registry capacity.

```text
LBA 0                 Superblock
LBA 1 .. 2047         left empty
LBA 2048              Copy of the superblock
...                   Zone Group table          (1 block per Zone Group)
...                   Block Group table         (1 block per Block Group)
...                   Inode bitmap
...                   Inode table               (1 inode per block)
...                   Node Registry             (144-byte rows, packed)
...                   Pending-free queues       (512 blocks per Zone Group)
...                   Per-node journals         (N areas)
bg_regions_start      Block Group regions 1 .. B
```

Every region start is a superblock field. The mount checks the whole map: every region starts after block 0, nothing wraps, everything fits inside the volume, no regions overlap, and every count fits its region.

That is the layout `mkfs.cetra` writes. A [grow](/docs/reference/growfs/) moves none of it. It adds Block Group regions after the existing ones, and a **tail reserve** after those that holds new segments of the Block Group and inode tables (see [below](#table-chains)). The Block Group data area can therefore contain holes: it is the range `[bg_regions_start, bg_data_end)`, not one contiguous run.

## Superblock (block 0, 424 bytes)

| Field | Meaning |
|---|---|
| `magic` | `0xC4553770` |
| `version` | Format version, `0x000A`. The only one this release mounts. |
| `sb_bytes` | Size of the superblock structure, as a sanity check |
| `block_size` | 4096 |
| `total_blocks` | Volume size in blocks |
| `zone_group_count`, `block_group_count` | Z, B |
| `zg_table_start`, `bg_table_start` | Descriptor tables |
| `inode_bmap_start/_blocks`, `inode_table_start/_blocks` | The first segment of the inode bitmap and table |
| `inode_size`, `inodes_count` | On-disk inode size; total inodes, across every segment |
| `inode_seg_next`, `inode_first_count` | Inode table chain: the first appended segment, and the inodes in the first one; both 0 if never grown |
| `bg_regions_start` | First Block Group region |
| `root_ino` | Root directory inode (1) |
| `bg_size_blocks` | Block Group size |
| `data_align_blocks` | Data alignment (`mkfs -A`). Every Block Group starts on a multiple of it, and so does its data region. |
| `node_table_start/_blocks/_count`, `node_entry_size` | Node Registry location and capacity |
| `pending_free_start`, `pending_free_blocks_per_zg` | Pending-free queues |
| `node_journal_start`, `node_journal_blocks` | Per-node journal area, and size per node: 0 (no journal), or 17 blocks (8 slots) up to 4 Mi blocks |
| `layout_gen` | Incremented by every grow; 0 on a volume never grown |
| `tail_reserve_start`, `tail_reserve_blocks` | Where the latest grow put its table segments; 0 if never grown |
| `orphan_blocks` | Blocks left unusable by past grows (superseded tail reserves) |
| `bg_data_end` | End of the Block Group data area; 0 if never grown |
| `bg_table_next`, `bg_table_first_count` | Block Group table chain: the first appended segment, and the descriptors in the original table; both 0 if never grown |
| `zg_seg_next`, `zg_first_count` | Reserved for a Zone Group table chain. No release appends one yet, and a volume that has one is refused. |
| `fsck_needed_since`, `fsck_needed_node` | The lasting "needs fsck" mark: when, and by which registry row, damaged metadata was first found at runtime; 0 for none. Set once by compare-and-write, cleared by a clean `fsck.cetra -r`. |
| `cluster_id` | Reserved; written as 0 |
| `features_compat/_incompat/_ro_compat` | Feature bitmaps |
| `checksum` | CRC32C |
| `uuid` | Volume UUID |

### The superblock copy

A copy of block 0 lives at the fixed block 2048 (8 MiB in): past what a partition tool, a disk label or a stray `dd` at the start of the disk reaches, and at a place no grow moves. It carries the layout only; its `fsck_needed_*` fields are always zero. `mkfs.cetra` writes it before block 0 and `growfs.cetra` after; the kernel never writes it and never mounts from it.

A mount whose block 0 doesn't verify is refused, with a message saying whether the copy is good. `fsck.cetra` checks the volume through the copy, and `-r` restores block 0 from it. A copy that is missing or describes another layout doesn't stop the mount; `info` reports it as `sb_copy: stale` or `bad`.

## Zone Group descriptor (one block each)

The **hot sector** (first 512 bytes, changed by compare-and-write) holds `zg_id`, `owner_node_id` (registry row, or `0xFFFF` for none), `free_data_blocks` (the sum of its Block Groups' free counts), `hb_seq`, `pool_free_blocks`, its stamp and `hot_checksum`. `pool_free_blocks` is the free space in **unowned** Block Groups assigned to this Zone Group's shard (`bg_id` mod `zg_first_count`), so space handed back still counts as free.

`pool_grow_gen`, `pool_grow_id` and `pool_grow_credit` name the live grow whose credit `pool_free_blocks` holds, so the credit of a grow that died before it published can be taken back. The cold part holds `cold_checksum`; a Zone Group doesn't record its members, each Block Group records its owner.

## Block Group descriptor and region

The descriptor holds `bg_id`, `owner_zg` (the owning Zone Group, or `0xFFFF` when none owns it), `start_block`, `length_blocks`, the offsets of the bitmap and data within the region, `data_block_count`, the cached `free_data_blocks`, `flags`, `free_gen`, `reconcile_seq` and `checksum`.

- `owner_zg` changes while the cluster runs: a node claims an unowned Block Group, or hands an empty one back, with one compare-and-write on this record.
- `reconcile_seq` advances whenever a change of ownership recounts the free count from the bitmap, so a late update from the previous owner is detected and dropped.
- `free_gen` is raised before the scrubber reclaims a leak in the group. A pending-free entry carries the value it was queued under and is applied only while it is current.
- `flags`: `DISCARDED` (in the pool, already unmapped) and `DISCARD_PENDING` (its UNMAP has an unknown outcome; nobody allocates from it until that is settled).

Each region:

```text
| header (1 block) | alignment gap | data bitmap (dbm blocks) | data blocks |
```

The **header** records the group's geometry and nothing else: `bg_id`, the bitmap and data offsets, `length_blocks`, `data_block_count`, `checksum`. It is written once, by `mkfs.cetra` or `growfs.cetra`, and is what `fsck.cetra -r` rebuilds a damaged descriptor from.

The **bitmap** is a sequence of 512-byte sectors, each holding 3,968 bits and a 16-byte trailer with that sector's checksum and stamp, so a sector's bits and their checksum always land together. `dbm = ceil((length_blocks − 1) / 31745)`. The data region starts at the first multiple of `data_align_blocks` past the header and bitmap, and any gap goes between the header and the bitmap. A default 1 GiB Block Group (262,144 blocks) with the default 1 MiB alignment has 9 bitmap blocks at offset 247 and 261,888 data blocks from offset 256.

Block Groups needn't be adjacent: a grown volume has a hole where each earlier tail reserve was. They must not overlap, and each must lie inside the data area.

## Table chains

The original Block Group table, at `bg_table_start`, never moves. Each grow appends a **segment**: a header block followed by one descriptor block per added Block Group. The header (`magic`, `count`, `first_bg_id`, `next`, `checksum`) fits in one sector, so linking a new segment is one compare-and-write on the previous segment's `next`, or on the superblock's `bg_table_next` for the first.

The inode table grows the same way. A segment is a header, its own bitmap and its records, linked from `inode_seg_next` or the previous segment, and inode numbers carry on where the table ended. A volume has at most 1024 inode table segments.

A crash between writing a segment and linking it leaves an unreferenced segment, which nothing reads. A live grow links its segments, then publishes the superblock, so the chain can be one segment past the count; mount and `fsck.cetra` accept exactly that state, and the next grow replaces the segment.

## Node Registry row (144 bytes)

| Field | Meaning |
|---|---|
| `node_uuid[16]` | Stable machine UUID |
| `state` | `FREE` (0), `REGISTERED` (1), or `REPAIR` (2): held by `growfs.cetra` or an offline `fsck.cetra -r`, so no node mounts while it works |
| `hb_seq` | Heartbeat counter. Liveness is judged by watching it move. |
| `last_seen` | Unix seconds of the last heartbeat, informational |
| `label[32]` | Hostname, informational |
| `incarnation` | Random and nonzero, drawn afresh at every registration and re-attach. Every claim the node stamps carries it, so a claim from an earlier mount of the same node can be told apart. |
| `departure` | Why a registered row isn't beating: `NONE` (mounted, or crashed with no verdict yet), `CLEAN` (it unmounted and said so) or `DEAD` (a peer fenced it, or an HA agent declared it dead) |
| `fence_epoch` | The node's lease. Incremented by whoever takes over its resources; the node stops when it changes. |
| `fenced_by`, `fence_reason`, `fenced_at` | Who last fenced the row, why and when, stamped by the same compare-and-write, so the fenced node's log can name its fencer |
| `hb_interval_secs`, `stale_secs` | The node's own heartbeat rate and stale window, so peers and the tools judge it by its own settings |
| `caps` | Capabilities its module advertised. Bit `0x1`: live grow. |
| `frees_inflight`, `frees_seq` | Set, and the sequence raised, before a publish that drops blocks the node then frees. A scrub skips its cycle while a live row is set, or a sequence moved during it. |
| `checksum` | CRC32C |

## Per-node journal

Area `node_journal_start + row × node_journal_blocks` belongs to registry row `row`. It holds a **flag block** followed by two-block **slots**.

The flag block holds `state` (CLEAN or DIRTY; any other value reads as DIRTY), `replay_owner` and `replay_incarnation` (claimed by compare-and-write, so exactly one node replays a dead peer's area), and `park_seq`, which counts the times the area was parked clean.

A slot is a header block (`magic`, `txn_id`, `target_lba`, the session's `park_seq`, the **owner** inode and its generation, `payload_checksum`, the target's checksum before the change, flags such as `F_FRESH`, `header_checksum`) followed by a payload block holding the complete new contents of the target. Replay redoes an entry only while its owner inode still references the target, and discards an entry from before the area's last park.

## Pending-free queue entry (32 bytes)

`{lba, count, magic, free_gen}`: an extent freed by a node that doesn't own the Zone Group, waiting for the owner to apply it. Each 512-byte sector holds 15 entries and a trailer with the sector's stamp. Each Zone Group's queue is 512 blocks (2 MiB), room for 61,440 entries.

## Inode (one per 4 KiB block)

A record is two 512-byte sectors at the start of its own block, each with its own checksum, so the two kinds of change never overwrite each other:

| Sector | Owned by | Fields |
|---|---|---|
| 0: namespace | Changed only by compare-and-write | `ino`, `mode`, `uid`, `gid`, `nlink`, `ctime`, `crtime`, `flags`, `xattr_block`, `xattr_seq`, the file lock (`lock_owner_node`, `lock_mode`, `lock_owner_incarnation`), the namespace lock (`ns_lock_owner`, `ns_lock_incarnation`), read presence (`read_open_nodes` and an incarnation per bit), `write_open_nodes`, `suspended_writer_nodes`, `dirent_seq`, `generation` |
| 1: file data | The node writing the file | `size`, `blocks`, `atime`, `mtime`, the extent-tree root, `file_seq` |

Times are signed nanoseconds since the epoch; `crtime` is the birth time, written once. `generation` is stamped at allocation and detects inode-number reuse across nodes. `read_open_nodes` is a 64-bit mask, one bit per registry row. `file_seq` moves with every change to the file's extent map, so a node caching the tree can tell a peer changed it.

## Extents

```text
extent header   12 bytes: magic, entries, max, depth, generation
extent          16 bytes: logical block (48-bit), length (31-bit + uninitialized flag), physical block
extent index    16 bytes: the child's logical range (48-bit start, 32-bit span), physical block of the child
```

The tree is at most **depth 3**: the inode's 4 inline slots, two levels of interior blocks, then leaf blocks, for 4 × 254³ ≈ 65.5 million extents. Arrays at every depth are **append-only and unordered**, so growing a file edits a single block and readers handle any order. Leaf and interior blocks end with a checksummed `{magic, crc}` tail. An extent marked *uninitialized* was preallocated and reads as zeroes until it is written.

Each index entry in an interior block records the logical range its child covers, so a lookup reads only the children that can hold the block. A span of `0` means "unknown, read the child". Index entries in the inode's inline root carry no range.

## Directory entry (266 bytes, fixed size)

`inode (u64) + name_len (u16) + file_type (u8) + name[255]`. 15 entries fit in a block, and each block ends with a checksummed `{magic, crc}` tail. Directories use the same extent trees as files, up to depth 3 and at most 2<sup>18</sup> blocks.

## Extended attribute entry (322 bytes)

`key[64] + value_len (u16) + value[256]`, packed into one block per inode (about 12 entries) with a checksummed tail. `key` holds the full name including its namespace; an empty key marks a free slot.

## Feature flags

| Flag | Bit | Set by mkfs |
|---|---|---|
| `INCOMPAT_EXTENTS` | 0 | yes |
| `INCOMPAT_GLOBAL_ITBL` | 1 | yes |
| `INCOMPAT_BIT2_UNUSED` | 2 | no (formerly the SCSI PR backend) |
| `INCOMPAT_NODE_REGISTRY` | 3 | yes |
| `INCOMPAT_CAS_STAMP` | 4 | yes; required at mount |
| `INCOMPAT_ZG_CHAIN` | 5 | no; reserved, and refused |
| `ROCOMPAT_SPARSE` | 0 | no |

What a build understands is one definition, checked the same way by the module, `fsck.cetra`, `growfs.cetra` and `mkfs.cetra`:

| An unknown bit of class | Mount | `fsck.cetra` | `fsck.cetra -r`, `growfs.cetra`, live grow |
|---|---|---|---|
| INCOMPAT | Refused, read-only too | Refused | Refused |
| RO_COMPAT | Read-only only | Warns, checks | Refused, nothing written |
| COMPAT | Ignored | Warns, checks | Refused, nothing written |

A later format change can be a new feature bit instead of a version bump wherever an older build can be told what to do with it.
