---
weight: 375
title: "Upgrade to a new format version"
description: "Move a volume to a new cetrafs on-disk format by evacuating, reformatting and restoring. There is no in-place migration."
toc: true
---

cetrafs has **no on-disk backward compatibility** during the beta. A format version change is a clean break: a volume whose format version, or an unknown *incompatible* feature bit, the module doesn't understand is refused at mount. An unknown *read-only-compatible* bit only forces a read-only mount.

Not every release changes the format. Check the release notes. A release that keeps the format only needs the module and tools updated on every node.

## Upgrading a release that keeps the format

1. Install the new `cetrafs-dkms` and `cetrafs-tools` on every node. Install the tools too, not just the module.
2. Node by node: migrate the VMs away, unmount, reload the module (or reboot), mount again.

Before you mix versions in one cluster, check that the release notes say the versions are compatible. The multi-node test suite assumes every node runs the same `cetrafs.ko` build.

## Upgrading across a format change

{{< steps >}}
1. **Evacuate the data.** Move the VM images to other storage (`qm disk move`, `qemu-img convert`, or `cp --sparse=always`), or make sure an array-level backup exists that you have tested restoring.
2. **Unmount on every node.**
3. **Install the new module and tools on every node.** Tools and module must come from the same build.
4. **Reformat with the new tools:** `sudo mkfs.cetra <dev> -f`
5. **Mount on every node** and restore the data.
{{< /steps >}}

`cp --sparse=always`, `tar -S` and `qemu-img convert` all keep thin images thin through `SEEK_HOLE`/`SEEK_DATA`.

## Reclaiming space fsck can't recover

The same procedure applies to a volume carrying an old leak, from before a fix, that `fsck.cetra -r` can't reclaim.
