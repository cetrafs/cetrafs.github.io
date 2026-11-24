---
weight: 520
title: "Mount options"
description: "The cetrafs mount options, the read-only observer mode, the cluster-wide file-lock mode, discard, fcntl locks, what a stopped mount does, and remount rules."
toc: true
---

```text
mount -t cetrafs [-o OPTIONS] <dev> <mountpoint>
```

## Options

| Option | Effect |
|---|---|
| *(default)* | Read-write cluster participant. The cross-node **exclusive open lock** is on: while a node has a file open for writing, any open of that file from another node fails with `ETXTBSY`. `flock(2)` can suspend it for one file during a handoff. |
| `nofilelock` | Turns the automatic exclusive open lock off, so an image can be open on two nodes during a live-migration handoff. Also turns defragmentation off. Applies to the whole cluster; see [below](#the-file-lock-mode-applies-to-the-whole-cluster). |
| `ro` | Read-only **observer**. Registers and heartbeats, so peers don't reclaim files it is reading, and publishes read presence. Claims no Zone Group, replays no peer's journal, runs no defragmenter or scrubber, and writes nothing else. Like ext4 and XFS it still **recovers this node**: if the node went down with work outstanding, the mount replays its own journal and gives back what its previous run held. A write-protected device can't be mounted at all, because the mount writes its registry row. |
| `discard` | Give freed space back to the device as it is freed, in the background, batched. Off by default. See [Return free space to a thin LUN](/docs/how-tos/reclaim-thin-space/). |
| `nodiscard` | Send no UNMAP at all: neither the automatic one when a Block Group empties, which is on by default, nor `discard`. `fstrim` then answers "not supported". |
| `localposixlocks` | Grant `fcntl` byte-range locks on this node only, instead of refusing them. For a stock qemu's image locking. See [below](#fcntl-byte-range-locks). |
| `errors=stop` *(default)*, `errors=panic` | What the mount does when it no longer knows what is on the device: a metadata write the device refused, a compare-and-write whose outcome can't be decided, or what this node holds contradicting what it reads. `stop` [stops the mount](#what-a-stopped-mount-does). `panic` panics the machine, for a node a hardware watchdog reboots; it also panics on a fence, an expired lease and a lost device. There is no `continue`. |
| `corruption=isolate` *(default)*, `corruption=stop` | What damaged metadata does. `isolate` refuses every write to the file or directory it was found in (`EUCLEAN`, "Structure needs cleaning"), counts it in [`info`](/docs/reference/procfs/#state), marks the volume as needing `fsck`, and keeps the rest of the mount going. `stop` stops the mount. |

`noatime` is **always** in force; reads never update access times. Options that aren't the default are shown in `/proc/mounts`.

### Why damaged metadata doesn't stop the mount by default

The damaged block is on the shared device, and the read that found it refused it, so nothing has been built from it. Stopping this node would repair nothing: HA restarts the VM on another node, that node reads the same block and stops too, and so on until the whole cluster is down. Refusing writes to that one file is what matters, above all the writes that would free blocks on the strength of a damaged extent tree: unlink, truncate and hole punch. Reads of the rest of the file keep working.

The first node to find damage records it in the superblock, so every node reports `fsck_needed` in `info` and `dmesg` until a clean `fsck.cetra -r` clears it.

## The file-lock mode applies to the whole cluster

- The first read-write node to mount while no other node has the volume mounted (the *lead*) sets the mode.
- Nodes that mount later **inherit** the mode, whatever options they pass, unless they pass a **conflicting** one.
- A conflicting option (for example `nofilelock` when the cluster is locked) fails the mount with **`EINVAL`** and a log message.
- A read-only mount never sets the mode: it follows the one in force, or runs its own option without fixing it for the writers that come after.
- When every node has unmounted, the mode is forgotten.
- `/proc/fs/cetrafs/<dev>/info` shows the mode in effect as `file_lock: on|off`.

Under `nofilelock`, a node trusts its cached copy of a file's metadata only while it is the file's only opener, and checks that on the device at every open and at least once a second. While another node has the file open, every access reads the metadata fresh from the device. That is what keeps a migration handoff coherent, even after a snapshot rewrote the image's layout. The defragmenter still runs, for files no other node has open.

## `fcntl` byte-range locks

cetrafs has no cluster-wide `fcntl` locks, classic or OFD. A lock held by one node would be invisible to every other node, so what a lock call does depends on the mount:

| Mount | `fcntl` and OFD lock calls |
|---|---|
| Default | **Refused with `ENOLCK`** |
| Default with `localposixlocks` | Granted, on this node only |
| `nofilelock` | Granted, on this node only |

An unlock is always accepted, and `flock(2)` is unaffected: it is the cross-node lock in every mode.

On a default mount, cross-node exclusion is the filesystem's job, so a lock that would silently bind only one node is refused. Under `nofilelock`, exclusion is the job of the layer above, and a node-local lock is what that layer gets on any other filesystem.

Proxmox's qemu takes no such locks and needs neither option. A stock qemu with image locking on fails to open images on a default mount ("Failed to lock byte"): mount that node with `localposixlocks`, or run the cluster `nofilelock`. `localposixlocks` is per node and set at mount; a remount can't change it.

## What a stopped mount does

Every serious error ends in the state a crash leaves, because a crash is what the cluster is built and tested to recover from. A stopped mount:

- **writes nothing**, and throws away its dirty metadata instead of writing it back;
- **refuses every read** with `EIO`, cached pages included, because once a peer has taken over this node's files it may be writing them;
- **refuses `statfs`**, so `df` fails rather than reporting a frozen view;
- **stops renewing its heartbeat**, so after the stale window its peers replay its journal and take over its files, as after any crash;
- **unmounts normally**, writing nothing, and comes back only by unmounting and mounting again.

`info` shows `fenced: yes`, and `stopped:` gives the cause:

| `stopped:` | Cause |
|---|---|
| `fenced` | A peer revoked this node's lease. See [Fencing](/docs/concepts/fencing/). |
| `lease` | This node couldn't renew its heartbeat for the stale window less one heartbeat (105 s by default), so it stopped before its peers could take over |
| `error` | `errors=stop`, and a metadata write the device refused, or a compare-and-write that couldn't be decided |
| `corruption` | `corruption=stop`, and damaged metadata |
| `manual` | Someone [stopped it by hand](#stopping-a-mount-by-hand) |
| `device_gone` | The block device went away, or the LUN shrank below the volume |

## When the array runs out of space

A thin pool that fills up, or a snapshot whose copy-on-write has nowhere to go, doesn't stop the mount:

- **A write into space already allocated waits** for the array to have room, as with VMFS. `dmesg` says `has no space to overwrite ... waiting for it`, and `space_waits` in `info` counts it. Give the pool space, or delete a snapshot, and every waiting write completes on its own. The heartbeat keeps running throughout. If no space comes within `space_wait_secs` (default 300 seconds), the mount stops, as a crash would, and its peers recover from it.
- **A write that needs new space fails with `ENOSPC`**, which pauses a qemu guest.

The waiting processes sit in `D` state, and after two minutes the kernel's hung-task detector names them. That is expected here, and a reason not to run with `hung_task_panic=1`.

## Stopping a mount by hand

```sh
echo shutdown=now | sudo tee /proc/fs/cetrafs/<dev>/controls
sudo xfs_io -x -c shutdown /mnt/cetra      # the same, through FS_IOC_SHUTDOWN
```

This is the software fence a cluster manager uses before it reaches for power: the node stops writing and heartbeating, and its peers take over after the stale window. `FS_IOC_SHUTDOWN` needs `CAP_SYS_ADMIN`; its `DEFAULT` and `LOGFLUSH` modes sync the mount first, `NOLOGFLUSH` stops at once.

## Remount rules

| Change | Allowed? |
|---|---|
| `remount,ro` / `remount,rw` | **Refused.** Unmount and mount again. |
| Changing `nofilelock`, `localposixlocks`, `errors=` or `corruption=` | Not changed. A remount that states them logs that it didn't change them. |

A second mount of a device this node already has mounted shares the first mount. If it states a `nofilelock`, `errors=` or `corruption=` setting the first mount doesn't have, it is refused instead of silently getting the first mount's settings.

## Mount failures

| Error | Cause |
|---|---|
| `EBUSY` | The device has no atomic CAW and another live node already has it mounted; or a repair or grow holds the volume. |
| `EINVAL` | Another format version or an unknown incompatible feature; the file-lock mode conflicts with the cluster; or the region map failed validation. `dmesg` says which. |
| Refused, with "CAW discovery failed" in `dmesg` | cetrafs couldn't determine whether the device supports compare-and-write, so it won't guess. |
| Refused, block 0 doesn't verify | Something overwrote the superblock. `dmesg` says whether the copy at block 2048 is good. See [Recover a damaged superblock](/docs/how-tos/recover-node-failure/#the-mount-says-block-0-doesnt-verify). |
| Read-only mount when read-write was asked for | An unknown read-only-compatible feature bit is set on the volume. |
| Refused on a kernel with 16 KiB or 64 KiB pages | The kernel's page must be one 4 KiB block. |
| Killed by systemd after 90 s | A mount can legitimately wait minutes after a crash. See [Mount at boot](/docs/how-tos/mount-volume/#mount-at-boot-with-etcfstab). |

## Using `flock(2)`

`LOCK_EX` and `LOCK_UN` need a descriptor **open for writing** (`exec 9>>`, not `9<`), or `CAP_SYS_ADMIN`; anything else gets `EBADF`. This `flock` is a mandatory, cluster-wide lock: without that rule, any user who could read an image could lock every other node out of it.

Under `nofilelock`, `flock` claims the lock:

| Call | Result |
|---|---|
| `flock(fd, LOCK_EX)` | Claims the cross-node exclusive lock. No other node can open the file while it is held. A blocking call waits for a peer that has the file open for reading. |
| `flock(fd, LOCK_UN)` or closing all duplicates of the fd | Releases it. `LOCK_UN` returns `EIO` if the release didn't reach the device, and the fd keeps the lock: check the result and retry. |
| `flock(fd, LOCK_SH)` | `EOPNOTSUPP`: only exclusive locks exist |

On a default mount, `flock` suspends and resumes the automatic lock of a file this node has open for writing. See [handing one file's lock over](/docs/concepts/locking/#handing-one-files-lock-over-on-a-default-mount).

| Call | Result |
|---|---|
| `flock(fd, LOCK_UN)` | Makes the file durable, then suspends this node's lock on it. Another node can open it. Success, doing nothing, if this node isn't writing the file. |
| `flock(fd, LOCK_EX)` | Takes a suspended lock back. Never from another node: `EWOULDBLOCK` with `LOCK_NB` while a peer holds it, otherwise it waits. Success if the lock was never suspended. `EOPNOTSUPP` if this node doesn't have the file open for writing. |
| `flock(fd, LOCK_SH)` | `EOPNOTSUPP`: only exclusive locks exist |
| Closing the last writer | Ends the suspension |
