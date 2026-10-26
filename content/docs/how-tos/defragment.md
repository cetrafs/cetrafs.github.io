---
weight: 365
title: "Defragment a file"
description: "Relocate a fragmented file into one contiguous run while the filesystem is live, by hand with defrag.cetra or automatically in the background."
toc: true
---

## Check fragmentation

```sh
sudo filefrag /mnt/cetra/images/100/vm-100-disk-0.raw
```

A raw image written sequentially has a handful of extents. Thousands of extents (common with qcow2) slow down every block lookup.

## Defragment one file by hand

```sh
sudo defrag.cetra /mnt/cetra/images/100/vm-100-disk-0.raw
echo $?       # 0 done, 1 failed, 2 usage
```

The file can be open and in use while this runs. `defrag.cetra` opens the file for writing on purpose: on a default mount, that write-open takes the cross-node exclusive lock, which is what makes moving the blocks safe.

`defrag.cetra` explains when it won't run:

| Refusal | Why |
|---|---|
| Sparse file | Files with interior holes are skipped. |
| Disabled | The mount has `defrag=off` in `controls`, or is mounted `nofilelock` (where the defragmenter is always off, because its safety depends on the lock). |
| Foreign lock | Another node has the file open. |
| `Device or resource busy` | This node has [suspended the file's lock](/docs/concepts/locking/#handing-one-files-lock-over-on-a-default-mount) for a handoff, so the lock isn't there to protect the move. |
| Not a cetrafs mount | The path isn't on cetrafs. |

## Let it run in the background

The background defragmenter queues a file when it is fragmented enough:

- its extent count is at least `auto_defrag_min_extents` (default 4), **and**
- its extent count is at least `auto_defrag_min_pct` percent (default 200%) of the minimum number of extents a file of that size could have.

```sh
echo auto_defrag=on  | sudo tee /proc/fs/cetrafs/<dev>/controls
echo auto_defrag=off | sudo tee /proc/fs/cetrafs/<dev>/controls
```

## On `nofilelock` clusters

The defragmenter is **unavailable** under `nofilelock`. Prevent fragmentation instead: use raw images with preallocation off, and if you need qcow2, give it 1 MiB clusters. See [Configure VM disks](/docs/how-tos/configure-vm-disks/).
