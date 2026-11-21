---
weight: 430
title: "Fencing and split-brain"
description: "Why a heartbeat timeout can't tell a dead node from a slow one, what cetrafs self-fencing protects against, and why hung hosts must be powered off."
toc: true
---

## The split-brain window

cetrafs decides a peer is dead when its heartbeat has been silent for the stale window. From the shared disk alone, a crashed node and a node that is only **stalled** look exactly the same. A node can stall because of a long pause, an overloaded array, or multipath queueing I/O through a path outage.

If a stalled node comes back after its peers have reclaimed its Zone Groups and locks, two nodes each believe they own the same resources. That is **split-brain**. The compare-and-write makes the *moment* of reclaim atomic, but nothing in the shared disk can stop the original owner from carrying on writing what it still thinks is its own.

## What cetrafs does about it: self-fencing

Every registry row carries a **`fence_epoch`**, which acts as that node's **lease**. When a survivor reclaims a dead-looking node's resources, it **increments the dead node's `fence_epoch`**, recording in the same compare-and-write who fenced it, why and when, and then replays its journal. A survivor takes nothing from a stale peer whose lease it hasn't revoked first.

On every heartbeat, each node checks its own row **before** renewing it. It **fences itself** if:

- its `fence_epoch` has changed,
- its row is no longer `REGISTERED`, or
- its row now carries a different UUID or incarnation.

A fenced mount is a **one-way latch**: every access fails with `EIO`, reads included, until the volume is unmounted and mounted again, and the mount throws away its dirty metadata instead of writing it back. `/proc/fs/cetrafs/<dev>/info` shows `fenced: yes`, and `dmesg` names the node that fenced it. It is one cause of the general [stopped state](/docs/reference/mount-options/#what-a-stopped-mount-does). The check comes before the renewal on purpose: renewing first would re-assert a liveness the node is no longer entitled to.

A node can also learn too late. If its heartbeat is stuck behind a hung device, it never gets to check its row, and its other threads write the moment I/O returns. So a node **stops by itself** once its last successful renewal is the stale window less one heartbeat old: 105 s with the defaults. That is before any peer may call it stale, so it stops writing before anyone takes over its resources. The lease is measured on a clock that keeps running through a suspend, and it applies on every mount, with or without compare-and-write.

The lease is also checked close to the write itself: before every metadata write, under the buffer's lock; before every compare-and-write; per chunk of writeback and per block of direct I/O; and before each copy of a defragmentation step. A node that has lost its lease stops issuing writes within one of those steps.

This is the storage-layer equivalent of a VMFS host stopping its I/O when it loses its heartbeat.

## What self-fencing does not cover

Two gaps remain. They are stated here so nobody has to rediscover them:

- **Writes already in flight.** I/O already handed to the block layer, or queued in a multipath map or on the array, still lands, whenever it lands. cetrafs can stop issuing writes; it can't recall one it has issued. That is why path timers must be shorter than the stale window, and why a hung host must be powered off.
- **A host that is partitioned but alive.** It stops writing once its lease runs out, but nothing on the storage can make it stop sooner, or prove to its peers that it has.

## Who must close the rest: the cluster manager

Deciding that a slow-but-alive node must be **stopped** is a cluster-wide policy decision. It needs a view of the whole cluster and of the workloads on it, and it needs a way to act outside the storage path: power fencing (IPMI, PDU), fabric fencing, or an isolation response that stops the workload. A kernel filesystem driver is the wrong place for that.

cetrafs splits the job the same way VMFS and vSphere HA do:

| | VMFS + vSphere | cetrafs + Proxmox HA (or similar) |
|---|---|---|
| Atomic on-disk claims | VMFS, through ATS | cetrafs, through COMPARE AND WRITE |
| Timeout-based liveness | VMFS heartbeat region | Node Registry heartbeat |
| Stop I/O when the lease is lost | Host halts I/O | cetrafs self-fences (`EIO`) |
| Tell a crash from a partition | vSphere HA datastore heartbeating | The cluster manager's quorum |
| Power off a hung host | vSphere HA isolation response | **The cluster manager's STONITH** |

**Without such a manager, run cetrafs on one node only.** With one, configure the manager to fence a host *before* cetrafs's stale window runs out, so a hung host is powered off before its peers take over its resources.

Once the manager has powered a host off, it can tell cetrafs so, and the host's files are taken over at once instead of after the stale window. See [Declare a fenced host dead](/docs/how-tos/recover-node-failure/#declare-a-fenced-host-dead). A node that a hardware watchdog should reboot can mount with `errors=panic`, which panics on a fence, an expired lease or a lost device instead of stopping.

## Make sure I/O fails before peers give up

The same reasoning sets the most important tuning rule: the longest a write can be held on its way to the array must be shorter than the time a node rides out its own stall, the stale window less one heartbeat. A SCSI timeout, an iSCSI or FC transport wait and dm-multipath queueing all add up. Longer, and the stalled node's queued writes could land *after* its peers had taken over. See [Set the stale window for multipath](/docs/how-tos/multipath-stale-window/).
