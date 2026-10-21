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

Under `nofilelock`, cetrafs no longer stops two nodes from writing the same image at once. **Proxmox HA and qemu's own image locking take on that job**, just as vSphere HA does on top of VMFS. Don't use `nofilelock` with a workload that has nothing above it to keep writers apart.

What cetrafs still guarantees is a coherent **sequential handoff**. Under `nofilelock` it reads each file's metadata (its extent tree and inode record) fresh from the device on every access. When the destination takes over, it sees the source's final state, even if a snapshot rewrote the image's layout just before the migration. The cost is extra metadata reads on the data path.

## Take the lock back for one file (optional)

`nofilelock` turns off the *automatic* lock, not the lock itself. A process can claim the same exclusive cross-node lock on a single file with the standard `flock(2)` call, or with the `flock(1)` command from a shell or a migration hook:

```sh
exec 9>/mnt/cetra/images/vm-100-disk-0.raw
flock -x 9      # hold the lock during normal operation

# before a live migration, open the handoff window:
flock -u 9      # the other node may now open the image

# once the migration completes:
flock -x 9
```

While a node holds this lock, no other node can open the file at all, for reading or writing. The lock belongs to the open file description, so `flock -u`, or closing the descriptor and all its duplicates, releases it. If the holder crashes, the normal stale-node reclaim clears the lock.

Notes:

- Only exclusive locks exist. `LOCK_SH` isn't supported.
- `flock` returns `EOPNOTSUPP` on a default (locked) mount, where the lock is already automatic.

## Related

- [Locking model](/docs/concepts/locking/)
- [Build a Proxmox VE shared datastore](/docs/tutorials/proxmox-datastore/)
