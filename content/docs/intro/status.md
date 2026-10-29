---
weight: 10
title: "Project status"
description: "Where cetrafs stands today: what has been verified, what hasn't, and how to trial it safely."
toc: true
---

{{< callout type="warning" title="Beta software" >}}
cetrafs is young. It has been heavily reviewed, fuzzed and crash-tested, but it has not had years of production use the way VMFS or ext4 have. **Keep independent backups on other storage**, and trial it on a LUN you can afford to reformat before it holds anything you cannot lose.
{{< /callout >}}

## Current release

The current version is **{{< version >}}**. Its on-disk format is `0x0009`, and it also mounts `0x0008` volumes from 0.8.x without a reformat. The format can still change between releases, and in general there is **no in-place migration**: moving to a new format version means evacuating the data, reformatting and restoring. See [Upgrade](/docs/how-tos/upgrade-reformat/).

## Supported platforms

| | Supported | Notes |
|---|---|---|
| Kernels | `7.0.14`, `7.1.8+deb13` (Debian); Proxmox VE `7.0.14-*-pve` | Older kernels are not supported. The code is new, so other kernels are unverified: they may fail to build or load. |
| Architectures | arm64, amd64 | The on-disk format is little-endian but written to be portable across byte order. Only little-endian hosts have been tested. Keep a cluster on one architecture. |
| Storage | Any block device for a single node; for a cluster, a LUN with SCSI COMPARE AND WRITE | NVMe's fused compare-and-write is not wired up, so an NVMe device is single-node only. |

## What has been verified

The release gate is a scripted matrix (`tests/release-matrix.sh`) plus a multi-node suite run against real hardware:

- **Loop-device integration suite** (`make check`): 164 suites and about 1,757 assertions covering every feature end to end, including simulated cross-node scenarios and a randomized content oracle that checks every byte read back. See [How cetrafs is tested](/docs/concepts/testing/).
- **Multi-node suite** (`ctest/`): runs against a real shared LUN between separate kernels. Its scenarios include the real COMPARE AND WRITE primitive, lock races, journal replay against a fenced peer, torn records, extent-leaf staleness and inode-number reuse. Its first full green run was on a three-node arm64 Proxmox cluster on an HPE 3PAR array over 32 Gb FC multipath. A second, on 0.7.4, used a three-node amd64 Proxmox cluster on a commodity iSCSI LUN: all 27 scenarios passed, three times in a row.
- **Crash-consistency rig**: replays write logs with `dm-log-writes`, injects faults with `dm-flakey`, reorders writes, cuts power without a flush first, and tears blocks at every sector boundary.
- **Fuzzing** of the mount and `fsck` parsing boundaries with hostile images.
- **Soak testing** with mixed workloads and a full `fsck` after every round.

This is evidence from tests, not from years in the field. Some race scenarios have only been run a handful of times on real hardware.

## What is deliberately out of scope

These are design decisions, not missing features: POSIX ACLs, special files (`mknod`), `O_TMPFILE`, `chattr` flags, `RENAME_EXCHANGE`/`RENAME_WHITEOUT`, cluster-wide byte-range locking, volumes spanning several LUNs, big-endian hosts, in-place format migration, and hardware STONITH (the cluster manager's job). See [Limits and unsupported operations](/docs/reference/limits/) for the reasoning behind each.

## On the roadmap

- **Growing a mounted volume.** Since 0.9, [`growfs.cetra`](/docs/how-tos/grow-volume/) grows a volume into a larger device, but only while it is unmounted on every node. Growing it live, while nodes have it mounted, comes next. Shrinking will not be supported.

## A sensible trial plan

The safest way to build confidence is to test one layer at a time, so a fault can be pinned to the layer that caused it. The guide [Validate a storage stack before deployment](/docs/how-tos/validate-storage-stack/) walks through this, from the raw LUN up to live-migrating VMs under load.

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
