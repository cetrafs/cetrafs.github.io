---
weight: 342
title: "Add cetrafs storage with the Proxmox VE plugin"
linkTitle: "Proxmox storage plugin"
description: "Use the pve-storage-cetrafs plugin to add a shared LUN as a cetrafs storage in Proxmox VE: over a Proxmox iSCSI storage or on any block device, mounted on every node automatically, from pvesm or the web UI."
toc: true
---

The [`pve-storage-cetrafs`]({{< param pluginRepoURL >}}) plugin adds a `cetrafs` storage type to Proxmox VE. Proxmox then mounts the volume on every node by itself, marks it as **shared**, and uses it for VM images, container volumes, ISOs, templates and backups. You don't write `/etc/fstab` entries or run `pvesm add dir`.

The plugin always mounts with `nofilelock`, which [live migration](/docs/how-tos/live-migration/) needs. Proxmox and qemu keep two nodes from running the same guest.

## Before you start

- cetrafs and the plugin are installed on **every** node, and optionally the [web UI package](#the-web-ui): see [Install on Proxmox VE](/docs/how-tos/install-proxmox/).
- Every node sees the same LUN, and it [supports atomic CAW](/docs/how-tos/check-caw/). Without it, only one node can mount the volume.
- If the LUN is multipathed, its queueing time is shorter than the stale window: see [Set the stale window for multipath](/docs/how-tos/multipath-stale-window/).

There are two ways to point the storage at the LUN:

- **`--base`**, a LUN of a Proxmox `iscsi` storage. Proxmox logs every node in to the target before it mounts. Use this for plain iSCSI.
- **`--cetrafs-device`**, a block device path. Use this for Fibre Channel, multipath, or iSCSI you set up yourself.

Set exactly one of them. Neither can be changed later without removing and re-adding the storage.

## Over a Proxmox iSCSI storage

The examples use portal `192.168.1.10`, target `iqn.2026-10.example:san`, iSCSI storage `san-iscsi` and cetrafs storage `san1`. Replace them with your own.

1. **Add the iSCSI storage**, once, from any node. `--content none` keeps Proxmox from offering the raw LUN as a VM disk:

   ```sh
   pvesm scan iscsi 192.168.1.10          # lists the targets the portal offers
   pvesm add iscsi san-iscsi --portal 192.168.1.10 \
       --target iqn.2026-10.example:san --content none
   ```

   If the target only accepts listed initiators, allow every node's initiator name (`/etc/iscsi/initiatorname.iscsi`) on the array first.

2. **Find the LUN's volume ID.** There is one line per LUN:

   ```sh
   pvesm list san-iscsi
   # san-iscsi:0.0.1.scsi-36001405abc...   raw   images   ...
   ```

   The third number is the LUN number and `scsi-3...` is its WWID. Always refer to the LUN by volume ID or WWID, never by `/dev/sdX`, which can change between boots.

3. **Check for atomic CAW and format the LUN**, once, from one node, with the LUN mounted nowhere:

   ```sh
   DEV=/dev/disk/by-id/scsi-36001405abc...
   modprobe cetrafs caw_probe=$DEV && dmesg | tail    # need max_caw_blocks=N, N >= 1
   mkfs.cetra $DEV
   ```

   `mkfs.cetra` erases the LUN.

4. **Add the cetrafs storage**, once, from any node:

   ```sh
   pvesm add cetrafs san1 \
       --base san-iscsi:0.0.1.scsi-36001405abc... \
       --path /mnt/pve/san1 \
       --content images,rootdir,iso,vztmpl,backup \
       --preallocation off
   ```

The storage configuration is cluster-wide, so you run `pvesm add` only once. Every node mounts the volume within about 10 seconds, when `pvestatd` next polls its storages.

A target that exports several LUNs needs one cetrafs storage per LUN, each with its own mount point. One cetrafs storage can't span several LUNs.

## On any block device

For a device that is already present on every node, such as a Fibre Channel LUN or a multipath device, skip the iSCSI storage and give the device path:

```sh
DEV=/dev/mapper/<alias-or-wwid>

# once, from one node
modprobe cetrafs caw_probe=$DEV && dmesg | tail
mkfs.cetra $DEV

# once, from any node
pvesm add cetrafs cetra1 \
    --cetrafs-device $DEV \
    --path /mnt/pve/cetra1 \
    --content images,rootdir
```

The path must be **stable** and **the same on every node**. The plugin refuses `/dev/sdX` and `/dev/dm-N`, whose numbers depend on discovery order. Use one of:

- `/dev/mapper/<name>`: for multipath, the WWID or an alias that is the same on all nodes;
- `/dev/disk/by-id/dm-uuid-...` or `/dev/disk/by-id/dm-name-...`;
- `/dev/disk/by-id/wwn-...` or `/dev/disk/by-id/scsi-...` for a single-path disk.

For multipath, run `multipathd` on every node with the same `multipath.conf`, and check `multipath -ll` on each node before you add the storage. Prefer `--cetrafs-device` over `--base` with multipath: `--base` resolves to the LUN's `scsi-*` link, which is not guaranteed to be the multipath device.

A device only one node can see still works, but restrict the storage to that node with `--nodes <node>`. The storage is always marked shared, so otherwise Proxmox would migrate guests without copying their disks.

## The web UI

The optional `pve-storage-cetrafs-ui` package adds the `cetrafs` storage type to the Proxmox VE web interface: **Datacenter → Storage → Add → CetraFS** for a new storage, and **Edit** for an existing one. Without it everything works the same, but you manage cetrafs storages with `pvesm`, and the web UI lists them with type "Unknown". It needs Proxmox VE 9 (`pve-manager` 9.0 or later) and the plugin package of the same version.

In the Add dialog, **Source** chooses between a LUN of a Proxmox iSCSI storage (`--base`: pick the iSCSI storage, then the LUN) and a block device path (`--cetrafs-device`). The mount point and mount options are optional, as with `pvesm`. Checking for atomic CAW and running `mkfs.cetra` are still done on the command line.

Install it on every node whose web UI you use: each node serves its own UI, so it only changes the UI of the node it is installed on. After installing or upgrading it, reload the browser tab (Ctrl+F5).

Proxmox VE has no interface for UI plugins, so the package adds a `<script>` tag to `/usr/share/pve-manager/index.html.tpl` and reloads `pveproxy`. As a result:

- A `pve-manager` upgrade replaces the template, and the package adds the tag again right after.
- `dpkg --verify pve-manager` reports `index.html.tpl` as modified.
- If a future `pve-manager` changes the template or the storage UI in a way the integration doesn't recognise, the integration turns itself off, with a warning in the install output or the browser console, instead of breaking the UI.

To check the tag, or add it again by hand:

```sh
sh /usr/share/pve-storage-cetrafs-ui/cetrafs-ui-index status && echo present
sh /usr/share/pve-storage-cetrafs-ui/cetrafs-ui-index apply
systemctl reload pveproxy
```

`apt-get remove pve-storage-cetrafs-ui` removes the tag.

## Storage options

| Option | Meaning |
|---|---|
| `--base` | A LUN of a Proxmox `iscsi` storage, as `<storage>:<volume id>`. Fixed once set. |
| `--cetrafs-device` | A stable block device path, the same on every node. Fixed once set. |
| `--path` | The mount point, the same on every node. Defaults to `/mnt/pve/<storage id>` and is created if missing. Fixed once set. |
| `--options` | Extra [mount options](/docs/reference/mount-options/). `nofilelock` is always added. |
| `--nodes` | Restrict the storage to some nodes. |
| `--content` | What Proxmox may store there: `images`, `rootdir`, `iso`, `vztmpl`, `backup`. |
| `--preallocation` | Set it to `off`: see [Configure VM disks for cetrafs](/docs/how-tos/configure-vm-disks/#turn-preallocation-off). |

## Verify

On each node:

```sh
pvesm status --storage san1        # active
findmnt /mnt/pve/san1              # FSTYPE cetrafs
grep file_lock /proc/fs/cetrafs/*/info     # file_lock: off
```

After a reboot, `pvestatd` mounts the storage again by itself, before guests are autostarted. Don't add an `/etc/fstab` entry for it.

## When a node doesn't mount

The node where you ran `pvesm add` mounts at once; the others mount on `pvestatd`'s next poll. If a node stays inactive, look at its log:

```sh
journalctl -u pvestatd --since -10min | grep -i cetra
```

| Message | Cause | Fix |
|---|---|---|
| `unsupported type 'cetrafs'` | The plugin isn't installed on that node. | Install `pve-storage-cetrafs` there. You don't need to re-add the storage. |
| `device '...' not found on node '...'` | The node doesn't see the device: iSCSI logged in on one node only, LUN masking, or multipath not running. | Make the device visible on every node. For `/dev/mapper` paths, `systemctl enable --now multipathd`. |
| `unable to load cetrafs kernel module` | The module isn't built for the running kernel. | Install the kernel headers, then check `dkms status cetrafs`. |
| `mount error ...` | cetrafs refused the mount. | See `dmesg`. A second node is refused if the LUN has no atomic CAW, or if the nodes that already have it mounted run without `nofilelock`. |

## Remove a storage

Stop or move the guests that use it first. Proxmox doesn't unmount a storage when you disable or remove it, so:

```sh
pvesm set san1 --disable 1          # stop Proxmox mounting it again
umount /mnt/pve/san1                # on every node
pvesm remove san1
```

Removing the storage doesn't touch the data on the LUN. Once no cetrafs storage uses an iSCSI target, you can remove the iSCSI storage too, and log out with `iscsiadm -m node -T <target> --logout` on every node.

## Related

- [Configure VM disks for cetrafs](/docs/how-tos/configure-vm-disks/): raw, `cache=none`, `aio=threads`.
- [Shared storage for Proxmox VE without Ceph](/docs/concepts/proxmox-shared-storage/).
- The plugin's [README]({{< param pluginRepoURL >}}#readme) has more detail, including several LUNs on one target.
