---
weight: 500
title: "Reference"
description: "Exact, complete technical facts: tools, mount options, procfs, module parameters, limits, the on-disk format, and error meanings."
toc: false
---

Reference pages describe what cetrafs *is* and *does*, completely and without opinion. Look things up here while you work. For guidance on *what to do*, see the [how-to guides](/docs/how-tos/); for *why*, see [Concepts](/docs/concepts/).

All four userspace tools share one exit-code convention:

| Exit | `mkfs.cetra` | `fsck.cetra` | `defrag.cetra` | `growfs.cetra` |
|---|---|---|---|---|
| `0` | Success | Clean | Done | Grown (or dry run completed) |
| `1` | Couldn't create | Problems found | Failed | Couldn't grow |
| `2` | Bad invocation | Bad invocation | Bad invocation | Bad invocation |
| `3` | Device inaccessible, or mounted locally or by a live peer | Couldn't examine the device | n/a | Device inaccessible, or mounted locally or by a live peer |
