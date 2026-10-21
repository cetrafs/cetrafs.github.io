---
weight: 420
title: "Locking model"
description: "Whole-file exclusive locks instead of byte-range locks, per-inode namespace locks, read presence, nofilelock for live migration, and flock."
toc: true
---

## Whole files, not byte ranges

POSIX cluster filesystems coordinate access down to byte ranges and keep every node's page cache coherent. That is powerful, and it is where distributed lock managers become expensive: locks bounce between hosts, and contention on shared directories piles up.

cetrafs makes a narrower promise, the same one VMFS makes: **one node at a time may have a file open for writing.** A VM disk image has one writer, the host running the VM, so that is all the workload needs.

## The whole-file exclusive open lock

Every inode record carries two lock fields: the row of the node holding the lock, and the lock mode.

- When a node opens an unlocked file **for writing**, it claims the lock with compare-and-write.
- **Any** open from another node, for reading or writing, fails with **`ETXTBSY`** while the lock is held.
- The lock is released when the **last** local writer on the holding node closes the file. Two processes on the same node writing the same file share the claim, and no peer can slip in between their two closes.
- A lock held by a **stale** node doesn't block anyone. The next writer to open the file reclaims it.

Within the holding node, cetrafs adds nothing on top of normal VFS and page-cache behaviour. Two local processes writing overlapping ranges get the same semantics as on any local filesystem.

## Read presence

When a node opens a file for **reading**, it sets its bit in the file's 64-bit **read-presence mask**, and clears it when its last reader closes. Unlink and rename consult the mask, so a node can't destroy a file that another live node is still reading.

The mask has one bit per Node Registry row, which is why a cluster has at most 64 nodes.

## The per-inode namespace lock

Changes to the namespace (create, mkdir, unlink, rmdir, rename, link, symlink) read a directory block, decide what to change, and write it back. If two nodes did that to the same directory at the same time, one change would be lost. So each operation runs under a **namespace lock**, kept in the inode records themselves and claimed by compare-and-write.

The lock covers **exactly the records the operation changes**:

| Operation | Records locked |
|---|---|
| create, mkdir, symlink | the parent directory (the new inode can't be seen by anyone yet) |
| unlink, rmdir, link | the parent and the target |
| rename | both parents, the moved inode, and any target it replaces |

Locking only the parent wouldn't be enough. Two nodes unlinking two hardlinks of the same file, through different parents, would both update that file's link count. Locks are always taken in ascending inode-number order, so two operations can't deadlock.

Unrelated directories never wait for each other. A held lock left behind by a dead node is reclaimed the usual way: replay the dead node's journal, then take the lock.

## Deleting a file someone else has open

Unlink, and a rename that replaces its target, check the target's lock **before** freeing anything. If a live node holds the target's write lock, the operation fails with `ETXTBSY`. Without that check, node B could free blocks node A is still writing into, and those blocks could then be handed to a different file.

The check only applies when data would actually be freed. Removing one of several hardlinks, or renaming without replacing anything, never touches the data and is never blocked.

## `nofilelock`: live migration

The exclusive lock rules out one important operation, **live migration**. During the handoff qemu has the image open on the source and the destination at once, and the destination's open fails with `ETXTBSY`.

Mounting with `nofilelock` turns the automatic lock off. Each open then claims nothing and is never refused. In exchange:

- **The layer above prevents double writes.** Proxmox HA and qemu's own image locking take over that guarantee. VMFS and vSphere divide the work the same way.
- **File metadata is read fresh on every access.** With no lock guaranteeing that a cached copy is current, cetrafs re-reads a file's extent tree and inode record from the device each time, as it always does for directories. That is what makes the **sequential** handoff coherent, even after a snapshot on the source has rewritten the image's layout. Without it, the destination could keep using a stale block map and send guest writes to the wrong blocks. The cost is extra device reads on the data path.
- **Simultaneous writers are still unsafe.** `nofilelock` makes the handoff from one writer to the next correct. It does not make two writers at the same moment correct.
- **The defragmenter is off**, because it relies on the lock.

### Why the mode applies to the whole cluster

If some nodes enforced the lock and others ignored it, the result would be inconsistent. The first node to mount (while nobody else has the volume mounted) sets the mode, everyone after it inherits it, and a node asking for the other mode is refused. When the last node unmounts, the mode is forgotten.

### Taking the lock back with `flock`

Under `nofilelock` a process can still claim the same exclusive cross-node lock on one file, using the standard `flock(2)` call. A migration hook can hold the lock during normal operation and release it only for the handoff window. Exclusive locks only (`LOCK_SH` isn't supported). The lock belongs to the open file description, so closing the file releases it, and a dead holder is cleared by the normal stale reclaim.

## A remaining limit: readers that were already open

The write lock refuses any *new* open from another node. A node that opened a file for reading **before** another node took the write lock keeps its open file, though, and its cached copy of the file's **contents** isn't refreshed on every access. It won't see the new writes until it reopens the file. This is the same "no close-to-open consistency" trade-off most network filesystems make, and it doesn't weaken any of the mechanisms above.
