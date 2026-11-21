---
weight: 360
title: "Check and repair a volume"
description: "Check a cetrafs volume while it is in use with fsck.cetra --live, repair it offline with -r, understand what it will and won't repair, and act on its exit codes."
toc: true
---

## When to check

- **`fsck_needed` in `info` isn't `no`, or `corruptions` is above 0.** A node found damaged metadata.
- **`bmap_crc_bad` is above 0.** A bitmap sector is damaged.
- **`sb_copy` reads `stale` or `bad`, or a mount says block 0 doesn't verify.**
- **Before and after maintenance**, such as an offline grow, if you want the confirmation.

An unclean shutdown is **not** a reason on its own: mounting again repairs what it left. See [Journaling and crash consistency](/docs/concepts/journaling/#per-fsync-not-per-syscall).

## 1. Check while the volume is in use

```sh
sudo fsck.cetra --live /dev/sdb
echo $?
```

`--live` reads the volume while other nodes keep working on it, claims nothing and writes nothing. Run it on any node that sees the LUN. Because the volume changes under it, it walks up to three times and only reports a problem that every walk sees the same way:

| Exit | Meaning |
|---|---|
| `0` | Clean |
| `1` | Problems that repeat on every walk: real damage. Plan an offline repair. |
| `3` | The volume changed too fast to reach a verdict. Run it again when it is quieter. |

## 2. Unmount everywhere

A repair needs the volume offline. Unmount it on **every** node:

```sh
sudo umount /mnt/cetra          # on every node
```

With the [Proxmox storage plugin](/docs/how-tos/proxmox-plugin/), disable the storage first (`pvesm set <storage> --disable 1`), or `pvestatd` mounts it again within seconds.

`fsck.cetra` refuses to run while the volume is mounted on this machine, or while a node is still heartbeating in its Node Registry. A node that crashed doesn't block it: its row stops moving, which `fsck.cetra` watches for, for up to the longest stale window any node uses (at most 240 s).

## 3. Repair

```sh
sudo fsck.cetra -r /dev/sdb
```

`fsck` runs four passes (structural, cluster metadata, content, namespace), then `-r` repairs **only faults with one correct answer**:

- a bitmap bit, or a whole bitmap sector, that disagrees with the extent trees;
- a cached free count that disagrees with its bitmap;
- an inode's link count, or a directory's size, that disagrees with the entries;
- a damaged Zone Group record, Block Group descriptor or Node Registry row, rebuilt from the rest of the volume;
- block 0, restored from its copy at block 2048, or the copy, rewritten;
- orphaned inodes: those with `nlink=0` are freed, and those with `nlink>0` are linked into `/lost+found` as `#<ino>`.

It **refuses**, reporting the fault and changing nothing, when there is no single correct answer:

- **cross-file block overlap**: nothing on disk says which file should keep the block;
- **an unreadable inode record or extent header**: clearing it could hand a live file's blocks to someone else;
- **a dangling directory entry**: removing it destroys a name.

These need a human decision. A wrong guess would turn a contained fault into lost data. Keep an image of the volume and [report it](https://github.com/cetrafs/cetrafs/issues).

If `-r` reports that it reclaimed blocks, **run it once more**. Some reclamation only shows up on the next pass. A clean pass clears the `fsck_needed` mark.

If `-r` says a journal hasn't been replayed, mount the volume once, unmount it, and run `-r` again: the mount completes those writes first.

## Exit codes

| Exit | Meaning |
|---|---|
| `0` | Clean |
| `1` | Problems found |
| `2` | Bad invocation |
| `3` | Couldn't examine the device: inaccessible, still mounted somewhere, or a repair already running |

## Keep the tools in step with the module

Run an `fsck.cetra` from the **same release** as the kernel module. A tool of another format version refuses the volume.

See the [`fsck.cetra` reference](/docs/reference/fsck/) for every check and repair.
