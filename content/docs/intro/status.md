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

The current version is **{{< version >}}**. The on-disk format can change between releases and there is **no in-place migration**. Moving to a new format version means evacuating the data, reformatting and restoring. See [Upgrade to a new format version](/docs/how-tos/upgrade-reformat/).

## Supported platforms

| | Supported | Notes |
|---|---|---|
| Kernels | `7.0.14`, `7.1.8+deb13` (Debian); Proxmox VE `7.0.14-*-pve` | Older kernels are not supported. The code is new, so other kernels are unverified: they may fail to build or load. |
| Architectures | arm64, amd64 | The on-disk format is little-endian but written to be portable across byte order. Only little-endian hosts have been tested. Keep a cluster on one architecture. |
| Storage | Any block device for a single node; for a cluster, a LUN with SCSI COMPARE AND WRITE | NVMe's fused compare-and-write is not wired up, so an NVMe device is single-node only. |

## What has been verified

The release gate is a scripted matrix (`tests/release-matrix.sh`) plus a multi-node suite run against real hardware:

- **Loop-device integration suite** (`make check`): over 1,200 assertions covering every feature end to end, including simulated cross-node scenarios.
- **Multi-node suite** (`ctest/`): runs against a real shared LUN between separate kernels. Its scenarios include the real COMPARE AND WRITE primitive, lock races, journal replay against a fenced peer, torn records, extent-leaf staleness and inode-number reuse. Its first full green run was on a three-node arm64 Proxmox cluster on an HPE 3PAR array over 32 Gb FC multipath.
- **Crash-consistency rig**: replays write logs with `dm-log-writes`, injects faults with `dm-flakey`, reorders writes, and cuts power without a flush first.
- **Fuzzing** of the mount and `fsck` parsing boundaries with hostile images.
- **Soak testing** with mixed workloads and a full `fsck` after every round.

This is evidence from tests, not from years in the field. Some race scenarios have only been run a handful of times on real hardware.

## What is deliberately out of scope

These are design decisions, not missing features: POSIX ACLs, special files (`mknod`), `O_TMPFILE`, `chattr` flags, `RENAME_EXCHANGE`/`RENAME_WHITEOUT`, cluster-wide byte-range locking, volumes spanning several LUNs, big-endian hosts, in-place format migration, and hardware STONITH (the cluster manager's job). See [Limits and unsupported operations](/docs/reference/limits/) for the reasoning behind each.

## On the roadmap

- **Growing a volume when its LUN grows** (`extendfs`): an ext4-style grow that appends new Block Groups to the end of the device, offline first and later live. This needs one format change to reserve table space. Shrinking will not be supported.

## A sensible trial plan

The safest way to build confidence is to test one layer at a time, so a fault can be pinned to the layer that caused it. The guide [Validate a storage stack before deployment](/docs/how-tos/validate-storage-stack/) walks through this, from the raw LUN up to live-migrating VMs under load.

## License

cetrafs (the kernel module and the tools) is free software, licensed under the [GNU General Public License, version 2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) or (at your option) any later version (`GPL-2.0-or-later`).

This documentation is licensed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/) (CC BY 4.0): you may copy and adapt it, including commercially, as long as you credit the source. Both come without warranty; see [Warranty and liability](/docs/intro/disclaimer/).

Neither license covers the cetrafs name or logo, which are trademarks of Massimo Cetra. See [The cetrafs name and logo](/docs/intro/trademark/).
