---
weight: 420
title: "Locking model"
description: "Whole-file exclusive locks instead of byte-range locks, per-inode namespace locks, read presence, nofilelock for live migration on Proxmox VE, flock, and handing one file's lock over on a default mount."
toc: true
---

## Whole files, not byte ranges

POSIX cluster filesystems coordinate access down to byte ranges and keep every node's page cache coherent. That is powerful, and it is where distributed lock managers become expensive: locks bounce between hosts, and contention on shared directories piles up.

cetrafs makes a narrower promise, the same one VMFS makes: **one node at a time may have a file open for writing.** A VM disk image has one writer, the host running the VM, so that is all the workload needs.

## The whole-file exclusive open lock

Every inode record carries two lock fields: the row of the node holding the lock, and the lock mode.

- When a node opens an unlocked file **for writing**, it claims the lock with compare-and-write.
- **Any** open from another node, for reading or writing, fails with **`ETXTBSY`** while the lock is held.
- Since 0.9.3 the rule works both ways: an open **for writing** also fails with `ETXTBSY` while another live node has the file open for reading. A file has one writer and nobody else, or readers and no writer. Both checks happen inside the same compare-and-write that takes the lock or records the reader, so two opens racing on two nodes can't both get in.
- The lock is released when the **last** local writer on the holding node closes the file. Two processes on the same node writing the same file share the claim, and no peer can slip in between their two closes.
- A lock held by a **stale** node doesn't block anyone. The next writer to open the file reclaims it.

Within the holding node, cetrafs adds nothing on top of normal VFS and page-cache behaviour. Two local processes writing overlapping ranges get the same semantics as on any local filesystem.

## Read presence

When a node opens a file for **reading**, it sets its bit in the file's 64-bit **read-presence mask**, and clears it when its last reader closes. On a default mount a write-open on another node consults the mask, and on every mount so do unlink, rename, truncate, hole punch and the defragmenter, so a node can't change the layout of a file that another live node is still reading, or destroy it. A bit left by a dead node is cleared first and blocks nothing.

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

Since 0.9.2 a hole punch is held to the same rule as truncate: punching a hole in a file another live node has open fails with `ETXTBSY`, also on a `nofilelock` mount, and works again once that node has closed it. Before, a punch on one node could hand blocks back to the allocator while a peer was still writing into them.

The check only applies when data would actually be freed. Removing one of several hardlinks, or renaming without replacing anything, never touches the data and is never blocked.

## `nofilelock`: live migration

The exclusive lock rules out one important operation, **live migration**. During the handoff qemu has the image open on the source and the destination at once, and the destination's open fails with `ETXTBSY`.

Mounting with `nofilelock` turns the automatic lock off. Each open then claims nothing and is never refused. In exchange:

- **Only the layer above keeps writers apart.** On Proxmox VE that is the cluster layer alone: a VM's configuration belongs to one node, and HA fences a failed node before restarting its VMs elsewhere. qemu's own image locking plays no part, as the next section explains.
- **File metadata is read fresh on every access.** With no lock guaranteeing that a cached copy is current, cetrafs re-reads a file's extent tree and inode record from the device each time, as it always does for directories. That is what makes the **sequential** handoff coherent, even after a snapshot on the source has rewritten the image's layout. Without it, the destination could keep using a stale block map and send guest writes to the wrong blocks. The cost is extra device reads on the data path.
- **Simultaneous writers are still unsafe.** `nofilelock` makes the handoff from one writer to the next correct. It does not make two writers at the same moment correct.
- **The defragmenter is off**, because it relies on the lock.

### Why `nofilelock` exists: Proxmox turns image locking off

qemu has its own image locking, designed for exactly this handoff. For each permission it holds, such as writing, it locks one byte of the image. The destination of a live migration opens the image without the write permission, so it takes no write lock, and the write lock passes from source to destination at the switchover. Exactly one node holds it at every moment.

**Proxmox VE switches it off.** Its qemu build has carried a patch since 2020 that changes the default for image locking to `off` ([the patch on pve-devel](https://lists.proxmox.com/pipermail/pve-devel/2020-March/042124.html)). The stated reason was that qemu's `auto` mode checked whether the *system* supports the locks, not whether the *storage* does, and it broke on NFS. The patch is still there in Proxmox VE 9.2: a running VM holds no lock at all on its disk images.

So in a Proxmox cluster nothing at the image level stops two nodes from writing the same disk. The cluster layer stops Proxmox itself from starting a VM twice, but nothing stops a second writer that comes from outside it: a `dd` or `qemu-img` run on the wrong node, a backup agent, a script, or a bug.

Turning qemu's locking back on would not fix this on cetrafs, either. qemu takes `fcntl` byte-range locks, and cetrafs keeps those local to each node: only `flock(2)` locks are cluster-wide.

That left cetrafs with two choices for Proxmox: keep its own lock and refuse live migration, or give the lock up. **`nofilelock` was added so that live migration on Proxmox works at all.** It lines cetrafs up with Proxmox's permissive posture rather than keeping its own protection.

We think that is the wrong trade. `nofilelock` removes all protection, from every file, on every node, for as long as the volume is mounted, to allow an operation that affects one file and lasts a few seconds. Use it because Proxmox needs it today, not because it is a sound design.

### The fix: a `flock` locking mode in qemu

The proper fix is small and lives in qemu. qemu's permission system already knows the right moment to take and release the write lock during a migration. What's missing is a way to make it use a lock that cetrafs shares between nodes. A new `locking=flock` mode for qemu's file driver would do it:

- taking the write permission calls `flock(LOCK_EX)` on the image;
- giving it up calls `flock(LOCK_UN)`.

Proxmox would carry that qemu patch alongside its own, and the storage would ask for `locking=flock` on cetrafs volumes. The lock would then follow the VM across a live migration, with exactly one node holding it at any moment, and a writer from outside qemu would be refused.

This is a proposal: neither qemu nor Proxmox has it yet. Until then, Proxmox clusters mount with `nofilelock`.

cetrafs already has its side of it. Since 0.8.2, a default mount can [hand one file's lock over](#handing-one-files-lock-over-on-a-default-mount) with `flock(LOCK_UN)` and take it back with `flock(LOCK_EX)`. Together with qemu's `flock` mode, that makes `nofilelock` unnecessary: every file stays locked, except the image being migrated, and only during its own handoff.

### Why the mode applies to the whole cluster

If some nodes enforced the lock and others ignored it, the result would be inconsistent. The first node to mount (while nobody else has the volume mounted) sets the mode, everyone after it inherits it, and a node asking for the other mode is refused. When the last node unmounts, the mode is forgotten.

### Taking the lock back with `flock` under `nofilelock`

Under `nofilelock` a process can still claim the same exclusive cross-node lock on one file, using the standard `flock(2)` call. A migration hook can hold the lock during normal operation and release it only for the handoff window. Exclusive locks only (`LOCK_SH` isn't supported). The lock belongs to the open file description, so closing the file releases it, and a dead holder is cleared by the normal stale reclaim. Since 0.9.3 that includes a `LOCK_EX` already waiting when the holder dies: it fences the dead node, replays its journal and takes the lock. Before, it waited forever, which is what a migration hook would have done if the source host died mid-handoff.

## Handing one file's lock over on a default mount

Since 0.8.2, the same two calls work on a default mount, the other way round: every file is locked, and you unlock one file for as long as a handoff needs. On a file this node has open for writing:

- **`flock(LOCK_UN)` suspends this node's lock on the file**, with the file still open. cetrafs first makes the file durable, as a close would: data, extent tree, allocation bitmaps and inode record are on the device before the lock goes. Another node can then open the file for writing, and its write-open takes the lock. Since 0.9.3 this node is recorded as a writer handing over, not as a reader, so the destination's write-open gets in while opens for reading stay refused until the handoff is done.
- **`flock(LOCK_EX)` takes the lock back.** It never takes it from another node, even a dead one: if a peer holds it, `LOCK_EX|LOCK_NB` fails with `EWOULDBLOCK`, and a blocking `LOCK_EX` waits until the peer lets go. Once it has the lock again, cetrafs drops its cached view of the file and reads it fresh, so it sees what the other node wrote.

Every other file stays locked the whole time. It is the same on-disk lock a write-open takes, so there is no format change.

While a file's lock is suspended, cetrafs treats it exactly as a file on a `nofilelock` mount:

- This node stays visible to the others as a user of the file, so another node can't delete it, rename over it, link it, truncate it, change its owner or mode, or set an extended attribute on it. Those fail with `ETXTBSY`, as they would if the lock were still held.
- This node reads the file's metadata fresh from the device, because another node may now be changing it.
- The defragmenter leaves the file alone, and suspending a file the defragmenter is moving fails with `EBUSY`.

The details:

- **The suspension belongs to the file and the node, not to the descriptor.** Any descriptor this node has open for writing suspends or resumes the same lock. A new write-open on this node doesn't take the lock back; only `flock(LOCK_EX)` does.
- **Closing the last writer ends the suspension.** There is no lock left to release.
- **Calls that change nothing succeed.** `LOCK_UN` on a file this node isn't writing, or one already suspended, does nothing. `LOCK_EX` on a file whose lock was never suspended returns success, because this node already holds the lock. Only `LOCK_EX` on a file this node doesn't have open for writing returns `EOPNOTSUPP`: there is no automatic lock to take back.
- **`LOCK_UN` is a real handover.** Since 0.9.4 this node's own writes to the file fail with `ETXTBSY` while its lock is suspended: `write`, `O_DIRECT`, truncate and `fallocate` alike, and a store through a mapping gets `SIGBUS`. The handoff never has two writers. Before 0.9.4 writes weren't checked against the lock, and a node could keep writing after another had taken the file. Whatever drives the handoff must still handle a failed `LOCK_EX`; qemu's permission system does, a script has to do it itself.
- **`LOCK_UN` can fail.** Since 0.9.4 it returns `EIO` if the release didn't reach the device, and the descriptor keeps the lock. Check the result: a hook that ignores it and starts the migration sees the destination's open fail with `ETXTBSY`.

`/proc/fs/cetrafs/<dev>/info` counts suspensions and resumptions as `lock_suspends` and `lock_resumes`. A gap between them that keeps growing means something unlocks files and never takes them back.

## What a reader sees

Before 0.9.3 a node could open a file for reading, another node could then open it for writing, and the reader kept a stale view of the file's contents until it reopened it. The rule above closes that on a default mount: a reader never shares a file with a writer on another node.

So a reader trusts its cached view of the file, checking once a second whether the file has changed since. That covers the cases the rule doesn't: a `nofilelock` mount, where another node may write, and a writer that finished and closed before this node opened the file. Even there, nothing a reader is reading through can be freed under it: truncate, hole punch, unlink, rename over the file and defragmentation all refuse while a live peer has it open.
