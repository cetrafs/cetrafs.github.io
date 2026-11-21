---
weight: 415
title: "Zone Groups and allocation"
description: "Why each node allocates only from regions it owns, how ownership moves, and how a block in someone else's region gets freed."
toc: true
---

## The problem

Two nodes that both need a new block must never pick the same one. A cluster filesystem can solve this by locking the free-space bitmap across the cluster on every allocation. That would put a cross-node round trip on every new block, and a streaming VM write allocates tens of thousands of blocks per second.

## Partition the disk instead

cetrafs divides the data area into **Block Groups**. A Block Group is a self-contained region: a header block, its own data bitmap, then its data blocks (1 GiB each by default). Block Groups are gathered into **Zone Groups**. Each Block Group records which Zone Group owns it; `mkfs.cetra` deals them out round-robin, so Block Group *b* starts in Zone Group *b* mod *Z*.

A Zone Group has **at most one owner** at any moment, claimed by compare-and-write. **A node allocates new blocks only from Zone Groups it owns.** Two nodes therefore never draw from the same free-space pool: they work in disjoint parts of the disk by construction, so there is nothing to race for. In the steady state allocation needs **no cross-node coordination at all**. Only claiming or handing over a Zone Group does.

## Claim the minimum

At mount, a node claims **one** Zone Group, if it doesn't already own one. It claims **one more** only when every Block Group in the ones it owns is full. When an extra Zone Group it owns becomes empty, it gives it back.

This is deliberate. If a node claimed everything available at mount, the first node to mount a fresh volume would own the whole disk and every later node would starve. Taking only what it needs keeps space available to everyone. It also means the Zone Group count limits how many nodes can write at once: **with N Zone Groups, at most N nodes can hold write capacity at the same time.** A node that mounts when every Zone Group is taken shows `write_ready: no` until one frees up.

## Claiming and handing back Block Groups

Ownership also moves one Block Group at a time, not only one Zone Group at a time. A Block Group can belong to **no** Zone Group: it is then free for any node to take.

- **Claiming.** When every Block Group in a node's Zone Groups is full and there is no Zone Group left to claim, the node claims an unowned Block Group into one of its Zone Groups, with one compare-and-write on the Block Group's own record. Two nodes racing for the same one can't both win.
- **Handing back.** A node gives back every Block Group it owns that is **completely empty**, even inside a Zone Group it keeps. A node holding a Zone Group with 2 used Block Groups out of 100 keeps the 2, and the other 98 become available to everyone. On a thin LUN, a Block Group is [unmapped](/docs/how-tos/reclaim-thin-space/) as it is handed back, so deleting a VM returns its space to the array.

The rule for giving space back is the same as before: only what is provably empty. Nothing points into an empty Block Group, and ownership only decides who may allocate from it next, so handing it back can't affect any data. Each Zone Group keeps a count of the free space in unowned Block Groups (`pool_free_blocks`), so `df` keeps counting space that has been handed back.

This is also what makes [growing a volume](/docs/how-tos/grow-volume/) simple: it adds new Block Groups and touches no Block Group that already exists.

## Space is per node

A node never takes space back from a live peer: only a Block Group the peer has emptied and handed back. A Block Group that is partly used stays with its owner. So on a nearly full volume, one node can run out of space while another still has room, and `df` shows each node what **it** can allocate. Keep headroom per node, not just per volume. `free_data_blocks_owned` and `free_data_blocks_unowned_bgs` in [`info`](/docs/reference/procfs/#geometry-and-space) show it.

## Taking over from a dead node

Zone Groups held by a **stale** node can be taken over. The node taking over replays the dead node's journal first, then re-derives the Zone Group's free counts from its bitmaps, so any drift a crash left behind is corrected.

## What ownership does *not* mean

Zone Group ownership controls **new allocation only**. It doesn't decide who may write to a block that is already allocated. A VM image on node A may have blocks in node B's Zone Group, for instance because node B created it or because it was migrated. Writing those blocks is governed by the [file lock](/docs/concepts/locking/), not by Zone Group ownership.

## Freeing a block in someone else's Zone Group

A bitmap has exactly one writer, its Zone Group's owner, and that rule matters. So when node A deletes or truncates a file whose blocks sit in a Zone Group owned by node B, node A **doesn't touch B's bitmap**. It appends an entry, `{block, count}`, to that Zone Group's **pending-free queue**, using compare-and-write. The owner drains its queues and applies the frees at mount, on every heartbeat, and after it claims a Zone Group.

A drain takes an entry off the queue before it applies it, and applies a range once however many copies it found, so a free queued twice is never applied twice. Each entry also carries the Block Group's free generation, so a late copy that lands after the scrubber reclaimed the same blocks is dropped instead of freeing blocks that belong to someone new.

Each queue holds 61,440 entries, enough for the frees from deleting a large, fragmented image in one go, and one compare-and-write carries many frees. If a queue does fill, because its owner is down or slow to drain, the extra frees are **dropped and leaked** rather than failing the delete; the scrubber reclaims them later.

## Keeping free counts cheap

Each Block Group and Zone Group caches its free-block count. Updating those counts on the device for every block allocated would add a synchronous write per block. A 1 MiB write once went from about 2 s to about 40 s because of exactly that. So the changes **accumulate in memory**, and the owner applies them with one compare-and-write per Block Group at **durability boundaries**: file close, `fsync`, namespace-lock release, `sync`, unmount.

A file held open for days, such as a VM image, carries its pending change for days, possibly across a change of ownership after which the new owner has already recounted the Block Group from its bitmap. A recount discards any change still pending from before it, so the change can't be counted twice.

Allocation bitmap blocks follow the same rule, with a correctness constraint: a reference must never reach the disk before what it refers to. The bitmap is flushed before the inode record that points at the new blocks, at the same boundaries. If it weren't, a node dying at the wrong moment could leave blocks referenced by a file but marked free, and the allocator could then give them to a second file.

## Running ahead, and the post-crash leak

To keep files contiguous, a writing node reserves a **run** of blocks ahead of need (`alloc_run_blocks`, 256 blocks = 1 MiB by default) and gives back what it didn't use when the file is closed. While a file keeps being written sequentially, each run doubles, up to `alloc_run_max_blocks` (4096 blocks = 16 MiB), so a streaming write keeps its full speed. If the node crashes, that give-back never happens, and the reserved blocks stay marked as allocated but unreferenced. They have **leaked**.

A leak is the safe direction to fail in: it wastes space. The opposite fault, a block in use but marked free, could end up shared by two files. The **background scrubber** finds and reclaims leaked blocks (every 30 minutes by default). It checks twice, a short gap apart, so it never reclaims a block that is merely in the middle of being allocated.

## Placement

New blocks are placed right after the file's last extent whenever possible, so sequential writes produce long extents. A raw image written with preallocation off typically has only a handful of extents. When a file does fragment (qcow2 under random I/O is the usual case), the [defragmenter](/docs/how-tos/defragment/) can relocate it online.

Inode numbers are spread the same way: each node starts its search for a free inode in its own region of the inode bitmap, so creates on different nodes don't compete for the same bitmap sector.
