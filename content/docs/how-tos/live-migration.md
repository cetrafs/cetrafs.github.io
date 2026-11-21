---
weight: 340
title: "Live migration on Proxmox VE"
linkTitle: "Live migration on Proxmox"
description: "Why Proxmox VE needs the nofilelock mount option for live migration, how to set it, what it costs, and why we think Proxmox's approach to image locking is wrong."
toc: true
---

By default cetrafs takes a cross-node **exclusive lock** on every file opened for writing. Any other node that tries to open the file gets `ETXTBSY`. Proxmox VE's live migration starts qemu on the target with the VM's disk images open, while the source is still running the guest, so on a default mount it fails:

```text
Could not open '/mnt/cetra/images/100/vm-100-disk-0.raw': Text file busy
```

Cold (offline) migration works either way, because the source closes the image before the target opens it.

On Proxmox the answer today is to mount with `nofilelock`. The [storage plugin](/docs/how-tos/proxmox-plugin/) does it for you. If you mount by hand, read on. The rest of this page explains what you give up, and why we think Proxmox shouldn't make you. For the design that keeps the lock, see [Live migration without `nofilelock`](/docs/how-tos/live-migration-handover/).

## Mount with `nofilelock`

Use the same option on every node:

```fstab
/dev/disk/by-id/dm-name-mpatha  /mnt/cetra  cetrafs  nofilelock,_netdev,nofail  0  0
```

How the mode works:

- **It applies to the whole cluster.** The first node to mount, while no other node has the volume mounted, sets the mode. Every node that mounts later inherits it.
- **Conflicts are refused.** A node that asks for `nofilelock` when the cluster is locked, or the other way round, fails to mount with `EINVAL` instead of joining in the wrong mode.
- **It is set at mount time only.** A remount can't change it.
- **A read-only mount never sets it.** An observer that mounts first follows its own option without fixing the mode for the writers that come after it.
- When every node has unmounted, the mode is forgotten and the next node to mount sets it again.

Strictly, only the first node to mount needs the option. Putting it everywhere keeps the cluster consistent whatever order the nodes boot in.

Check it:

```sh
sudo grep file_lock /proc/fs/cetrafs/*/info      # file_lock: off
```

## What `nofilelock` costs

Under `nofilelock`, cetrafs no longer stops two nodes from writing the same image at once. **Only Proxmox keeps writers apart**: a VM's configuration belongs to one node, and HA fences a failed node before restarting its VMs. That stops Proxmox from starting a VM twice. It doesn't stop anything else: a `qemu-img` or `dd` run on the wrong node, a backup agent, a script, an operator mistake, or a bug in the cluster layer itself. Any of them can write into a running VM's disk, and nothing at the storage level will object.

What cetrafs still guarantees is a coherent **sequential handoff**. Under `nofilelock` a node trusts its cached copy of a file's metadata only while it is the file's only opener, and while another node has the file open it reads the extent tree and inode record fresh on every access. When the target takes over, it sees the source's final state, even if a snapshot rewrote the image's layout just before the migration. Two writers *at the same moment* are still unsafe; cetrafs makes such an overlap visible where it touches the extent tree, but it can't make it correct.

Other things that change on a `nofilelock` mount:

- `fcntl` byte-range locks are granted on each node, instead of refused. They don't reach other nodes.
- The defragmenter keeps running, for files no other node has open.
- Opening an image whose last writer crashed replays that node's journal first. Until the node is stale, the open fails with `EAGAIN`; an HA agent can [declare a powered-off host dead](/docs/how-tos/recover-node-failure/#declare-a-fenced-host-dead) to skip the wait.

## Why Proxmox needs it: image locking is turned off

qemu has image locking designed for exactly this case. For each permission it holds, such as writing, it locks one byte of the image. The target of a live migration opens the image without the write permission, and the write lock passes from source to target at the switchover. A second qemu that tries to write the same image is refused.

**Proxmox VE switches it off.** Its qemu build has carried a patch since 2020 that changes the default for image locking to `off` ([the patch on pve-devel](https://lists.proxmox.com/pipermail/pve-devel/2020-March/042124.html)). The reason given was that qemu's `auto` mode checked whether the *system* supports the locks, not whether the *storage* does, and it broke on NFS. The patch is still there in Proxmox VE 9.2: a running VM holds no lock at all on its disk images, on any storage.

We think this is the wrong call, for three reasons:

- **It removed a safety net everywhere to fix a probe in one place.** The bug was in how `auto` detected lock support on NFS. The fix was to stop locking on every storage, local disks included, and it has stayed that way for six years.
- **It makes the cluster layer the only guard.** Proxmox's configuration ownership and HA fencing are good at what they do, but they only see what Proxmox does. Storage-level locking exists precisely for the writers the hypervisor doesn't know about.
- **It pushes the same choice onto every storage.** Proxmox's migration opens the image on the target while the source still writes it, and assumes the storage won't object. A storage that protects its files has to switch the protection off to work with it. That is why cetrafs has `nofilelock`: not because live migration needs it, but because Proxmox's way of migrating does.

Turning qemu's locking back on wouldn't fix this on cetrafs either. qemu takes `fcntl` byte-range locks, and cetrafs has no cluster-wide ones: a default mount refuses them with `ENOLCK`, and under `nofilelock` they are granted on one node only.

`nofilelock` removes all protection, from every file, on every node, for as long as the volume is mounted, to allow an operation that touches one file and lasts a few seconds. Use it because Proxmox needs it today. [Live migration without `nofilelock`](/docs/how-tos/live-migration-handover/) shows how it should be done, and what Proxmox would have to change to do it.

## Take the lock back for one file (optional)

`nofilelock` turns off the *automatic* lock, not the lock itself. A process can claim the same exclusive cross-node lock on a single file with `flock(2)`, or with the `flock(1)` command from a shell or a hookscript:

```sh
exec 9>>/mnt/cetra/images/vm-100-disk-0.raw     # >> opens for writing without truncating
flock -x 9      # hold the lock during normal operation

# before a live migration, open the handoff window:
flock -u 9 || exit 1   # the other node may now open the image; on failure the lock is still held

# once the migration completes:
flock -x 9
```

While a node holds this lock, no other node can open the file at all, for reading or writing. The lock belongs to the open file description, so `flock -u`, or closing the descriptor and all its duplicates, releases it. `flock -u` fails with `EIO` if the release didn't reach the device, and the lock is then still held: don't start the migration until it succeeds. If the holder crashes, the normal stale-node reclaim clears the lock.

This protects only against writers that also ask for the lock; everything else still gets in. Only exclusive locks exist (`LOCK_SH` isn't supported). Open the image with `>>`, never `>`: `>` truncates it to zero.

## Related

- [Live migration without `nofilelock`](/docs/how-tos/live-migration-handover/)
- [Locking model](/docs/concepts/locking/)
- [Build a Proxmox VE shared datastore](/docs/tutorials/proxmox-datastore/)
