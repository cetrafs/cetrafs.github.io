---
weight: 10
title: "Project status"
description: "Where cetrafs stands: ready for production on its target workload, what that rests on, the supported platforms, and what is out of scope."
toc: true
---

cetrafs is **ready for production use on its target workload**: VM disk images on a shared LUN with atomic COMPARE AND WRITE. The on-disk format, the cluster protocol and the recovery paths are complete, and the list of known open defects is empty.

That claim rests on testing, not on years in the field. Every change goes through more than 900 regression suites, a two-node suite on real SAN storage, crash replay, fuzzing and a KASAN build. [How cetrafs is tested](/docs/concepts/testing/) describes what is tested, how, and how long it takes.

As with any storage system, keep backups on other storage, and run a multi-node cluster with a cluster manager that can fence hosts.

## Current release

The current release is **{{< version >}}**. It writes on-disk format **`0x000A`**, and mounts nothing else.

`0x000A` is the format change that release was built around: 48-bit file offsets, deeper extent trees, an inode table that grows with the volume, a checksum on every bitmap sector, a backup superblock, and the fields behind the cluster fixes. Volumes from 0.9.x (format `0x0009`) aren't mounted. Moving from 0.9.x to 0.10 means evacuating the data, reformatting and restoring: see [Upgrade to a new format version](/docs/how-tos/upgrade-reformat/).

Within one format version, nodes running different builds or different kernels can share a volume. A node whose module speaks another format version is refused at mount, so two formats never share a volume.

## What changed in 0.10.2

0.10.2 keeps format `0x000A`: a 0.10.1 volume mounts as it is, and nodes can be upgraded one at a time.

- **Smooth large writes on thin LUNs.** A node no longer hands back, every heartbeat, the empty space it has just claimed to write into. A Zone Group it is using keeps its empty Block Groups for a grace period (`handback_grace`, default 150 s) before they are unmapped and returned. A disk move into a sparse image no longer stalls every 15 seconds.
- **`nofilelock` disables defragmentation again.** On Proxmox the background defragmenter kept moving VM images while qemu was filling them, and a disk move fell to a few MB/s.
- **A bounded wait for a full thin pool.** A write waits up to `space_wait_secs` (default 300) for the array to find space, then the mount stops instead of hanging.
- **More `fsck` checks**: duplicate and impossible directory names, gaps in a directory's blocks, and file sizes past the format's limit. `fsck.cetra --live` runs on a node that has the volume mounted.
- **The DKMS module reports its release** in `modinfo` and `/sys/module/cetrafs/version`.
- **Fixes from a code review** of the journal, allocator, scrub, trim and directory paths, and from 65 new test suites.

## What changed in 0.10 (since 0.9.5)

- **Bigger files.** A file can address 2<sup>48</sup> blocks (1 EiB, up from 16 TiB), and its extent tree goes one level deeper, to about 65 million extents. A directory grows the same way, to about 3.9 million entries.
- **A volume that grows in every dimension.** A grow now adds inodes as well as space, so the inode count is no longer fixed at `mkfs` time.
- **Space returned to thin LUNs.** An emptied Block Group is unmapped as it goes back to the pool, `fstrim` works, and `-o discard` returns space as it is freed. `fallocate(ZERO_RANGE)` zeroes in place with WRITE ZEROES. See [Return free space to a thin LUN](/docs/how-tos/reclaim-thin-space/).
- **Stronger integrity.** Every 512-byte sector of the allocation bitmaps has its own checksum; every address read off the disk is range-checked before it is used; a copy of the superblock sits at 8 MiB; and damage found at runtime leaves a lasting "needs fsck" mark.
- **No `fsck` after a crash.** Mounting again repairs what an unclean shutdown left. `fsck.cetra --live` checks a volume while other nodes use it, and `fsck.cetra -r` rebuilds a damaged Zone Group, Block Group or Node Registry record.
- **Faster failover.** An HA agent that has powered a host off can declare it dead at once, instead of waiting out the stale window.
- **Honest byte-range locks.** `fcntl` locks are refused on a default mount instead of silently binding one node. See [`fcntl` locks](/docs/reference/mount-options/#fcntl-byte-range-locks).
- **A thin pool that runs out of space pauses writes** instead of stopping the mount at once, as VMFS does.
- **Defragmentation of sparse and preallocated images.**
- **Nanosecond timestamps** and a birth time, reported by `statx`.
- **Hundreds of fixes**, most of them found by the new test tiers: two-node interleavings, crash cuts, `ENOSPC` sweeps and fuzzing.

## Supported platforms

| | Supported | Notes |
|---|---|---|
| Kernels | `7.0.14`, `7.1.8+deb13` (Debian), `7.2.11`; Proxmox VE `7.0.14-*-pve` | DKMS builds the module for kernels 7.0 to 7.2 and skips any other. |
| Architectures | amd64, arm64 | The kernel must use 4 KiB pages. The on-disk format is little-endian and portable; only little-endian hosts are tested. |
| Storage | Any block device for one node. For a cluster, a SCSI LUN with COMPARE AND WRITE, with 512-byte or 4 KiB logical blocks, single-path or dm-multipath | NVMe and NVMe over Fabrics devices work on one node only: NVMe compare-and-write isn't wired up. |
| Array cache | Non-volatile or write-through | cetrafs orders its writes with cache flushes. An array that acknowledges a flush before the data is safe breaks that ordering, and nothing on the host can detect it. |

## Validated on

- **Enterprise Fibre Channel**: HPE 3PAR over 32 Gb FC multipath, two- and three-node Proxmox VE clusters, arm64 and amd64.
- **iSCSI**: a commodity iSCSI LUN under a three-node amd64 Proxmox VE cluster.
- **Loop devices**, for the single-node gate.

The last full validation, on 0.10.1, passed every one of 6,623 assertions, every two-node release scenario on the FC rig, 6,600 fuzz iterations with no finding, and a KASAN build with no report. [How cetrafs is tested](/docs/concepts/testing/#the-last-validation-run) has the details.

## Out of scope

These are design decisions, not missing features: POSIX ACLs, special files (`mknod`), `O_TMPFILE`, `chattr` flags, `RENAME_EXCHANGE` and `RENAME_WHITEOUT`, cluster-wide byte-range locks, volumes spanning several LUNs, snapshots, big-endian hosts, and powering off hosts (the cluster manager's job). See [Limits and unsupported operations](/docs/reference/limits/).

Planned, not built yet: rolling upgrades across a format change, and NVMe compare-and-write.

## Before a first deployment

Check the two properties of your SAN that cetrafs depends on, atomic compare-and-write and coherent reads across hosts, then prove each layer before the next. [Validate a storage stack before deployment](/docs/how-tos/validate-storage-stack/) walks through it, from the raw LUN to live-migrating VMs under load.

## License

cetrafs is free software. Its two halves are licensed differently:

| Part | License |
|---|---|
| Kernel module (`kmod/`) | [GPL, version 2 or later](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) (`GPL-2.0-or-later`). It links against the Linux kernel, so there is no other option for it. |
| Userspace tools (`mkfs.cetra`, `fsck.cetra`, `defrag.cetra`, `growfs.cetra`) | [AGPL, version 3 or later](https://www.gnu.org/licenses/agpl-3.0.html) (`AGPL-3.0-or-later`), or a **commercial license** for those whom the AGPL's source-availability terms don't suit. Contact Massimo Cetra through [GitHub](https://github.com/ctrix). |
| On-disk format header (`include/cetrafs.h`) | Any of the three, so each half can use it. The format itself is documented and anyone may implement it. |

Each source file's `SPDX-License-Identifier` line is authoritative for that file. See [`LICENSE`](https://github.com/cetrafs/cetrafs/blob/main/LICENSE) in the repository.

This documentation is licensed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/) (CC BY 4.0): you may copy and adapt it, including commercially, as long as you credit the source. The software and the documentation come without warranty; see [Warranty and liability](/docs/intro/disclaimer/).

Neither license covers the cetrafs name or logo, which are trademarks of Massimo Cetra. See [The cetrafs name and logo](/docs/intro/trademark/).
