---
weight: 367
title: "Grow a volume"
description: "Grow a cetrafs volume after its LUN has grown, or into space mkfs.cetra -s left unformatted, with growfs.cetra: upgrade every node, unmount, grow, verify."
toc: true
---

Since 0.9, a cetrafs volume can grow into space its device already has: a LUN you have enlarged on the array, or space that `mkfs.cetra -s` left unformatted. Nothing is copied and nothing existing moves. `growfs.cetra` adds new Block Groups after the existing ones.

{{< callout type="warning" title="Offline, and one way" >}}
- **The volume must be unmounted on every node.** `growfs.cetra` refuses to run while any node has it mounted.
- **A grown volume can't go back.** Modules and tools older than 0.9 refuse it, so upgrade every node first and don't roll the packages back afterwards. There is no shrinking.
{{< /callout >}}

## 1. Upgrade every node to 0.9

Install the 0.9 `cetrafs-dkms` and `cetrafs-tools` on every node, and get the new module loaded: see [Upgrade](/docs/how-tos/upgrade-reformat/#upgrading-a-release-that-keeps-the-format). Volumes from 0.8.x mount unchanged under 0.9, so this needs no reformat.

Then check that every node has registered with a 0.9 module:

```sh
grep -E 'caps=|live_grow_ready' /proc/fs/cetrafs/*/cluster
```

`live_grow_ready: yes` means every registered node can mount a grown volume. A row with `caps=0x0` is a node still running an older module, or one that hasn't mounted the volume since you upgraded it. `growfs.cetra` names those nodes again before it writes anything.

## 2. Make every node see the larger device

Grow the LUN on the array if you haven't. Then, on **every** node, have the kernel reread its size:

```sh
echo 1 > /sys/block/sdX/device/rescan          # each path of the LUN
multipathd resize map <alias-or-wwid>          # if it is multipathed
blockdev --getsize64 /dev/mapper/<alias-or-wwid>
```

For iSCSI, `iscsiadm -m session --rescan` rescans every session. All nodes must report the same new size.

If the space is already there, because you formatted with `mkfs.cetra -s`, skip this step.

## 3. Unmount on every node

Stop or move the guests that use the volume, then unmount it on every node.

With the [Proxmox storage plugin](/docs/how-tos/proxmox-plugin/), disable the storage first, or `pvestatd` mounts it again within seconds:

```sh
pvesm set san1 --disable 1          # once, from any node
umount /mnt/pve/san1                # on every node
```

For a volume mounted through `/etc/fstab`, `umount` it on every node.

## 4. Grow

On one node, preview the plan first:

```sh
growfs.cetra /dev/mapper/<alias-or-wwid> -n
```

Check the target size, the number of Block Groups added and the list of registered nodes. Every node should read `ready`. Then grow:

```sh
growfs.cetra /dev/mapper/<alias-or-wwid>
```

To grow to less than the whole device, add `-s`, for example `-s 2T`. Space smaller than one Block Group (1 GiB by default) at the end of the device is left unused.

## 5. Verify and mount

```sh
fsck.cetra /dev/mapper/<alias-or-wwid>
```

Then mount on every node again, or re-enable the Proxmox storage with `pvesm set san1 --disable 0`. Check the new size with `df -h` or `pvesm status`.

The new Block Groups are shared out among the existing Zone Groups. A node that owns those Zone Groups can allocate from them at once. Space a node doesn't use and that is completely empty is handed back for other nodes to claim. See [Claiming and handing back Block Groups](/docs/concepts/allocation/#claiming-and-handing-back-block-groups).

## If something goes wrong

- **`is mounted on`** or **`is mounted by another node`**: a node still has the volume mounted. The message names the node's registry row and label. Unmount it there. A node that has crashed doesn't block the grow: `growfs.cetra` watches each registered node's heartbeat for a few seconds and refuses only while one is still beating.
- **`the added space is smaller than one Block Group`**: the device didn't grow by enough, or the node running `growfs.cetra` still sees the old size. Repeat step 2.
- **A node refuses to mount after the grow**: it runs a module older than 0.9. Upgrade it.

A crash or power cut during the grow leaves either the volume as it was before, or the grown volume. Run `fsck.cetra`, then `growfs.cetra` again if the volume didn't grow.

## Related

- [`growfs.cetra` reference](/docs/reference/growfs/)
- [`mkfs.cetra -s`](/docs/reference/mkfs/): leave room to grow into
- [Zone Groups and allocation](/docs/concepts/allocation/)
