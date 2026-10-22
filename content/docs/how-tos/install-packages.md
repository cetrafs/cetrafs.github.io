---
weight: 305
title: "Install from Debian packages"
description: "Install the cetrafs-dkms and cetrafs-tools packages from a GitHub release, or build them yourself, so the module survives kernel upgrades and loads on first mount."
toc: true
---

This is the recommended way to install cetrafs on Debian and Proxmox VE. There are two packages:

| Package | Contents |
|---|---|
| `cetrafs-dkms` | The kernel module source plus DKMS wiring, so `cetrafs.ko` is rebuilt automatically on every kernel upgrade. |
| `cetrafs-tools` | `mkfs.cetra`, `fsck.cetra` and `defrag.cetra`, installed in `/usr/sbin`. |

Every release of cetrafs publishes both packages on the [GitHub releases page](https://github.com/cetrafs/cetrafs/releases). On Proxmox VE, [Install on Proxmox VE](/docs/how-tos/install-proxmox/) covers the same steps plus the storage plugin.

## Install a released version

On **every** node:

```sh
VER={{< version >}}
URL=https://github.com/cetrafs/cetrafs/releases/download/$VER
wget $URL/cetrafs-dkms_${VER}_all.deb $URL/cetrafs-tools_${VER}_amd64.deb

sudo apt install linux-headers-$(uname -r)       # DKMS needs the headers
sudo apt install ./cetrafs-dkms_${VER}_all.deb ./cetrafs-tools_${VER}_amd64.deb
```

DKMS builds the module for the running kernel during installation.

The packages are built on Debian 13. `cetrafs-dkms` is architecture-independent, because it ships source, but `cetrafs-tools` is published for **amd64** only. On arm64, [build the packages yourself](#build-the-packages-yourself).

{{< callout type="note" title="A release build is not a test run" >}}
The release packages are built by CI, which doesn't run the test suites. Those need a loadable module and real hardware, and run before a release is tagged. Validate cetrafs on your own storage before you trust it with data: see [Validate a storage stack before deployment](/docs/how-tos/validate-storage-stack/).
{{< /callout >}}

## Verify

```sh
dkms status cetrafs                  # cetrafs/<version>, <kernel>, <arch>: installed
modinfo cetrafs | head -3
which mkfs.cetra fsck.cetra defrag.cetra
```

You don't need to load the module by hand or add it to `/etc/modules-load.d`. The module declares the `fs-cetrafs` alias, so the first `mount -t cetrafs` loads it, just as with an in-tree filesystem. That includes mounts from `/etc/fstab` at boot and mounts made by a cluster manager.

## Upgrade

Download the new release and install it the same way, on every node. Before you upgrade, read the release notes: if the on-disk format version changed, the new module can't mount the old volume, and you have to [move the data and reformat](/docs/how-tos/upgrade-reformat/).

Keep `cetrafs-dkms` and `cetrafs-tools` at the same version. An older `fsck.cetra` run against a volume from a newer module can misread the format and report corruption that isn't there.

## After a kernel upgrade

Install the headers for the new kernel at the same time as the kernel itself (on Proxmox, the `proxmox-headers-*` package that matches the kernel). DKMS then rebuilds `cetrafs.ko` automatically. Check with `dkms status cetrafs` before you reboot into the new kernel.

## Build the packages yourself

To package an unreleased commit, or for an architecture without released packages. On a build host (it can be one of the cluster nodes):

```sh
sudo apt install debhelper dh-dkms build-essential     # build dependencies, once
git clone https://github.com/cetrafs/cetrafs.git
cd cetrafs
make deb
ls dist/
```

`make deb` writes the packages to `dist/`. It checks that the version in `debian/changelog`, `dkms.conf` and `debian/rules` all match before it builds, and it refuses to build if they disagree, because a mismatch produces a package whose module never builds.

To remove `dist/` and the staging directories:

```sh
make deb-clean
```

{{< callout type="warning" title="A built package is not a tested one" >}}
Package builds skip the test suite, because it needs root, loads the module and takes minutes. Run `make check` yourself before you deploy a build. See [Run the test suites](/docs/how-tos/run-tests/).
{{< /callout >}}

Copy both `.deb` files to each node and install them with `apt install ./<file>.deb`, as above.

## Related

- [Install on Proxmox VE](/docs/how-tos/install-proxmox/), with the storage plugin.
- [Install with DKMS](/docs/how-tos/install-dkms/) without packaging.
- [Build and install from source](/docs/how-tos/build-from-source/).
