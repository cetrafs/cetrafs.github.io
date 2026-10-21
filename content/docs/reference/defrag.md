---
weight: 515
title: "defrag.cetra"
description: "Online per-file defragmentation: synopsis, preconditions, refusals and exit codes."
toc: true
---

## Synopsis

```text
defrag.cetra <file-on-a-cetrafs-mount>
```

Relocates the file into one contiguous run while the filesystem is live. The file may be open and being written. The work is done in steps aligned to whole extents.

## How it stays safe

The tool opens the file **for writing** on purpose. On a default mount, that write-open takes the file's cross-node exclusive lock, so no other node can have the file open while its blocks move.

## Refusals

Each refusal is explained, not just reported as an errno:

| Condition | Result |
|---|---|
| File has interior holes (sparse) | Declined |
| `defrag=off` in the mount's `controls` | Disabled |
| Mount is `nofilelock` | Disabled (the defragmenter depends on the lock) |
| Another node holds the file | Refused (foreign lock) |
| Path isn't on a cetrafs mount | Refused |

## Exit status

| Code | Meaning |
|---|---|
| `0` | Done |
| `1` | Failed |
| `2` | Bad invocation |

## Background defragmentation

The module also defragments in the background. A file is queued when its extent count is at least `auto_defrag_min_extents` **and** at least `auto_defrag_min_pct` percent of the minimum for its size. See [module parameters](/docs/reference/module-parameters/) and the `auto_defrag` key in [controls](/docs/reference/procfs/#controls-writable).
