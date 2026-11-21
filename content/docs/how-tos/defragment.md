---
weight: 365
title: "Defragment a file"
description: "Move a fragmented file into contiguous runs while the filesystem is live, by hand with defrag.cetra or automatically in the background."
toc: true
---

## Check fragmentation

```sh
sudo filefrag /mnt/cetra/images/100/vm-100-disk-0.raw
```

A raw image written sequentially has a handful of extents. Thousands of extents, common with qcow2, slow down lookups and fill the file's extent tree.

## Defragment one file by hand

```sh
sudo defrag.cetra /mnt/cetra/images/100/vm-100-disk-0.raw
echo $?       # 0 done, 1 failed, 2 usage
```

The file can be open and in use while this runs, and it can be sparse or preallocated: holes stay holes, and preallocated ranges stay preallocated. Blocks move in steps of at most 512 KiB, so a running VM never waits long for one.

`defrag.cetra` explains when it won't run:

| Refusal | Why |
|---|---|
| `held open for write by another node` | Another node has the file open. The move needs the file to itself, cluster-wide. |
| `defragmentation not supported here` | The mount has `defrag=off` in `controls`. |
| `not on a cetrafs mount` | The path isn't on cetrafs. |

A first open of the file on this node, or another node asking for it, stops the pass at its next step, and the file is valid at every step. Run it again later.

## On `nofilelock` clusters

The defragmenter works on `nofilelock` mounts too, for a file no other node has open: on Proxmox, the images of VMs running on this node. During a live migration, when both nodes have the image open, it stays away.

## Let it run in the background

The background defragmenter queues a file when it is fragmented enough:

- its extent count is at least `auto_defrag_min_extents` (default 4), **and**
- its extent count is at least `auto_defrag_min_pct` percent (default 200%) of the minimum number of extents a file of that size could have.

```sh
echo auto_defrag=on  | sudo tee /proc/fs/cetrafs/<dev>/controls
echo auto_defrag=off | sudo tee /proc/fs/cetrafs/<dev>/controls
```

## Prevent fragmentation

Defragmenting fixes the layout after the fact. Raw images with preallocation off stay compact from the start, and if you need qcow2, give it 1 MiB clusters. See [Configure VM disks](/docs/how-tos/configure-vm-disks/).
