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
| *(default)* | Read-write cluster participant. The cross-node **exclusive open lock** is on: while a node has a file open for writing, any open of that file from another node fails with `ETXTBSY`. |
| `nofilelock` | Turns the automatic exclusive open lock off, so an image can be open on two nodes during a live-migration handoff. File metadata is then read fresh from the device on every access. The defragmenter is disabled. Per-file locking is still available through `flock(2)`. Applies to the whole cluster; see below. |
| `ro` | Read-only **observer**. Registers and heartbeats, so peers don't reclaim files it is reading, and publishes read presence. Claims no Zone Group, replays no journal, runs no defragmenter or scrubber, and writes nothing else. |

`noatime` is **always** in force; reads never update access times.

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
| Adding or removing `nofilelock` | **Refused.** Unmount and mount again. |

## Mount failures

| Error | Cause |
|---|---|
| `EBUSY` | The device has no atomic CAW and another live node already has it mounted. |
| `EINVAL` | Format version or incompatible feature not understood; file-lock mode conflicts with the cluster; or the region map failed validation. `dmesg` says which. |
| Refused, with "CAW discovery failed" in `dmesg` | cetrafs couldn't determine whether the device supports compare-and-write, so it won't guess. |
| Read-only mount when read-write was asked for | An unknown *read-only-compatible* feature bit is set on the volume. |

## Using `flock(2)` under `nofilelock`

| Call | Result |
|---|---|
| `flock(fd, LOCK_EX)` | Claims the cross-node exclusive lock. No other node can open the file while it is held. |
| `flock(fd, LOCK_UN)` or closing all duplicates of the fd | Releases it |
| `flock(fd, LOCK_SH)` | `EOPNOTSUPP`: only exclusive locks exist |
| Any `flock` on a default (locked) mount | `EOPNOTSUPP`: the lock is already automatic |
