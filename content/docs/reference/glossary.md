---
weight: 550
title: "Glossary"
description: "Definitions of the terms used in the cetrafs docs, from ATS and COMPARE AND WRITE to extents, fence epochs, Zone Groups and the Node Registry."
toc: false
---

ATS
: *Atomic Test and Set.* VMware's name for SCSI COMPARE AND WRITE, the primitive VMFS uses for on-disk locking. The same primitive cetrafs uses.

Block Group (BG)
: A self-contained data region: a header block, a data bitmap, and data blocks. 1 GiB by default. Each belongs to one Zone Group, or to none: an unowned Block Group is free for any node to claim.

CAW / COMPARE AND WRITE
: SCSI command `0x89`. The array compares a block with an expected image and, only if they match, writes a new image, all as one atomic step. A mismatch returns MISCOMPARE. The only cross-node mutual-exclusion primitive in cetrafs.

CAS
: Compare-and-swap: the general operation that CAW provides on the storage. cetrafs uses "a CAS" to mean one claim made this way.

Extent
: A run of contiguous 4 KiB blocks belonging to one file, recorded as *(first logical block, length, first physical block)*. An extent never crosses a Block Group boundary and can cover up to 8 TiB. Extents allocated by `fallocate` but not yet written are flagged *uninitialized* and read back as zeros. A file's extents live in an ext4-style **extent tree**: up to 4 inline in the inode, then in external leaf and index blocks, at most depth 2. See [On-disk format](/docs/reference/on-disk-format/).

Fence epoch
: A counter in each Node Registry row that serves as the node's lease. The node taking over a dead peer's resources increments it, and the peer fences itself when it sees the change.

Fenced
: The state of a mount whose lease was revoked. Every write fails with `EIO` until it is unmounted and mounted again.

File lock
: The whole-file, cross-node exclusive lock taken when a file is opened for writing (default mounts) or with `flock(2)` (under `nofilelock`). On a default mount, `flock(LOCK_UN)` can suspend it for one file: see *Lock suspension*.

Heartbeat
: Each node's periodic renewal of its Node Registry row (every 15 s by default).

Lead node
: The first node to mount a volume while nobody else has it mounted. It sets the cluster-wide file-lock mode.

Lock suspension
: On a default mount, `flock(LOCK_UN)` on a file this node is writing gives up this node's file lock for that file while it stays open, so another node can take the file over; `flock(LOCK_EX)` takes it back. See [Locking](/docs/concepts/locking/#handing-one-files-lock-over-on-a-default-mount).

Namespace lock
: A per-inode cross-node lock held for the duration of one namespace operation, covering only the records it changes.

Node Registry
: The on-disk table of nodes, one row per node, keyed by the node's stable machine UUID.

`nofilelock`
: A mount option that turns off the automatic file lock for the whole cluster, so live migration can work.

Observer
: A read-only (`-o ro`) mount. It registers and heartbeats, but claims nothing and writes nothing else.

Pending-free queue
: A per-Zone-Group queue where other nodes put frees of blocks in that Zone Group, for its owner to apply.

Read presence
: A 64-bit mask in each inode recording which nodes have the file open for reading.

Replay guard
: The check that stops journal replay from rolling back a block another node has rewritten since.

Scrubber
: The background task that finds and reclaims leaked blocks (marked allocated, referenced by nothing).

Stale / stale window
: A node whose heartbeat has been silent for `stale_secs` (120 s by default) is stale, presumed dead, and its resources can be taken over.

STONITH
: *Shoot The Other Node In The Head.* Fencing a host by powering it off, done by a cluster manager. Required for production multi-node cetrafs, and not done by cetrafs itself.

Zone Group (ZG)
: A set of Block Groups with at most one owner node. A node allocates only from the Block Groups of the Zone Groups it owns. Since 0.9 each Block Group records which Zone Group owns it, so membership changes over the volume's life.
