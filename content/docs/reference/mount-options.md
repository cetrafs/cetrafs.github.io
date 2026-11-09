---
weight: 520
title: "Mount options"
description: "The cetrafs mount options, the read-only observer mode, the cluster-wide file-lock mode, and remount rules."
toc: true
---

```text
mount -t cetrafs [-o OPTIONS] <dev> <mountpoint>
```

## Options

| Option | Effect |
|---|---|
| *(default)* | Read-write cluster participant. The cross-node **exclusive open lock** is on: while a node has a file open for writing, any open of that file from another node fails with `ETXTBSY`. `flock(2)` can suspend it for one file during a handoff. |
| `nofilelock` | Turns the automatic exclusive open lock off, so an image can be open on two nodes during a live-migration handoff. File metadata is then read fresh from the device on every access. The defragmenter is disabled. Per-file locking is still available through `flock(2)`. Applies to the whole cluster; see below. |
| `ro` | Read-only **observer**. Registers and heartbeats, so peers don't reclaim files it is reading, and publishes read presence. Claims no Zone Group, replays no peer's journal, runs no defragmenter or scrubber, and writes nothing else. Like ext4 and XFS, since 0.9.4 it still **recovers this node**: if the node went down with work outstanding, the mount replays its own journal and gives back the claims and Zone Groups its previous run held. A read-only *device* can't be mounted at all, because the mount writes its registry row. |
| `errors=stop` *(default)*, `errors=panic` | What the mount does when it no longer knows what is on the device: a metadata write the device refused, a compare-and-write whose outcome can't be decided, or what this node holds contradicting what it reads. `stop` [stops the mount](#what-a-stopped-mount-does), `panic` panics the machine, for a node a hardware watchdog reboots. There is no `continue`. Since 0.9.4. |
| `corruption=isolate` *(default)*, `corruption=stop` | What damaged metadata does. `isolate` refuses every write to the file or directory it was found in (`EUCLEAN`, "Structure needs cleaning"), counts it as `corruptions` in [`info`](/docs/reference/procfs/#state), and keeps the rest of the mount going. `stop` stops the mount. Since 0.9.4. |

`noatime` is **always** in force; reads never update access times.

`errors=` and `corruption=` are shown in `/proc/mounts` when they aren't the default.

### Why damaged metadata doesn't stop the mount by default

The damaged block is on the shared device, and the read that found it refused it, so nothing has been built from it. Stopping this node would repair nothing: HA restarts the VM on another node, that node reads the same block and stops too, and so on until the whole cluster is down. Refusing writes to that one file is what matters, above all the writes that would free blocks on the strength of a damaged extent tree: unlink, truncate and hole punch. Reads of the rest of the file keep working.

## What a stopped mount does

Since 0.9.4 every serious error ends in the state a crash leaves, because a crash is what the cluster is built and tested to recover from. A stopped mount:

- **writes nothing**, and throws away its dirty metadata instead of writing it back;
- **refuses every read** with `EIO`, cached pages included, because once a peer has taken over this node's files it may be writing them;
- **refuses `statfs`** since 0.9.5, so `df` fails rather than reporting a frozen view;
- **stops renewing its heartbeat**, so after the stale window its peers replay its journal and take over its files, as after any crash;
- **unmounts normally**, writing nothing, and comes back only by unmounting and mounting again.

`info` shows `fenced: yes`, and `stopped:` gives the cause:

| `stopped:` | Cause |
|---|---|
| `fenced` | A peer revoked this node's lease. See [Fencing](/docs/concepts/fencing/). |
| `lease` | This node couldn't renew its heartbeat for three intervals |
| `error` | `errors=stop`, and a metadata write the device refused, or a compare-and-write that couldn't be decided |
| `corruption` | `corruption=stop`, and damaged metadata |
| `manual` | Someone [stopped it by hand](#stopping-a-mount-by-hand) |
| `device_gone` | The block device went away |

## Stopping a mount by hand

```sh
echo shutdown=now | sudo tee /proc/fs/cetrafs/<dev>/controls
sudo xfs_io -x -c shutdown /mnt/cetra      # the same, through FS_IOC_SHUTDOWN
```

This is the software fence a cluster manager uses before it reaches for power: the node stops writing and heartbeating, and its peers take over after the stale window. `FS_IOC_SHUTDOWN` needs `CAP_SYS_ADMIN`; its `DEFAULT` and `LOGFLUSH` modes sync the mount first, `NOLOGFLUSH` stops at once.

## The file-lock mode applies to the whole cluster

- The first node to mount while no other node has the volume mounted (the *lead*) sets the mode.
- Nodes that mount later **inherit** the mode, whatever options they pass, unless they pass a **conflicting** one.
- A conflicting option (for example `nofilelock` when the cluster is locked) fails the mount with **`EINVAL`** and a log message.
- When every node has unmounted, the mode is forgotten.
- `/proc/fs/cetrafs/<dev>/info` shows the mode in effect as `file_lock: on|off`.

## Remount rules

| Change | Allowed? |
|---|---|
| `remount,ro` / `remount,rw` | **Refused.** Unmount and mount again. |
| Adding or removing `nofilelock`, or changing `errors=` or `corruption=` | **Refused.** Unmount and mount again. Since 0.9.4 a remount that states `errors=` or `corruption=` logs that it didn't change them. |

A second mount of a device this node already has mounted shares the first mount. Since 0.9.4, if it states a `nofilelock`, `errors=` or `corruption=` setting the first mount doesn't have, it is refused instead of silently getting the first mount's settings.

## Mount failures

| Error | Cause |
|---|---|
| `EBUSY` | The device has no atomic CAW and another live node already has it mounted. |
| `EINVAL` | Format version or incompatible feature not understood; file-lock mode conflicts with the cluster; or the region map failed validation. `dmesg` says which. |
| Refused, with "CAW discovery failed" in `dmesg` | cetrafs couldn't determine whether the device supports compare-and-write, so it won't guess. |
| Read-only mount when read-write was asked for | An unknown *read-only-compatible* feature bit is set on the volume. |
| Refused on an arm64 kernel with 16 KiB or 64 KiB pages | Since 0.9.4 the kernel's page must be one 4 KiB block. |
| Killed by systemd after 90 s | A mount can legitimately wait minutes after a crash. See [Mount at boot](/docs/how-tos/mount-volume/#mount-at-boot-with-etcfstab). |

## Using `flock(2)`

Since 0.9.5 `LOCK_EX` and `LOCK_UN` need a descriptor **open for writing** (`exec 9>>`, not `9<`), or `CAP_SYS_ADMIN`; anything else gets `EBADF`. This `flock` is a mandatory, cluster-wide lock: without that rule, any user who could read an image could lock every other node out of it, or suspend the lock under a running VM's writes.

Under `nofilelock`, `flock` claims the lock:

| Call | Result |
|---|---|
| `flock(fd, LOCK_EX)` | Claims the cross-node exclusive lock. No other node can open the file while it is held. |
| `flock(fd, LOCK_UN)` or closing all duplicates of the fd | Releases it. Since 0.9.4 `LOCK_UN` returns `EIO` if the release didn't reach the device, and the fd keeps the lock: check the result and retry. A close never fails this way; the heartbeat finishes a release a close couldn't make. |
| `flock(fd, LOCK_SH)` | `EOPNOTSUPP`: only exclusive locks exist |

On a default mount, since 0.8.2, `flock` suspends and resumes the automatic lock of a file this node has open for writing. See [handing one file's lock over](/docs/concepts/locking/#handing-one-files-lock-over-on-a-default-mount).

| Call | Result |
|---|---|
| `flock(fd, LOCK_UN)` | Makes the file durable, then suspends this node's lock on it. Another node can open it. Success, doing nothing, if this node isn't writing the file. `EBUSY` while the defragmenter is moving it. |
| `flock(fd, LOCK_EX)` | Takes a suspended lock back. Never from another node: `EWOULDBLOCK` with `LOCK_NB` while a peer holds it, otherwise it waits. Success if the lock was never suspended. `EOPNOTSUPP` if this node doesn't have the file open for writing. |
| `flock(fd, LOCK_SH)` | `EOPNOTSUPP`: only exclusive locks exist |
| Closing the last writer | Ends the suspension |
