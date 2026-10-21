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

Every registry row carries a **`fence_epoch`**, which acts as that node's **lease**. When a survivor reclaims a dead-looking node's resources, it replays that node's journal and then **increments the dead node's `fence_epoch`**.

On every heartbeat, each node checks its own row **before** renewing it. It **fences itself** if:

- its `fence_epoch` has changed,
- its row is no longer `REGISTERED`, or
- its row now carries a different UUID.

A fenced mount is a **one-way latch**: every write fails with `EIO` until the volume is unmounted and mounted again. `/proc/fs/cetrafs/<dev>/info` shows `fenced: yes`. The check comes before the renewal on purpose: renewing first would re-assert a liveness the node is no longer entitled to.

This is the storage-layer equivalent of a VMFS host stopping its I/O when it loses its heartbeat.

## What self-fencing does not cover

Two gaps remain. They are stated here so nobody has to rediscover them:

- **Writes already in flight.** Anything the stalled node issued before its next heartbeat check can still reach the disk after another node has taken over. That includes dirty buffers already in the page cache, because the block layer flushes them underneath the filesystem's fence. Bitmap blocks are the main concern: a late write of a stale bitmap block can undo bits the new owner has since set.
- **An operation that loses its namespace lock.** If a node's namespace lock is taken from it during an operation, the node notices when it releases the lock. It discards its staged record update instead of overwriting the new holder's repair. The system call had already returned success, though, so that operation's record changes (a link count, a directory sequence number) are lost. The new holder's journal replay restores what it covers, and fsck reconciles the rest.

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

## Make sure I/O fails before peers give up

The same reasoning sets the most important tuning rule: a node's own failed I/O must give up before its peers give up on the node. With dm-multipath queueing I/O through a path outage for longer than the stale window, the stalled node's queued writes would be released *after* its peers had taken over. See [Set the stale window for multipath](/docs/how-tos/multipath-stale-window/).
