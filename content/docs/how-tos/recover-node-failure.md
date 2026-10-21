---
weight: 370
title: "Recover from a node failure"
description: "What happens automatically when a node dies, how to bring it back, how to recover a fenced mount, and what the small post-crash leak means."
toc: true
---

## A node crashed, or was fenced by the cluster manager

**On the surviving nodes, you don't need to do anything.** Once the dead node's registry row has been silent for the stale window (120 s by default), the survivors reclaim what it held as they need it: its Zone Groups, its file locks and its namespace locks. Before taking anything over, a survivor **replays the dead node's journal**, so any metadata write that was interrupted is finished first.

Watch it from a survivor:

```sh
watch -n 5 cat /proc/fs/cetrafs/<dev>/cluster
```

The dead node's row stops advancing `hb_seq`, then shows `stale=yes`. Until the stale window has passed, files the dead node had locked return `Text file busy` on other nodes. That is expected.

With Proxmox HA, the VMs that ran on the dead node are restarted on survivors once HA has fenced it. Their images become openable as soon as the dead node's locks are reclaimable.

## Bring the node back

When the host is back up, mount the volume again (from `fstab`, or by hand):

```sh
sudo mount -t cetrafs <dev> /mnt/cetra
```

It finds its own row in the Node Registry by its stable machine UUID, re-attaches, replays its own journal if anything is left in it, and rejoins.

## A mount where every write fails with `EIO`

The mount has **fenced itself**. Another node decided this one was dead, reclaimed its resources and revoked its lease, and this node noticed on its next heartbeat. Fencing is one-way: every write fails with `EIO` until the volume is unmounted and mounted again.

Confirm it:

```sh
grep fenced /proc/fs/cetrafs/<dev>/info         # fenced: yes
cat /proc/fs/cetrafs/<dev>/cluster              # a peer took over
```

Recover:

```sh
sudo umount /mnt/cetra
sudo mount -t cetrafs <dev> /mnt/cetra
```

A healthy node fencing itself means it went silent for longer than the stale window while it was still alive. Common causes are an all-paths-down multipath event, a host that froze, or a saturated array. Find out which, because during that window the node and its peers both believed they owned the same resources. Check [the multipath stale window](/docs/how-tos/multipath-stale-window/) and read [Fencing and split-brain](/docs/concepts/fencing/).

## Expect a small leak, and let it go away

An `fsck` run after a node has died usually reports something like:

```text
WARN: N data block(s) marked in use but referenced by no inode (leaked)
```

These are blocks the dying node had reserved ahead of need: it allocates a run of blocks in advance (`alloc_run_blocks`, default 256 blocks = 1 MiB) and hands the unused part back on close, which a crash never reaches. The blocks are marked allocated but referenced by nothing. That is the **safe direction**: it wastes a little space. The dangerous direction, a block referenced by a file but marked free, could end up shared by two files.

**You don't need to do anything about it.** The background scrubber reclaims these blocks within one cycle (`scrub_interval_secs`, default 30 minutes) once some node owns that Zone Group. `scrub_reclaimed` in `info` counts them as they go.

Use `fsck.cetra -r` only if you want the space back at once, or if the leak keeps growing across crashes and never shrinks. That would mean the scrubber isn't running: check that `scrub` is on and that `scrub_cycles` advances.

## Optional: clean up offline

To clear the dead node's leftovers at once instead of waiting:

1. Unmount the volume on every node.
2. Run `sudo fsck.cetra -r <dev>`, and run it a second time if it reports reclaimed blocks.
3. Mount again.

## A volume that won't mount because a peer "owns" it

This happens on a device **without atomic CAW**, which can only have one node mounted at a time. If the node that had it mounted is really gone but its row isn't stale yet, wait for the stale window to pass and mount again. Don't try to force it: `mkfs -f` won't override a live peer either, by design.
