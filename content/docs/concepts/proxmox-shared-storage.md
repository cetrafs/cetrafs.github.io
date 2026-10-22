---
weight: 455
title: "Shared storage for Proxmox VE without Ceph"
linkTitle: "Proxmox without Ceph"
description: "The options for shared Proxmox VE storage on an existing iSCSI or Fibre Channel SAN, without Ceph: shared LVM, NFS, ZFS over iSCSI, GFS2/OCFS2 and cetrafs."
toc: true
---

Proxmox VE needs **shared storage** for live migration and HA: every node has to see the same VM disks. The default answer is Ceph, which turns the nodes' local disks into a replicated cluster. That is a good fit when you are building storage from scratch. It is a poor fit when you already own a SAN array, because Ceph doesn't use one: it wants local disks in every node, a fast dedicated network, and in practice at least three nodes.

This page compares the ways to put Proxmox VM disks on an **existing iSCSI or Fibre Channel SAN** instead, and where cetrafs fits among them.

## The options at a glance

| | Shared LVM (thick) | NFS | ZFS over iSCSI | GFS2 / OCFS2 | cetrafs |
|---|---|---|---|---|---|
| Uses an existing block SAN | Yes | No, needs a file server | Only a ZFS-based target Proxmox can manage | Yes | Yes |
| Disks are | Logical volumes | Files | zvols | Files | Files |
| Thin provisioning | No | Yes | Yes | Yes | Yes |
| Coordination | Proxmox locks LVM metadata changes | The NFS server | The target | DLM over the network (corosync) | SCSI COMPARE AND WRITE on the LUN |
| Supported by Proxmox | Yes | Yes | Yes | No, community setups | No, out-of-tree module (beta) |

## Shared LVM on a LUN

This is the setup Proxmox documents for SANs: put one volume group on the shared LUN and add it as LVM storage with `shared` set. Each VM disk is a logical volume, and only the node running the VM activates it.

It is simple, uses only stock components and performs at the speed of the array. The costs are that every disk is **thick**: a 500 GiB disk takes 500 GiB on the LUN from day one. Snapshot support on shared LVM has historically been missing (newer Proxmox releases add it as a technology preview). LVM-thin, which would give thin disks, cannot be shared between nodes.

## NFS

A file server exports a directory and every node mounts it. Disks are plain files, so thin raw and qcow2 images, snapshots and backups all work, and it is the easiest setup to understand.

It only uses a SAN indirectly: something has to sit between the array and the hosts as an NFS server, and that server is now in the data path for every VM. Unless it is itself highly available, it is also a single point of failure.

## ZFS over iSCSI

Proxmox logs in to a ZFS storage server over SSH, creates a zvol per disk and exports it over iSCSI. You get thin disks and snapshots. It needs a target built on ZFS with one of the iSCSI providers Proxmox supports, so it doesn't apply to a typical FC or iSCSI array.

## A cluster filesystem: GFS2 or OCFS2

Format the LUN with a cluster filesystem, mount it on every node, and add the mount point to Proxmox as a shared directory. This gives the file-based model of NFS (thin images, qcow2 snapshots) on the SAN directly, with no server in between.

GFS2 and OCFS2 are general-purpose POSIX cluster filesystems. They coordinate nodes with a distributed lock manager (DLM) that talks over the network and depends on the corosync cluster stack, so a network partition or a corosync problem becomes a storage problem. Proxmox doesn't support either one, so you integrate and upgrade them yourself. See [cetrafs vs GFS2](/docs/concepts/vs-gfs2/) for a closer comparison and measured throughput.

## cetrafs

cetrafs takes the same file-based approach as GFS2 and OCFS2, but it is built only for VM images and coordinates **through the LUN itself**. Every contested claim is one atomic SCSI COMPARE AND WRITE (ATS), the primitive VMFS uses, so there is no DLM and no network protocol in the I/O path. Each node allocates from regions it owns, so writing new data needs no cross-node coordination at all.

In Proxmox, a cetrafs volume is a **shared, file-based storage**. The [storage plugin](/docs/how-tos/proxmox-plugin/) adds a `cetrafs` storage type that Proxmox mounts on every node by itself, over a Proxmox iSCSI storage or on any block device. You get:

- **Thin raw images** on the SAN, without a file server.
- **Live migration**, with the `nofilelock` mount option.
- A per-node journal, so a crashed node's interrupted metadata changes are finished by a survivor before it takes over.

The trade-offs:

- **It is beta software** and out of tree. It runs on specific kernels, including Proxmox VE's `7.0.14-*-pve`. See [Project status](/docs/intro/status/).
- **The LUN must support COMPARE AND WRITE** for more than one node to mount it. Arrays that support VMware VAAI generally do; [check yours](/docs/how-tos/check-caw/) first.
- **You still need fencing.** cetrafs fences itself when its lease is revoked, but it cannot power off a hung host. Proxmox HA has to do that. See [Fencing and split-brain](/docs/concepts/fencing/).
- **Raw is the recommended format.** qcow2 works and gives Proxmox snapshots, but it fragments badly on cetrafs. See [Configure VM disks for cetrafs](/docs/how-tos/configure-vm-disks/).

## Which one to pick

- **No SAN, and three or more nodes with local disks:** Ceph.
- **A NAS or a file server you trust:** NFS.
- **A SAN, and thick disks are acceptable:** shared LVM. It is the supported, conservative choice.
- **A SAN, and you want thin, file-based VM disks without a file server or a DLM:** cetrafs, once you have [validated it on your storage](/docs/how-tos/validate-storage-stack/).

To set it up, [install cetrafs and the plugin](/docs/how-tos/install-proxmox/) on every node, then [add the storage](/docs/how-tos/proxmox-plugin/). To see every step done by hand, follow [Build a Proxmox VE shared datastore](/docs/tutorials/proxmox-datastore/).
