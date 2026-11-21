---
weight: 515
title: "defrag.cetra"
description: "Online per-file defragmentation: synopsis, how it stays safe, refusals, exit codes and the background defragmenter."
toc: true
---

## Synopsis

```text
defrag.cetra <file-on-a-cetrafs-mount>
```

Moves a regular file's blocks into contiguous runs while the filesystem is live. The file may be open and being written. Holes stay holes, and preallocated ranges stay preallocated: only mapped blocks are moved, each back to its own logical offset.

The work is done in steps of at most 128 blocks (512 KiB), so guest I/O never waits for more than one step. The destination can be several free runs when no single run is large enough. A file that grows while it is being moved cancels the pass, which backs off.

On success it prints the extent count before and after, and how many blocks it moved:

```text
defrag /mnt/cetra/images/100/vm-100-disk-0.raw: extents 2817 -> 6 (8388608 blocks moved)
```

## How it stays safe

The tool opens the file **for writing** on purpose. The defragmenter pins the file's cross-node lock while it moves blocks, so no other node can open the file during a step. On a `nofilelock` mount the same pin applies, for a file no other node has open.

A first open of the file on this node, or a request from another node that wants the file, stops the pass at its next step. The file is left valid at every step.

## Refusals

| Condition | Message |
|---|---|
| Another node has the file open | `held open for write by another node` |
| `defrag=off` in the mount's [`controls`](/docs/reference/procfs/#controls), or more extents than the mover takes | `defragmentation not supported here` |
| The path isn't on a cetrafs mount | `not on a cetrafs mount` |

`defrag_available` in `controls` says whether defragmentation can run on that mount.

## Exit status

| Code | Meaning |
|---|---|
| `0` | Done |
| `1` | Failed |
| `2` | Bad invocation |

## Background defragmentation

The module also defragments in the background. A file is queued when its extent count is at least `auto_defrag_min_extents` **and** at least `auto_defrag_min_pct` percent of the minimum for its size. A file the defragmenter has just declined is left alone for `auto_defrag_quiet_secs`. See [module parameters](/docs/reference/module-parameters/) and the `auto_defrag` key in [`controls`](/docs/reference/procfs/#controls).
