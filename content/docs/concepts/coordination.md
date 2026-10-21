---
weight: 410
title: "Cluster coordination"
description: "How nodes coordinate with nothing but the shared disk: atomic compare-and-write, the Node Registry, heartbeats and the stale window."
toc: true
---

cetrafs has no cluster lock manager, no quorum service and no network heartbeat. Nodes coordinate using two things: **records on the shared disk** that every node can read, and an **atomic compare-and-write** that the storage array arbitrates.

## Compare-and-write: the one primitive

SCSI **COMPARE AND WRITE** (opcode `0x89`) is one command that carries two images of a block: what the sender *expects* to be on disk, and what it *wants* to write. The array compares and writes as a single atomic step. If the block no longer matches the expected image, because another node changed it first, the array writes nothing and answers **MISCOMPARE**.

VMware calls this primitive ATS (Atomic Test and Set) and builds VMFS's on-disk locking on it. cetrafs uses it for **every** contested claim:

- registering a node,
- taking ownership of a Zone Group,
- the per-inode namespace lock,
- the whole-file open lock,
- allocating an inode (a bit in the global inode bitmap),
- appending to another node's pending-free queue,
- the journal replay claim.

Each claim is a **brief** atomic operation on one small record: read the record, decide, then compare-and-write the new version. It is never a lock held on a range of the disk while data is written. On a miscompare, cetrafs reads the record again and decides again. It **never** retries against the stale image, because that would turn a compare-and-swap into a blind overwrite.

Every claim is also read back afterwards, as a second check that it took. A readback mismatch counts as a lost race, never as success.

### One primitive, used everywhere

Using a single mechanism for every claim is a deliberate simplification. There is one kind of mutual exclusion to reason about and one failure mode (miscompare, then retry), and nothing else can drift out of step with it. Earlier versions also had a SCSI Persistent Reservation backend. It was deleted instead of being kept as a fallback, so there is no second, weaker path that might get used without anyone noticing.

### Devices without compare-and-write

A loop device, a local disk, an NVMe drive or a LUN without ATS has no atomic compare-and-write. On such a device cetrafs does each claim as an ordinary read, change, write under a lock local to the node. That is only correct if there is exactly one node, so the **mount gate** refuses a mount when another live node already has such a volume mounted. A device with no compare-and-write is **single-mounter by construction**.

If cetrafs can't *determine* whether a device supports compare-and-write, it refuses the mount instead of assuming the weaker model. Otherwise one node could use the serialised fallback while another used real atomic operations, on the same records.

## The Node Registry

Each node that mounts a volume claims a row in the on-disk **Node Registry**, using compare-and-write. The row is keyed by the host's **stable machine UUID**, so a host that reboots finds its own row again instead of taking a new one. The row holds:

- the UUID and an informational label (the hostname),
- `hb_seq` and `last_seen`: the heartbeat,
- `hb_interval_secs`: the node's own heartbeat rate, so peers judge it by its own rate,
- `fence_epoch`: the node's **lease**, explained in [Fencing](/docs/concepts/fencing/).

Other structures refer to a node by its compact row index, not its UUID. A Zone Group's owner, a file's lock holder and a namespace-lock holder are all stored as row numbers.

The registry has room for at most **64 nodes**. The limit comes from the per-inode read-presence mask, a 64-bit field with one bit per row that records which nodes have a file open for reading.

## Heartbeats and the stale window

Every 15 seconds (`hb_interval_secs`) each node:

1. checks its own lease, and fences itself if another node has revoked it;
2. renews its registry row (`hb_seq`, `last_seen`);
3. picks up any Zone Group abandoned by a dead peer, drains its own pending-free queues, gives back surplus Zone Groups, and replays the journals of crashed peers that nothing else has needed yet.

Another node counts as **stale**, meaning presumed dead, once its row hasn't been renewed for `stale_secs` (120 seconds by default, 8 missed beats). A clean unmount backdates the row so peers see the departure immediately.

Staleness is what turns "node X crashed while holding something" from something stuck forever into something another node can safely reclaim. Before it reclaims anything, the reclaiming node replays the dead node's journal.

## The limit: a timeout is not a verdict

Staleness is a **timeout, not consensus**. From the shared disk alone, a node that has crashed and a node that has merely stalled (a long pause, a saturated array, all paths down) look the same. That is the most important caveat in the whole design, and [Fencing and split-brain](/docs/concepts/fencing/) covers it.

The timing bounds exist to keep the timeout away from danger. The `controls` file won't set a stale window below 15 s, or below 3 heartbeats, because ordinary jitter would then cause false reclaims. It won't go above 240 s either, because a crashed node's resources would stay locked too long for a VM datastore. A node also gives a peer at least four of *that peer's* own heartbeat intervals, so peers tuned differently are never misjudged.

## Cache coherency across kernels

The Linux buffer cache assumes one kernel owns the device. Once a node has read a block, it keeps serving its cached copy, and it can't notice that another node has rewritten the block. cetrafs handles this explicitly:

- **Always read fresh from the device:** registry rows, Zone Group ownership, directory blocks, extended-attribute blocks. These are small and rarely read, so this is cheap.
- **Cached, but invalidated when ownership changes:** inode records and a Zone Group's Block Group descriptors and bitmaps stay on the fast cached path, and are dropped exactly when ownership changes hands.

Without this, the readback that confirms a claim could simply return the node's own cached copy. Two-node testing on real hardware once caught both nodes "winning" the same file lock that way.
