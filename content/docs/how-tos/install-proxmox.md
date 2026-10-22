---
weight: 306
title: "Install cetrafs on Proxmox VE"
linkTitle: "Install on Proxmox VE"
description: "Quick install of the cetrafs packages and the pve-storage-cetrafs storage plugin from their GitHub releases, on every node of a Proxmox VE cluster."
toc: true
---

A Proxmox VE node needs three packages, all published as GitHub releases:

| Package | From | Contents |
|---|---|---|
| `cetrafs-dkms` | [cetrafs releases](https://github.com/cetrafs/cetrafs/releases) | The kernel module, built by DKMS for each kernel. |
| `cetrafs-tools` | [cetrafs releases](https://github.com/cetrafs/cetrafs/releases) | `mkfs.cetra`, `fsck.cetra` and `defrag.cetra`. |
| `pve-storage-cetrafs` | [cetrafs-proxmox releases]({{< param pluginRepoURL >}}/releases) | The Proxmox VE storage plugin: adds a `cetrafs` storage type. |

The [storage plugin](/docs/how-tos/proxmox-plugin/) is optional but recommended. Without it, you mount the volume yourself and register it as directory storage, as in the [Proxmox datastore tutorial](/docs/tutorials/proxmox-datastore/).

## Install on every node

Run this on **every** node of the cluster, as root:

```sh
# kernel headers, so DKMS can build the module
apt install proxmox-default-headers

# cetrafs
VER={{< version >}}
URL=https://github.com/cetrafs/cetrafs/releases/download/$VER
wget $URL/cetrafs-dkms_${VER}_all.deb $URL/cetrafs-tools_${VER}_amd64.deb
apt install ./cetrafs-dkms_${VER}_all.deb ./cetrafs-tools_${VER}_amd64.deb

# the storage plugin
PVER={{< param pluginVersion >}}
wget {{< param pluginRepoURL >}}/releases/download/$PVER/pve-storage-cetrafs_${PVER}_all.deb
apt install ./pve-storage-cetrafs_${PVER}_all.deb
```

`proxmox-default-headers` follows the default Proxmox kernel series, so the headers for each new kernel arrive with the kernel and DKMS rebuilds the module automatically. If the node runs a kernel other than the default one, install its headers too: `apt install proxmox-headers-$(uname -r)`.

Installing the plugin restarts the Proxmox API services (`pvedaemon`, `pveproxy`, `pvestatd`, `pvescheduler`) so they load it. Running guests are not affected.

Install on **all** nodes before you add a `cetrafs` storage: the storage configuration is shared by the whole cluster, and a node without the plugin can't use, or even parse, a `cetrafs` entry.

## Verify

On each node:

```sh
dkms status cetrafs                   # cetrafs/<version>, <kernel>, amd64: installed
which mkfs.cetra fsck.cetra defrag.cetra
dpkg -l pve-storage-cetrafs           # ii  pve-storage-cetrafs ...
```

## Upgrade

Download the new releases and install them the same way, on every node. Keep `cetrafs-dkms` and `cetrafs-tools` at the same version on all nodes. Read the cetrafs release notes first: if the on-disk format version changed, you have to [move the data and reformat](/docs/how-tos/upgrade-reformat/).

A new `cetrafs-dkms` builds the new module, but a mounted volume keeps running the old one until it is unmounted and the module is reloaded. The simplest way is to migrate the guests away and reboot the node, one node at a time.

## Next

- [Check that the LUN supports atomic CAW](/docs/how-tos/check-caw/).
- [Add cetrafs storage with the Proxmox plugin](/docs/how-tos/proxmox-plugin/).
- [Configure VM disks for cetrafs](/docs/how-tos/configure-vm-disks/).
