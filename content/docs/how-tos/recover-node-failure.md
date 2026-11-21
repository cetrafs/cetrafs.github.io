---
weight: 370
title: "Recover from a node failure"
description: "What happens automatically when a node dies, how to hand its files over sooner, how to bring it back, recover a stopped mount, a damaged superblock or a journal that won't settle, and what the small post-crash leak means."
toc: true
---

## A node crashed, or was fenced by the cluster manager

**On the surviving nodes, you don't need to do anything.** Once the dead node's registry row has been silent for the stale window (120 s by default), the survivors take over what it held as they need it: its Zone Groups, its file locks and its namespace locks. Before taking anything over, a survivor **replays the dead node's journal**, so any metadata write that was interrupted is finished first.

Watch it from a survivor:

```sh
sudo watch -n 5 cat /proc/fs/cetrafs/<dev>/cluster
```

The dead node's row stops advancing `hb_seq`, then shows `stale=yes`. Until then, its files are held: on a default mount an open of one fails with `ETXTBSY`, under `nofilelock` with `EAGAIN`. A create, rename or delete in a directory the dead node was changing waits until the row goes stale.

No `fsck` is needed afterwards. The survivors' replay and the dead node's next mount repair what the crash left.

## Declare a fenced host dead

An HA stack that restarts VMs sooner than the stale window, as Proxmox HA does once it has fenced a node, sees those opens fail, and with `max_restart` at its default of 1 may give up on the VM. Once the host is **known to be off**, powered down through IPMI, a PDU or a confirmed watchdog, tell cetrafs so:

```sh
sudo cat /proc/fs/cetrafs/<dev>/cluster              # find the row: label=<host> ... incarnation=<n>
echo dead=<row>:<n> | sudo tee /proc/fs/cetrafs/<dev>/controls
```

The row is fenced as a reclaim would fence it and recorded as `departure=dead`, so every node treats it as stale at once, and the next open of each VM replays the dead host's journal and goes ahead. Run it on any surviving node; it needs `CAP_SYS_ADMIN`.

It is careful, by design:

- It takes up to three of that host's heartbeats plus 5 s, about 50 s with the defaults: the row has to be seen standing still that long. A row that beats meanwhile is refused with `EBUSY` and left alone, so a wrong row, or a declaration made before the power-off took effect, is caught rather than handing a live host's VMs to a second writer.
- It is bound to the incarnation read from `cluster`. A host that has booted and mounted again since carries a new one, and the write is refused with `ESTALE`.
- This node's own row is refused with `EINVAL`.

**Only declare a host dead after it is off.** Like every fence here it is advisory: a host still running keeps writing what it has already queued. The declaration is the agent's word that it can't.

## Bring the node back

When the host is back up, mount the volume again (from `fstab`, or by hand):

```sh
sudo mount -t cetrafs <dev> /mnt/cetra
```

It finds its own row in the Node Registry by its stable machine UUID, re-attaches, replays its own journal if anything is left in it, recounts what its stopped operations left behind, and rejoins. After an unclean shutdown the mount first watches that row for the stale window, to be sure no other machine with the same UUID is using it, and may wait for a peer replaying its journal: it can take minutes. Give `fstab` mounts a [longer systemd timeout](/docs/how-tos/mount-volume/#mount-at-boot-with-etcfstab). See [the Node Registry](/docs/concepts/coordination/#the-node-registry).

## A mount where everything fails with `EIO`

The mount has **stopped**: every access fails with `EIO`, reads included. `info` says why:

```sh
sudo grep -E 'fenced|stopped' /proc/fs/cetrafs/<dev>/info    # fenced: yes, stopped: <cause>
sudo cat /proc/fs/cetrafs/<dev>/cluster                      # who took over
```

- `fenced` or `lease`: another node decided this one was dead and took over, or this node couldn't renew its heartbeat in time and stopped itself. `dmesg` names the node that fenced it.
- `error`: the device refused a metadata write, or a compare-and-write couldn't be decided. Look at the storage first: `multipath -ll`, the array, SCSI errors in `dmesg`. With multipath, all paths gone and queueing exhausted ends here too.
- `corruption`: damaged metadata, on a mount with `corruption=stop`.
- `manual`: someone asked for it.
- `device_gone`: the device went away, or the LUN shrank below the volume.

It is one-way, and the same state a crash leaves: nothing is written from the stop on, the heartbeat stops, and after the stale window the peers replay this node's journal and take over its files. To bring the node back:

```sh
sudo umount /mnt/cetra                  # writes nothing on a stopped mount
sudo fsck.cetra --live <dev>            # for `corruption`, or if in doubt; the peers keep running
sudo mount -t cetrafs <dev> /mnt/cetra
```

A healthy node stopping itself means it went silent for longer than it was allowed while it was still alive. Common causes are an all-paths-down multipath event, a host that froze, or a saturated array. Find out which, and check [the multipath stale window](/docs/how-tos/multipath-stale-window/).

## A file that returns "Structure needs cleaning" (`EUCLEAN`)

Damaged metadata found in a file or directory makes every write to it fail with `EUCLEAN`, so nothing is freed or rewritten from a damaged extent tree. Reading the undamaged parts still works, and the rest of the mount carries on. `corruptions` in `info` is above 0, `fsck_needed` shows when and where it was found, and `dmesg` names the inode.

1. Copy out what can be read.
2. Run `fsck.cetra --live <dev>` to see the extent of it without stopping anything.
3. At the next window, unmount on every node and run `fsck.cetra -r <dev>`. See [Check and repair](/docs/how-tos/check-and-repair/).

## The mount says block 0 doesn't verify

Something wrote over the first block of the volume: a partition tool, a disk label, a `dd` aimed at the wrong disk. The data is untouched, and `mkfs.cetra` kept a copy of block 0 at block 2048, 8 MiB in. `dmesg` says whether that copy verifies. If it does:

```sh
sudo fsck.cetra -r <dev>        # with the volume unmounted on every node
```

`fsck.cetra` checks the volume through the copy, then restores block 0 from it. Then mount as usual.

The opposite case, `sb_copy: bad` or `stale` in `info` and a warning at mount, means the copy is the damaged one. The volume mounts and works. Run `fsck.cetra -r` at the next window with every node unmounted, to write the copy again.

## A dead node's journal that won't settle

A dead node's journal entries are redone by the first node that needs them. An entry is kept, and the area stays dirty, while a live node has its file open for writing, or when replay can't decide it, for example because the record it belongs to can't be read. While that lasts, that file can't be opened elsewhere.

For a host that will never mount again, decommissioned or reinstalled under a new identity, retire its journal:

```sh
sudo cat /proc/fs/cetrafs/<dev>/cluster              # the row and its incarnation
echo retire_journal=<row>:<n> | sudo tee /proc/fs/cetrafs/<dev>/controls
```

Everything that can be redone is redone first. Each entry left is named in the kernel log (`retiring node <row>'s entry …`) and given up, and the area is parked clean. The blocks those entries named keep what they hold now. It needs `CAP_SYS_ADMIN`, the row's current incarnation, and the row stale: a live row is refused with `EBUSY`, one that came back with `ESTALE`.

The background scrubber doesn't wait for such an area: it only leaves alone the blocks its entries name.

## Expect a small leak, and let it go away

An `fsck` run after a node has died can report something like:

```text
WARN: N data block(s) marked in use but referenced by no inode (leaked)
```

These are blocks the dying node had reserved ahead of need: it allocates a run of blocks in advance (`alloc_run_blocks`, default 256 blocks = 1 MiB) and hands the unused part back on close, which a crash never reaches. That is the **safe direction**: it wastes a little space. The dangerous direction, a block referenced by a file but marked free, doesn't happen.

**You don't need to do anything about it.** The background scrubber reclaims these blocks within one cycle (`scrub_interval_secs`, default 30 minutes) once some node owns that Zone Group, and `scrub_reclaimed` in `info` counts them as they go. If the leak keeps growing across crashes and never shrinks, check that `scrub` is on and that `scrub_cycles` advances.

## A volume that won't mount because a peer "owns" it

This happens on a device **without atomic CAW**, which can only have one node mounted at a time. If the node that had it mounted is really gone but its row isn't stale yet, wait for the stale window to pass and mount again. Don't try to force it: `mkfs -f` won't override a live peer either, by design.
