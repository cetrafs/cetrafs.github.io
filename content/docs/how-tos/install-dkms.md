---
weight: 310
title: "Install with DKMS"
description: "Register the cetrafs module with DKMS directly, without building Debian packages, so it rebuilds on every kernel upgrade."
toc: true
---

Use this when you want DKMS to rebuild the module automatically on non-Debian systems, or without building packages. On Debian and Proxmox VE, [the Debian packages](/docs/how-tos/install-packages/) do the same thing and are easier to manage.

## Prerequisites

- `dkms`, a compiler, and headers for the running kernel.
- The cetrafs source tree. DKMS needs `kmod/`, `include/` and `dkms.conf`: the module builds in `kmod/` and includes the shared format header from `../include`.

## Register, build, install

Use the version from `dkms.conf` (`PACKAGE_VERSION`), currently `{{< version >}}`:

```sh
VER={{< version >}}
sudo cp -r . /usr/src/cetrafs-$VER        # run from the top of the source tree
sudo dkms add     -m cetrafs -v $VER
sudo dkms build   -m cetrafs -v $VER
sudo dkms install -m cetrafs -v $VER
```

Then install the userspace tools:

```sh
make userspace
sudo install -m 0755 userspace/mkfs.cetra userspace/fsck.cetra userspace/defrag.cetra /usr/local/sbin/
```

## Verify

```sh
dkms status cetrafs
sudo mount -t cetrafs <dev> <mnt>     # loads the module automatically through the fs-cetrafs alias
```

## Distribute a source tarball

To install the same module on other machines without copying the source tree:

```sh
sudo dkms mktarball -m cetrafs -v $VER --source-only
# on the target machine:
sudo dkms ldtarball /path/to/cetrafs-$VER-source-only.dkms.tar.gz
sudo dkms install -m cetrafs -v $VER
```

{{< callout type="note" >}}
Keep the userspace tools and the kernel module at the **same build**. An older `fsck.cetra` run against a volume from a newer module can misread the format and report corruption that isn't there.
{{< /callout >}}
