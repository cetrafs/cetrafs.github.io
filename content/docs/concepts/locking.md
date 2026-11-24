---
weight: 420
title: "Locking model"
description: "Whole-file exclusive locks instead of byte-range locks, per-inode namespace locks, read presence, nofilelock for live migration on Proxmox VE, flock and fcntl, and live migration on a default mount by handing one file's lock over."
toc: true
---

## Whole files, not byte ranges

POSIX cluster filesystems coordinate access down to byte ranges and keep every node's page cache coherent. That is powerful, and it is where distributed lock managers become expensive: locks bounce between hosts, and contention on shared directories piles up.

cetrafs makes a narrower promise, the same one VMFS makes: **one node at a time may have a file open for writing.** A VM disk image has one writer, the host running the VM, so that is all the workload needs.

## The whole-file exclusive open lock

Every inode record carries two lock fields: the row of the node holding the lock, and the lock mode.

- When a node opens an unlocked file **for writing**, it claims the lock with compare-and-write.
- **Any** open from another node, for reading or writing, fails with **`ETXTBSY`** while the lock is held.
- The rule works both ways: an open **for writing** also fails with `ETXTBSY` while another live node has the file open for reading. A file has one writer and nobody else, or readers and no writer. Both checks happen inside the same compare-and-write that takes the lock or records the reader, so two opens racing on two nodes can't both get in.
- The lock is released when the **last** local writer on the holding node closes the file. Two processes on the same node writing the same file share the claim, and no peer can slip in between their two closes.
- A lock held by a **stale** node doesn't block anyone. The next writer to open the file reclaims it.

Within the holding node, cetrafs adds nothing on top of normal VFS and page-cache behaviour. Two local processes writing overlapping ranges get the same semantics as on any local filesystem.

## Read presence

When a node opens a file, it sets its bit in the file's 64-bit **presence mask**, and clears it when its last opener closes. On a default mount a write-open on another node consults the mask, and on every mount so do unlink, rename, truncate, preallocation and the defragmenter, so a node can't free blocks of a file that another live node still has open, or destroy it. A bit left by a dead node is cleared once that node's journal has been replayed, and then blocks nothing.

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

Unrelated directories never wait for each other. A lock left behind by a dead node is reclaimed the usual way: replay the dead node's journal, take the lock, and recount the records it covered. An operation that finds the lock held by a node that has gone silent waits, killable, until that node goes stale; if the holder is alive and still beating, it fails with `EBUSY` after about 12 s.

## Deleting a file someone else has open

Unlink, and a rename that replaces its target, check the target's lock **before** freeing anything. If a live node holds the target's write lock, the operation fails with `ETXTBSY`. Without that check, node B could free blocks node A is still writing into, and those blocks could then be handed to a different file.

A hole punch or `ZERO_RANGE` on a file another live node has open frees nothing: it zeroes the range in place with WRITE ZEROES, which is what a write would do, and succeeds. A punch that freed blocks could hand them back to the allocator while the peer was still writing into them. Where the device has no WRITE ZEROES, or the other node holds the file's lock, the punch is refused with `EOPNOTSUPP`, and qemu falls back to writing zeroes itself.

The check only applies when data would actually be freed. Removing one of several hardlinks, or renaming without replacing anything, never touches the data and is never blocked.

## `nofilelock`: live migration

The exclusive lock gets in the way of **live migration** as Proxmox VE does it. The destination's qemu opens the image when it starts, while the source still has it open, and that open fails with `ETXTBSY`. A management layer that hands the lock over can migrate on a default mount instead; see [Live migration without `nofilelock`](/docs/how-tos/live-migration-handover/).

Mounting with `nofilelock` turns the automatic lock off. Each open then claims nothing and is never refused. In exchange:

- **Only the layer above keeps writers apart.** On Proxmox VE that is the cluster layer alone: a VM's configuration belongs to one node, and HA fences a failed node before restarting its VMs elsewhere. qemu's own image locking plays no part, because Proxmox turns it off.
- **File metadata is trusted only while this node is the only opener.** With no lock guaranteeing that a cached copy is current, a node checks on the device, at every open and at least once a second, whether another node has the file open. While one does, every access reads the extent tree and inode record fresh, and a change the other node published drops the cached tree. That is what makes the **sequential** handoff coherent, even after a snapshot on the source has rewritten the image's layout. The cost is extra device reads while two nodes have the image open, which during a migration is a few seconds.
- **Simultaneous writers are still unsafe.** `nofilelock` makes the handoff from one writer to the next correct. It does not make two writers at the same moment correct. What cetrafs does guarantee is that such an overlap isn't silent where it touches the extent tree: of two overlapping tree updates, one is dropped or the file is marked damaged.
- **Defragmentation is off.** Its pin is the file lock, and without it nothing keeps the defragmenter away from an image qemu is filling.

### Proxmox, and the alternative

`nofilelock` exists because Proxmox VE turns qemu's image locking off and has the target qemu open the images while the source still writes them. A storage that keeps its lock can't take part in that. [Live migration on Proxmox VE](/docs/how-tos/live-migration/) explains the background, and why we think it is the wrong trade.

Live migration itself doesn't need `nofilelock`. A management layer can [hand each disk's lock over](#handing-one-files-lock-over-on-a-default-mount) from source to target around qemu's migration, on a default mount, with every file still protected. [Live migration without `nofilelock`](/docs/how-tos/live-migration-handover/) describes how.

## Handing one file's lock over on a default mount

The same two calls work on a default mount, the other way round: every file is locked, and you unlock one file for as long as a handoff needs. On a file this node has open for writing:

- **`flock(LOCK_UN)` suspends this node's lock on the file**, with the file still open. cetrafs first makes the file durable, as a close would: data, extent tree, allocation bitmaps and inode record are on the device before the lock goes. Another node can then open the file for writing, and its write-open takes the lock. This node is recorded as a writer handing over, not as a reader, so the destination's write-open gets in while opens for reading stay refused until the handoff is done.
- **`flock(LOCK_EX)` takes the lock back.** It never takes it from another node, even a dead one: if a peer holds it, `LOCK_EX|LOCK_NB` fails with `EWOULDBLOCK`, and a blocking `LOCK_EX` waits until the peer lets go. Once it has the lock again, cetrafs drops its cached view of the file and reads it fresh, so it sees what the other node wrote.

Every other file stays locked the whole time. It is the same on-disk lock a write-open takes, so there is no format change.

While a file's lock is suspended, cetrafs treats it exactly as a file on a `nofilelock` mount:

- This node stays visible to the others as a user of the file, so another node can't delete it, rename over it, link it, truncate it, change its owner or mode, or set an extended attribute on it. Those fail with `ETXTBSY`, as they would if the lock were still held.
- This node reads the file's metadata fresh from the device, because another node may now be changing it.
- The defragmenter leaves the file alone. Suspending a file the defragmenter is moving stops the pass at its next step.

The details:

- **The suspension belongs to the file and the node, not to the descriptor.** Any descriptor this node has open for writing suspends or resumes the same lock. A new write-open on this node doesn't take the lock back; only `flock(LOCK_EX)` does.
- **Closing the last writer ends the suspension.** There is no lock left to release.
- **Calls that change nothing succeed.** `LOCK_UN` on a file this node isn't writing, or one already suspended, does nothing. `LOCK_EX` on a file whose lock was never suspended returns success, because this node already holds the lock. Only `LOCK_EX` on a file this node doesn't have open for writing returns `EOPNOTSUPP`: there is no automatic lock to take back.
- **`LOCK_UN` is a real handover.** This node's own writes to the file fail with `ETXTBSY` while its lock is suspended: `write`, `O_DIRECT`, truncate and `fallocate` alike, and a store through a mapping gets `SIGBUS`. The handoff never has two writers. Whatever drives the handoff must still handle a failed `LOCK_EX`; qemu's permission system does, a script has to do it itself.
- **`LOCK_UN` can fail.** It returns `EIO` if the release didn't reach the device, and the descriptor keeps the lock. Check the result: a hook that ignores it and starts the migration sees the destination's open fail with `ETXTBSY`.

`LOCK_EX` and `LOCK_UN` need a descriptor **open for writing** (`exec 9>>`, not `9<`), or `CAP_SYS_ADMIN`; anything else gets `EBADF`.

`/proc/fs/cetrafs/<dev>/info` counts suspensions and resumptions as `lock_suspends` and `lock_resumes`. A gap between them that keeps growing means something unlocks files and never takes them back.

## What a reader sees

On a default mount a reader never shares a file with a writer on another node, so it can trust its cached view of the file. It still checks once a second whether the file has changed, which covers the cases that rule doesn't: a `nofilelock` mount, where another node may write, and a writer that finished and closed before this node opened the file. Even there, nothing a reader is reading through can be freed under it: truncate, hole punch, unlink, rename over the file and defragmentation all keep their hands off blocks while a live peer has the file open.
