---
weight: 445
title: "cetrafs vs VMFS"
description: "Where cetrafs matches VMFS's clustering model, where it goes further, and where it deliberately does less."
toc: true
---

cetrafs is built for the deployment VMFS serves: several hypervisors mount one shared LUN, each runs its own VMs, and the disk images live directly on the volume. This page compares the two.

VMFS's internals aren't published the way cetrafs's format header is. The VMFS column reflects publicly documented behaviour (VMware KB articles, architecture whitepapers, ATS/VAAI documentation), not VMware's source.

## At a glance

| | VMFS | cetrafs |
|---|---|---|
| Model | Shared disk | Shared disk |
| Cluster primitive | ATS (atomic test-and-set); SCSI-2 reservations as a legacy fallback | Atomic COMPARE AND WRITE only, the same primitive. No fallback for multi-node. |
| Node liveness | On-disk heartbeat region, timeout | On-disk Node Registry heartbeat, timeout |
| Lock granularity | Per resource (file, directory, bitmap) | Per resource: a whole-file lock per inode, and a namespace lock covering only the records an operation changes |
| Fencing on reclaim | A host that loses its heartbeat must re-acquire before resuming I/O | The reclaiming node increments the dead node's lease; the node fences itself (`EIO`) on its next heartbeat |
| Crash recovery | On-disk lock state plus offline tooling (VOMA) | Per-node write-ahead redo journal, replayed automatically |
| Namespace | Purpose-built for VM files | POSIX: directories, hardlinks, symlinks, xattrs, SELinux labels |
| Checksums | Not exposed as a user-facing feature | CRC32C on every structure, verified by the kernel on read |
| Allocation | Any host can allocate anywhere it wins the lock | Disk divided into Zone Groups; each node allocates only from its own |
| Offline repair | VOMA, for a limited set of faults | `fsck.cetra`: four passes, repairs what has one correct answer |
| Block size | 1 MB, with sub-blocks for small files (VMFS5/6) | Fixed 4 KiB |
| Spanned volumes | Up to 32 extents | One block device |
| Snapshot resignaturing | Yes | No |
| VAAI offload (clone, UNMAP, zeroing) | Yes | No |
| On-disk format | Proprietary | Open: one published header |
| Platform | ESXi | Standard Linux kernel module |

## Where they are the same

- **Both are shared-disk.** Every host sees the same blocks and coordinates through the storage, not over the network.
- **Both use a brief atomic primitive, not held range locks.** ATS and COMPARE AND WRITE are the same idea: one atomic compare-and-swap of one small record.
- **Both judge liveness with an on-disk heartbeat and a timeout**, not a quorum service.
- **Both stop I/O on a host that has lost its lease**, and both leave powering off a hung host to the layer above (vSphere HA; Proxmox HA or another cluster manager).
- **Both target the same workload**: a moderate number of large files, mostly growing sequentially. Neither is tuned for small-file metadata.

## Where cetrafs goes further

- **An open format.** The on-disk format is one published header file, so you can read exactly what is on the disk.
- **A conventional journal.** Crash recovery is an ext4-style redo log, replayed automatically at mount and on reclaim, with a guard that won't roll back blocks another node has since rewritten.
- **Kernel-enforced checksums** on every structure, with a retry for torn reads.
- **A POSIX namespace**, including hardlinks, symlinks and extended attributes, with SELinux labelling.
- **Allocation without contention.** With static per-node allocation regions, writing new data needs no cross-node lock in the steady state.
- **Runs on any Linux host.** No hypervisor lock-in, and no per-socket datastore licence.

## Where cetrafs deliberately does less

- **Throughput of metadata operations.** A namespace operation costs about a dozen reads and eight writes. On a LUN where each takes tens of milliseconds, that limits how fast creates and deletes can go. VMFS has had many years of work on reducing round trips.
- **One LUN per volume.** You grow capacity by growing the LUN, not by adding extents. Growing a volume in place when its LUN grows is planned.
- **No snapshot resignaturing.** Mounting an array-level snapshot of a volume next to the original isn't a defined workflow.
- **No hardware offload.** Clone, copy, space reclaim and zeroing are ordinary block I/O from the host.
- **Maturity.** VMFS has run in production for decades. cetrafs's cross-node behaviour has been tested on real multi-node hardware, but not at that scale or for that long.

None of these are correctness gaps. They are scope that hasn't been built, or has been deliberately left out.
