---
weight: 535
title: "Limits and unsupported operations"
description: "Hard limits of the on-disk format, operations cetrafs deliberately does not support, and the requirements a deployment must meet."
toc: true
---

## Deployment requirements

| Requirement | Consequence if missing |
|---|---|
| Atomic SCSI COMPARE AND WRITE (ATS, opcode `0x89`) on the LUN, for more than one node | Volume is single-node only; a second mount fails with `EBUSY` |
| An external cluster manager with host fencing (STONITH), for production multi-node use | A node that stalls but stays alive can keep writing after its peers have taken over (split-brain). Without one, run single-node. |
| Same cetrafs build on every node, and tools matching the module | Not supported; a mismatched `fsck` can misread the format |
| Supported kernel: `7.0.14`, `7.1.8+deb13`, Proxmox `7.0.14-*-pve` | Untested; may not build or load |
| Little-endian host (amd64, arm64); one architecture per cluster | Untested |

## Hard limits

These are limits of the on-disk format. Raising any of them needs a new format version.

| Limit | Value | Why |
|---|---|---|
| Nodes per volume | **64** | The per-inode read-presence mask is 64 bits |
| File size | **16 TiB** | 32-bit logical block number × 4 KiB. Also capped at the volume size. |
| Single extent | 8 TiB | 31-bit extent length |
| Extent tree depth | 2 (about 344,000 extents) | |
| Zone Groups | **255** | |
| Block size | **4 KiB**, fixed | |
| Minimum Block Group size | 512 MiB | |
| Inodes | Fixed at mkfs time; default 1 per 4 MiB, capped at 65,536 | 32-bit count; one inode per 4 KiB block |
| Filename length | 255 bytes | |
| Extended attributes | One 4 KiB block per inode, about 12 attributes; name ≤ 64 bytes, value ≤ 256 bytes | |
| Volume span | **One block device** | No spanned or multi-extent volumes |

## Unsupported operations

Each returns a clean error. None of them silently does the wrong thing.

| Operation | Result | Notes |
|---|---|---|
| Special files (`mknod`: device nodes, FIFOs, sockets) | Not created | An on-disk record with such a mode is refused at load with `EUCLEAN` |
| POSIX ACLs (`setfacl`, `system.posix_acl_*`) | Not supported | Same choice as VMFS. SELinux works through `security.*` xattrs. |
| Cluster-wide byte-range locks (`fcntl F_SETLK`) | Local only | Byte-range locks work within one node and aren't visible to other nodes. Design around the whole-file lock. |
| `flock(LOCK_SH)` | `EOPNOTSUPP` | Exclusive-only |
| `flock` on a default (locked) mount | `EOPNOTSUPP` | The lock is already automatic |
| `rename` with `RENAME_EXCHANGE` or `RENAME_WHITEOUT` | `EINVAL` | `RENAME_NOREPLACE` and plain rename are supported |
| `fallocate` modes other than allocate (mode `0` / `KEEP_SIZE`) and `PUNCH_HOLE \| KEEP_SIZE` | `EOPNOTSUPP` | e.g. `ZERO_RANGE`, `COLLAPSE_RANGE` |
| `O_TMPFILE` | Not supported | |
| `chattr` / `FS_IOC_SETFLAGS` (immutable, append-only, nodump) | Not supported | |
| Hardlink to a directory | `EPERM` | A directory has exactly one parent |
| Remounting `ro` ↔ `rw`, or changing `nofilelock` | Refused | Unmount and mount again |
| Formats from other versions | Refused at mount | No in-place migration before 1.0 |

## Supported (sometimes asked)

- Regular files, directories, symlinks, hardlinks.
- `user.*`, `trusted.*` (listed only to `CAP_SYS_ADMIN`) and `security.*` extended attributes. cetrafs can serve as an overlayfs layer.
- `O_DIRECT`, `mmap`, `fsync`, truncate in both directions, `fallocate` (allocate, punch hole).
- `SEEK_HOLE` / `SEEK_DATA` and `FS_IOC_FIEMAP`, so `filefrag`, `cp --sparse`, `tar -S` and `qemu-img convert` see holes.
- Live `statfs` free-space and free-inode counts.
- qemu `cache=none`, `writeback` and `writethrough`.

## Operational characteristics

- **Metadata operations are synchronous** and cost real device round trips (create ~400 ms on a typical iSCSI LUN). Data throughput isn't affected. See [Performance model](/docs/concepts/performance/).
- **Crash consistency is per `fsync`, not per syscall.** Expect fsck to repair a small remnant after an unclean shutdown. See [Journaling](/docs/concepts/journaling/).
- **Liveness is a timeout.** Default heartbeat 15 s, stale after 120 s.
- **Volatile write caches are handled.** `fsync` and journal commits issue cache flushes.
