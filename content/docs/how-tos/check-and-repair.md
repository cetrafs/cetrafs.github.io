---
weight: 360
title: "Check and repair a volume"
description: "Run fsck.cetra offline, understand what it will and won't repair, and act on its exit codes."
toc: true
---

## 1. Unmount everywhere

`fsck.cetra` refuses to run on a volume that is mounted locally or that has a live row in the Node Registry. Unmount it on **every** node:

```sh
sudo umount /mnt/cetra          # on every node
```

If a node crashed, its row stays live until the stale window passes (120 s by default). Wait that long before running `fsck`.

## 2. Check (read-only)

```sh
sudo fsck.cetra /dev/sdb
echo $?
```

`fsck` runs four passes and changes nothing:

1. **Structural**: checksums, the superblock's region map, Zone Group and Block Group layout and ownership, Node Registry rows.
2. **Cluster metadata**: per-node journals, pending-free queues.
3. **Content**: extent trees against the bitmaps in both directions, cross-file block overlap, leaks.
4. **Namespace**: directory entries, `.` and `..`, link counts, reachability from the root.

| Exit | Meaning |
|---|---|
| `0` | Clean |
| `1` | Problems found |
| `2` | Bad invocation |
| `3` | Couldn't examine the device (inaccessible, or still mounted somewhere) |

## 3. Repair

```sh
sudo fsck.cetra -r /dev/sdb
```

`-r` repairs **only faults with one correct answer**:

- a bitmap bit that disagrees with the extent trees (a leaked block, or one that could be allocated twice);
- a cached free count on a Block Group or Zone Group that disagrees with its bitmap;
- an inode's link count that disagrees with the directory entries that name it;
- orphaned inodes: those with `nlink=0` are freed, and those with `nlink>0` (a lost directory entry for data that is still wanted) are linked into `/lost+found` as `#<ino>`.

It **refuses**, reporting the fault and changing nothing, when there is no single correct answer:

- **cross-file block overlap**: nothing on disk says which file should keep the block;
- **an unreadable inode record or extent header**: clearing it could hand a live file's blocks to someone else;
- **a dangling directory entry**: removing it destroys a name.

These need a human decision. A wrong guess would turn a contained fault into lost data.

If `-r` reports that it reclaimed blocks, **run it once more**. Some reclamation only shows up on the next pass.

## What's normal after a crash

After an unclean shutdown, expect `-r` to find and fix a little residue: an orphan inode, or a counter that has drifted. cetrafs's crash guarantee is **per `fsync`, not per syscall**. Data an application had flushed is never lost, but an operation that hadn't been acknowledged when the node crashed can leave a small, repairable remnant. That isn't corruption. See [Journaling and crash consistency](/docs/concepts/journaling/).

A few **leaked blocks** are also expected after a node crash. See [Recover from a node failure](/docs/how-tos/recover-node-failure/#expect-a-small-leak-and-let-it-go-away).

## Keep the tools in step with the module

Run an `fsck.cetra` from the **same build** as the kernel module that wrote the volume. A mismatched `fsck` can misread the format and report corruption that isn't there.
