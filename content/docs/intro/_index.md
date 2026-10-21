---
weight: 5
title: "What is cetrafs?"
description: "A clustered, shared-disk filesystem for Linux, built to hold VM disk images on one LUN shared by several hypervisors."
toc: true
---

cetrafs is a **clustered, shared-disk filesystem for Linux**. Several hosts mount one shared block device at the same time, usually an iSCSI or Fibre Channel LUN. Each host runs its own subset of virtual machines, and the VM disk images (raw, qcow2, vmdk) live directly on that one volume. This is how VMware's VMFS backs a vSphere cluster, and cetrafs does the same job for a standard Linux kernel.

It ships as two parts:

- an **out-of-tree kernel module**, `cetrafs.ko`, which registers the `cetrafs` filesystem type;
- three **userspace tools**: `mkfs.cetra` (create a volume), `fsck.cetra` (check and repair one) and `defrag.cetra` (defragment a file online).

## How it differs from other cluster filesystems

Most Linux cluster filesystems (GFS2, OCFS2) coordinate nodes over the network with a distributed lock manager, and they need a cluster stack such as corosync and pacemaker to do it. cetrafs coordinates **through the storage itself**. Every contested claim (registering a node, taking ownership of a region, locking a file, allocating an inode) is a single atomic **SCSI COMPARE AND WRITE** on one 512-byte record on the shared LUN. VMFS uses the same primitive under the name ATS.

This works because the target workload is narrow:

- A VM image normally has **one writer**, the host running that VM. cetrafs locks whole files, not byte ranges, and needs no cluster-wide cache coherency.
- Each node **allocates only from regions it owns** (Zone Groups), so writing new data needs no cross-node lock in the steady state.
- Images are opened once and written for months. Metadata operations are synchronous and comparatively slow, and that is an acceptable cost for this workload.

## What you get

- **Shared-disk clustering** for up to 64 nodes on one LUN.
- **Crash consistency** from a per-node write-ahead redo journal, replayed at mount and whenever a dead peer is reclaimed.
- **End-to-end integrity**: CRC32C on every on-disk structure, verified by the kernel on read.
- **A real POSIX namespace**: directories, hardlinks, symlinks, and `user.*`, `trusted.*` and `security.*` extended attributes, with LSM labelling so SELinux-enforcing hosts work.
- **Large sparse files** up to 16 TiB, with `SEEK_HOLE`/`SEEK_DATA` and `FIEMAP` so thin images stay thin.
- **Live migration** support through the `nofilelock` mount option.
- **Online maintenance**: in-place defragmentation, a background scrubber, and a conservative repairing `fsck`.

## What it is not

- **Not a general-purpose shared POSIX filesystem.** There are no cluster-wide byte-range locks, no POSIX ACLs and no special files. If many hosts need to read and write the *same* files concurrently, use GFS2 or OCFS2. See [cetrafs vs GFS2](/docs/concepts/vs-gfs2/).
- **Not a distributed filesystem.** No data is replicated across nodes; every node sees the same physical blocks. Redundancy is the storage array's job.
- **Not a cluster manager.** cetrafs detects dead peers and fences *itself* when it has been declared dead, but it does not power off other hosts. A multi-node production deployment needs an external manager that provides fencing (STONITH). See [Fencing and split-brain](/docs/concepts/fencing/).

## Requirements at a glance

| Requirement | Why |
|---|---|
| Linux kernel `7.0.14` or `7.1.8+deb13` (incl. Proxmox VE `7.0.14-*-pve`) with headers | The module is built against the running kernel. Other kernels are untested. |
| A shared block device visible to every node | That is the shared disk. |
| For more than one node: SCSI **COMPARE AND WRITE** (ATS) support on the LUN | It is the only cross-node mutual-exclusion primitive. Without it a volume is single-node only, and mount enforces this. |
| For production multi-node: a cluster manager with fencing | cetrafs's liveness check is a heartbeat timeout, so killing a hung host has to happen outside the filesystem. |
| A little-endian host (amd64, arm64) | The only tested architectures. Keep a cluster on one architecture. |

## Next steps

- Read [Project status](/docs/intro/status/) before you put any data on cetrafs.
- Try it: [Your first cetrafs volume](/docs/tutorials/first-volume/).
- Understand it: [Architecture overview](/docs/concepts/architecture/).
