---
weight: 450
title: "cetrafs vs GFS2 for VM storage on a shared LUN"
linkTitle: "cetrafs vs GFS2"
description: "Two different answers to two different questions: when GFS2 is the right choice, when cetrafs is, and measured throughput on the same LUN."
toc: true
---

These two aren't competing answers to the same question. **GFS2 is a general-purpose POSIX cluster filesystem.** **cetrafs is a VM datastore** that deliberately gives up POSIX generality to get a simpler model for one workload: VM disk images on a shared LUN. Which one is right depends almost entirely on which of those two sentences describes your problem.

## Which one you want

**Choose GFS2 when:**

- you need a real shared POSIX filesystem: many hosts reading and writing the **same** files at once, with full cache coherency;
- applications rely on byte-range locking, POSIX ACLs or special files;
- your storage doesn't support atomic COMPARE AND WRITE;
- you want vendor support and two decades of field history;
- you expect to grow a volume by adding LUNs.

**Choose cetrafs when:**

- the workload is VM disk images on a shared SAN LUN, each host running its own guests;
- one writer per image is the natural access pattern (the VMFS model, not the POSIX one);
- you want no DLM, no corosync and no lockspace tuning in the data path;
- your array supports SCSI ATS and throughput on it matters;
- you can run a cluster manager that provides host fencing.

## At a glance

These rows describe design decisions, not scores. Several of them are deliberate scope rather than capability.

| | GFS2 | cetrafs |
|---|---|---|
| Intended workload | General-purpose shared POSIX | VM disk images on a shared LUN |
| Cross-node locking | DLM, full cache coherency | Whole-file exclusive open lock |
| Required stack | corosync + pacemaker + DLM | None in the data path |
| Storage requirement | Any shared block device | SCSI ATS (`0x89`) for multi-node |
| Fencing | STONITH through the cluster stack | Storage lease + self-fencing; powering off hosts is left to the cluster manager |
| Membership | Quorum through corosync | Heartbeat timeout |
| Journaling | All metadata, per node | Per node, for in-place blocks; global tables protected by atomic compare-and-write instead |
| Byte-range locks | Yes, cluster-wide | Not a cluster primitive |
| POSIX ACLs | Yes | No: mode bits and xattrs only |
| Maturity | In mainline since 2006 | Beta, out of tree |
| On-disk stability | Stable, long-supported | No backward compatibility during the beta |

## Where GFS2 is ahead

Every advantage on one side is paid for on the other. These are real, and none of them is a rounding error.

- **Two decades of production.** GFS2 has been in mainline Linux since 2006, has commercial support, and has run on thousands of clusters. cetrafs is in beta. No amount of testing replaces time in the field, and this is the biggest single difference between them.
- **Fencing that actually stops a host.** Pacemaker STONITH powers the node off. cetrafs increments a storage lease, and the displaced node fences itself on its next heartbeat; writes already in flight before that check still land. cetrafs closes the storage half of split-brain and leaves the rest to others, so you still need a cluster manager with fencing to run it safely on more than one host.
- **Real quorum.** corosync can tell a partitioned cluster from a dead node. cetrafs's liveness is a heartbeat timeout, so a host that is merely slow looks the same as one that has failed.
- **No special storage requirement.** GFS2 runs on any shared block device. cetrafs needs atomic COMPARE AND WRITE; without it a volume can only be mounted by one host.
- **Volumes that grow.** A GFS2 filesystem can be extended. A cetrafs volume spans exactly one block device.

## Where cetrafs is ahead

- **It sidesteps the hardest problem.** Cluster-wide cache coherency is where distributed lock managers earn their reputation: contention on shared directories, locks bouncing between hosts. cetrafs avoids that whole class by design. Each image has one writer, and each node allocates only from regions it owns, so the steady-state write path needs no cross-node lock.
- **Far fewer moving parts.** No DLM, no corosync in the I/O path, no lockspace tuning. In practice most cluster-filesystem incidents are failures of the surrounding stack, not of the filesystem. Having fewer components makes the system more reliable, not just easier to run.
- **Measurably faster on this workload.** About 2.3× GFS2 on direct writes and 1.4× on synchronous ones, on the same LUN, largely because cetrafs doesn't pay for coherency that VM images don't use.
- **One primitive everywhere.** Every contested claim is a single compare-and-write on one 512-byte record. There is one mutual-exclusion mechanism to reason about, not a hierarchy of them.
- **Built for the hypervisor case.** Whole-file locking, per-node allocation regions, online defragmentation of live images and direct-I/O tuning are all designed around several hypervisors sharing one LUN.

## Measured throughput

Same host, same SAN LUN, same kernel. 3 GB written to a new file each run, cetrafs 0.6 on arm64.

| Mode | cetrafs | GFS2 |
|---|---|---|
| `O_DIRECT` (qemu `cache=none`) | 613–710 MB/s | 283 MB/s |
| Buffered, synchronous (`oflag=sync`) | 340–369 MB/s | 241–242 MB/s |

**How the numbers were taken.** The cetrafs figures are the range across 8 runs spread over three nodes; the spread within one node was as wide as the spread between nodes. The GFS2 figures are single runs taken at a different time. The array also carries other production load, and back-to-back runs of the same command have differed by up to 30%. Treat these as indicative, not as a controlled benchmark: the factor between the two matters more than the exact digits.

**Method:** `dd if=/dev/zero of=<new file> bs=1M count=3000` with `oflag=direct` or `oflag=sync`, using a new filename every run so block allocation is actually exercised. Both are durable writes. This is one workload on one array, and your own measurements should decide anything that matters.

## Where this leaves it

If you need a shared POSIX filesystem, cetrafs isn't a candidate and doesn't try to be. It lacks byte-range locking, ACLs and special files by choice, and that choice is what makes the rest possible.

If you need VM images on a shared LUN, the narrower contract is the point, not a compromise. It is the same bet VMFS made. The remaining question is maturity, and it is a fair one: today GFS2 is the conservative choice. cetrafs is in beta, though it has been validated on real hardware. Its multi-node suite (lock races, journal replay against a fenced peer, torn records, inode reuse) passes on a three-node cluster over a shared FC LUN, alongside fsck image tests, kernel regression suites, fuzzing and a crash-consistency rig. That is evidence from testing, not from time in the field. Trial it on storage you can afford to reformat before it holds anything you can't lose.
