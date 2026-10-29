---
weight: 340
title: "Enable live migration"
description: "Mount with nofilelock so qemu can open a VM image on two nodes during an online-migration handoff, and take the lock back per file with flock when you need it."
toc: true
---

By default cetrafs takes a cross-node **exclusive lock** on every file opened for writing. Any other node that tries to open the file gets `ETXTBSY`. That protects a running VM's disk, but it also blocks **live (online) migration**: the destination must open the image while the source still has it open, and the migration fails with:

```text
Could not open '/mnt/cetra/images/100/vm-100-disk-0.raw': Text file busy
```

Cold (offline) migration works either way, because the source closes the image before the destination opens it.

## Mount with `nofilelock`

Use the same option on every node:

```fstab
/dev/mapper/mpatha  /mnt/cetra  cetrafs  nofilelock,_netdev,nofail  0  0
```

How the mode works:

- **It applies to the whole cluster.** The first node to mount, while no other node has the volume mounted, sets the mode. Every node that mounts later inherits it.
- **Conflicts are refused.** A node that asks for `nofilelock` when the cluster is locked, or the other way round, fails to mount with `EINVAL` instead of joining in the wrong mode.
- **It is set at mount time only.** A remount can't change it.
- **It disables the defragmenter** on that mount, because the defragmenter relies on the lock to be safe.
- When every node has unmounted, the mode is forgotten and the next node to mount sets it again.

Strictly, only the first node to mount needs the option. Putting it everywhere keeps the cluster consistent whatever order the nodes boot in.

Check it:

```sh
grep file_lock /proc/fs/cetrafs/*/info      # file_lock: off
```

## Who prevents double writes?

Under `nofilelock`, cetrafs no longer stops two nodes from writing the same image at once. **Only the layer above keeps writers apart.** On Proxmox VE that is the cluster layer alone: a VM's configuration belongs to one node, and HA fences a failed node before restarting its VMs. qemu's own image locking doesn't help: Proxmox turns it off, and its locks wouldn't reach other nodes on cetrafs anyway. Nothing stops a writer from outside Proxmox, such as a `dd` or `qemu-img` on the wrong node. See [why `nofilelock` exists](/docs/concepts/locking/#why-nofilelock-exists-proxmox-turns-image-locking-off). Don't use `nofilelock` with a workload that has nothing above it to keep writers apart.

What cetrafs still guarantees is a coherent **sequential handoff**. Under `nofilelock` it reads each file's metadata (its extent tree and inode record) fresh from the device on every access. When the destination takes over, it sees the source's final state, even if a snapshot rewrote the image's layout just before the migration. The cost is extra metadata reads on the data path.

## Take the lock back for one file (optional)

`nofilelock` turns off the *automatic* lock, not the lock itself. A process can claim the same exclusive cross-node lock on a single file with the standard `flock(2)` call, or with the `flock(1)` command from a shell or a migration hook:

```sh
exec 9>>/mnt/cetra/images/vm-100-disk-0.raw     # >> opens for writing without truncating
flock -x 9      # hold the lock during normal operation

# before a live migration, open the handoff window:
flock -u 9      # the other node may now open the image

# once the migration completes:
flock -x 9
```

While a node holds this lock, no other node can open the file at all, for reading or writing. The lock belongs to the open file description, so `flock -u`, or closing the descriptor and all its duplicates, releases it. If the holder crashes, the normal stale-node reclaim clears the lock.

Notes:

- Only exclusive locks exist. `LOCK_SH` isn't supported.
- Open the image with `>>`, never `>`: `>` truncates it to zero.

## Hand over one file on a default mount

Since 0.8.2, the same `flock -u` and `flock -x` also work on a default mount, where every file is locked. `flock -u` suspends this node's lock on that one image, and `flock -x` takes it back; every other file stays locked. It is the safer building block, but Proxmox can't use it yet: qemu would have to take and release the lock at the switchover, and neither qemu nor Proxmox does that today. Until it does, live migration on Proxmox needs `nofilelock`. See [handing one file's lock over](/docs/concepts/locking/#handing-one-files-lock-over-on-a-default-mount) for what a suspended lock still protects, and [the qemu fix](/docs/concepts/locking/#the-fix-a-flock-locking-mode-in-qemu).

## Related

- [Locking model](/docs/concepts/locking/)
- [Build a Proxmox VE shared datastore](/docs/tutorials/proxmox-datastore/)
